// Улучшение картинки нейросетью на телефоне: шейдеры Anime4K (bloc97, MIT; public/models/upscale/*.glsl, лицензия —
// ANIME4K-LICENSE) так, как их запускают мобильные плееры (mpv-android): фрагментными шейдерами WebGL2, проход за
// проходом в текстуры RGBA16F. Наш WebGPU-движок (upscale/) на мобильной видеокарте упирался не в умножения, а в
// compute-проходы с буферами: Anime4K там шёл 37 мс на 480p, здесь — 11.
// Здесь — исполнитель mpv-хуков, как в самом mpv: проходы //!DESC … //!BIND … //!SAVE … //!WIDTH … (размер — выражение
// в обратной польской записи), шейдеру — NAME_tex / NAME_texOff / NAME_pos / NAME_size / NAME_pt привязанных текстур.
// Так выполняется любой шейдер Anime4K и цепочки (Restore -> Upscale) без своего кода под каждый. Поверх результата —
// лёгкая резкость AMD CAS: Anime4K восстанавливает линии, а резкость глаз замечает сразу. Холст — над видео с тем же
// object-fit (как sharpen.js); кадры — по requestVideoFrameCallback. Нет WebGL2 / рендера в RGBA16F — выключается
const DIR = '/models/upscale/';
// цепочки от лучшей к лёгкой (Restore — сначала убирает размытие и следы сжатия, потом увеличение, как режим A у
// Anime4K; по снимкам настоящих серий — чище всех). Замеры Snapdragon 8+ Gen 1 (fp16, пачкой кадров), 480p / 720p:
// rm — 10 / 13, с дебандингом — 10 / 18 мс (кадр 24 к/с — 41 мс, с запасом — 37)
export const CHAINS = {
  rm: ['Anime4K_Restore_CNN_M.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl'],
  rs: ['Anime4K_Restore_CNN_S.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl'],
  m: ['Anime4K_Upscale_CNN_x2_M.glsl'],
  // 1080p: кадр и так размером с экран — без увеличения, только Restore S (убирает размытие и следы сжатия)
  r: ['Anime4K_Restore_CNN_S.glsl'],
};
// что пробовать на источнике какого класса, от лучшего к лёгкому
export const CHAIN_FOR = { 480: ['rm', 'rs', 'm'], 720: ['rm', 'rs', 'm'], 1080: ['r'] };

// шейдер цепочки — имя файла в DIR или { name, text } (стенд сравнения подаёт свои)
const nameOf = (f) => (typeof f === 'object' ? f.name : f);
const texts = new Map();
const loadText = (f) => {
  if (typeof f === 'object') return Promise.resolve(f.text);
  if (!texts.has(f)) texts.set(f, fetch(DIR + f).then((r) => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.text(); }));
  return texts.get(f);
};

// Стадии mpv: проходы на PREKERNEL / OUTPUT идут после всех проходов на MAIN (Clamp_Highlights считает яркость до
// увеличения, а ограничивает после), и у нас все они пишут в MAIN. HOOKED — текстура, на которую повешен проход
const STAGE = { PREKERNEL: 1, OUTPUT: 2, SCALED: 2 };
const regKey = (b) => (b === 'HOOKED' || b in STAGE ? 'MAIN' : b);

// проход — подряд идущие строки //!… (заголовок) и код до следующего заголовка: у Anime4K //!DESC — первой строкой,
// у других шейдеров (adaptive-sharpen) — после //!HOOK
function parsePasses(text) {
  const blocks = []; let head = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('//!')) { if (!head) blocks.push({ dirs: [], body: [] }); head = true; blocks.at(-1).dirs.push(line.slice(3).trim()); }
    else { head = false; if (blocks.length) blocks.at(-1).body.push(line); }
  }
  return blocks.map(({ dirs, body }) => {
    const dir = (k) => dirs.filter((d) => d.startsWith(`${k} `)).map((d) => d.slice(k.length + 1).trim());
    const hook = dir('HOOK')[0] || 'MAIN';
    const binds = dir('BIND');
    // mpv привязывает текстуру хука и под её собственным именем (MAIN_tex рядом с HOOKED_tex)
    if (binds.includes('HOOKED') && !binds.includes(hook)) binds.push(hook);
    return {
      desc: dir('DESC')[0] || '', stage: STAGE[hook] || 0,
      binds, save: dir('SAVE')[0] || 'MAIN', width: dir('WIDTH')[0], height: dir('HEIGHT')[0], body: body.join('\n'),
    };
  });
}

// размер прохода: «conv2d_last_tf.w 2 *» по текущим текстурам
function rpn(expr, reg, fallback) {
  if (!expr) return fallback;
  const st = [];
  for (const t of expr.split(/\s+/)) {
    if (/^[\d.]+$/.test(t)) st.push(Number(t));
    else if (/^[+\-*/]$/.test(t)) { const b = st.pop(); const a = st.pop(); st.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : a / b); }
    else { const [n, k] = t.split('.'); st.push(reg[regKey(n)][k === 'w' ? 'w' : 'h']); }
  }
  return Math.round(st.pop());
}

const VS = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

// Скорость на телефоне: свёртки — в половинной точности (mediump: Adreno считает fp16 вдвое быстрее, текстуры и так
// RGBA16F), координаты — в полной (highp: в fp16 на кадре 1280 точек не хватает точности на полточки); соседи текстуры
// того же размера, что проход (свёртки 3x3), — texelFetch по целым координатам, без деления и фильтрации.
// same[i] — привязанная текстура размером с проход
function passShader(pass, same = [], full = false) {
  const H = ['#version 300 es', `precision ${full ? 'highp' : 'mediump'} float;`, `precision ${full ? 'highp' : 'mediump'} sampler2D;`, 'out vec4 fragColor;', 'uniform highp vec2 OUT;',
    'highp vec2 POS() { return gl_FragCoord.xy / OUT; }'];
  pass.binds.forEach((b, i) => {
    H.push(`uniform sampler2D T${i}; uniform highp vec2 S${i};`);
    const off = same[i]
      ? `texelFetch(T${i}, clamp(ivec2(gl_FragCoord.xy) + ivec2(o), ivec2(0), ivec2(S${i}) - 1), 0)`
      : `texture(T${i}, POS() + vec2(o) / S${i})`;
    H.push(`#define ${b}_pos POS()`, `#define ${b}_size S${i}`, `#define ${b}_pt (1.0 / S${i})`,
      `#define ${b}_tex(q) texture(T${i}, q)`, `#define ${b}_texOff(o) ${off}`, `#define ${b}_mul 1.0`);
  });
  return `${H.join('\n')}\n${pass.body}\nvoid main() { fragColor = hook(); }`;
}

// резкость AMD CAS на итоговом кадре; в холст — с переворотом строк (у WebGL строка 0 внизу)
const CAS = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D U; uniform float outH; uniform float amt;
out vec4 o;
vec3 T(ivec2 q) { ivec2 s = textureSize(U, 0); return texelFetch(U, clamp(q, ivec2(0), s - 1), 0).rgb; }
void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), int(outH) - 1 - int(gl_FragCoord.y));
  vec3 a = T(p + ivec2(-1, -1)), b = T(p + ivec2(0, -1)), c = T(p + ivec2(1, -1));
  vec3 dd = T(p + ivec2(-1, 0)), e = T(p), f = T(p + ivec2(1, 0));
  vec3 g = T(p + ivec2(-1, 1)), h = T(p + ivec2(0, 1)), i = T(p + ivec2(1, 1));
  if (amt <= 0.0) { o = vec4(clamp(e, 0.0, 1.0), 1.0); return; }
  vec3 mn = min(min(min(dd, e), min(f, b)), h); mn += min(mn, min(min(a, c), min(g, i)));
  vec3 mx = max(max(max(dd, e), max(f, b)), h); mx += max(mx, max(max(a, c), max(g, i)));
  vec3 amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, 1e-5), 0.0, 1.0));
  vec3 w = amp * (-1.0 / mix(8.0, 5.0, amt));
  o = vec4(clamp(((b + dd + f + h) * w + e) / (1.0 + 4.0 * w), 0.0, 1.0), 1.0);
}`;
const CAS_AMT = 0.5; // сила резкости поверх (по снимкам: 0.5 — чётко без ореолов, 1.0 — уже ореолы)
// RCAS из AMD FidelityFX FSR1 (MIT): резкость «после увеличения» — крест из 5 точек, сила ограничена так, чтобы не
// выйти за минимум и максимум соседей (без ореолов); amt — сила 0…1 (в FSR — sharpness в ступенях: 0 — сильнее всего)
const RCAS = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D U; uniform float outH; uniform float amt;
out vec4 o;
vec3 T(ivec2 q) { ivec2 s = textureSize(U, 0); return texelFetch(U, clamp(q, ivec2(0), s - 1), 0).rgb; }
void main() {
  ivec2 p = ivec2(int(gl_FragCoord.x), int(outH) - 1 - int(gl_FragCoord.y));
  vec3 b = T(p + ivec2(0, -1)), d = T(p + ivec2(-1, 0)), e = T(p), f = T(p + ivec2(1, 0)), h = T(p + ivec2(0, 1));
  if (amt <= 0.0) { o = vec4(clamp(e, 0.0, 1.0), 1.0); return; }
  vec3 mn4 = min(min(b, d), min(f, h)); vec3 mx4 = max(max(b, d), max(f, h));
  vec3 hitMin = mn4 / (4.0 * mx4 + 1e-5); vec3 hitMax = (1.0 - mx4) / (4.0 * mn4 - 4.0 - 1e-5);
  vec3 l = max(-hitMin, hitMax);
  float lobe = max(-0.1875, min(max(l.r, max(l.g, l.b)), 0.0)) * exp2(-2.0 * (1.0 - amt));
  o = vec4(clamp((lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0), 0.0, 1.0), 1.0);
}`;
// NVIDIA Image Scaling, NVSharpen (MIT, NIS SDK 1.0.3, NIS_Scaler.h / NIS_Config.h): нерезкая маска по яркости вдоль
// найденного направления края (0/90/45/135°), сила и предел — от яркости, «звон» гасится по отношению контрастов с двух
// сторон; amt — sharpness 0…1 (0.5 — середина, как у NVIDIA)
const NIS = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D U; uniform float outH; uniform float amt;
out vec4 o;
float Y(ivec2 q) { ivec2 s = textureSize(U, 0); return dot(texelFetch(U, clamp(q, ivec2(0), s - 1), 0).rgb, vec3(0.2126, 0.7152, 0.0722)); }
const float kDetectRatio = 2.0 * 1127.0 / 1024.0, kDetectThres = 64.0 / 1024.0, kMinCR = 2.0, kRatioNorm = 1.0 / 8.0, kEps = 1.0 / 255.0;
const float kStartY = 0.45, kScaleY = 1.0 / (0.9 - 0.45);
float lti(float y0, float y1, float y2, float y3, float y4) {
  float ac = max(max(y0, y1), y2) - min(min(y0, y1), y2);
  float bc = max(max(y2, y3), y4) - min(min(y2, y3), y4);
  return 1.0 - clamp((max(ac, bc) / (min(ac, bc) + kEps) - kMinCR) * kRatioNorm, 0.0, 1.0);
}
float usm(float y0, float y1, float y2, float y3, float y4, float str, float lim) {
  return clamp((-0.6001 * y1 + 1.2002 * y2 - 0.6001 * y3) * str, -lim, lim) * lti(y0, y1, y2, y3, y4);
}
#define P(i, j) p[(i) * 5 + (j)]
void main() {
  ivec2 c = ivec2(int(gl_FragCoord.x), int(outH) - 1 - int(gl_FragCoord.y));
  ivec2 s = textureSize(U, 0);
  vec3 e = texelFetch(U, clamp(c, ivec2(0), s - 1), 0).rgb;
  if (amt <= 0.0) { o = vec4(clamp(e, 0.0, 1.0), 1.0); return; }
  float p[25];
  for (int i = 0; i < 5; i++) for (int j = 0; j < 5; j++) P(i, j) = Y(c + ivec2(j - 2, i - 2));
  float sl = amt - 0.5;
  float maxS = sl >= 0.0 ? 1.25 : 1.75, minS = sl >= 0.0 ? 1.25 : 1.0;
  float strMin = max(0.0, 0.4 + sl * minS * 1.2), strMax = 1.6 + sl * maxS * 1.8;
  float limMin = max(0.1, 0.14 + sl * minS * 0.32), limMax = 0.5 + sl * minS * 0.6;
  float sy = 1.0 - clamp((P(2, 2) - kStartY) * kScaleY, 0.0, 1.0);
  float str = sy * (strMax - strMin) + strMin;
  float lim = (sy * (limMax - limMin) + limMin) * P(2, 2);
  vec4 d = vec4(
    usm(P(0, 2), P(1, 2), P(2, 2), P(3, 2), P(4, 2), str, lim),
    usm(P(2, 0), P(2, 1), P(2, 2), P(2, 3), P(2, 4), str, lim),
    usm(P(1, 1), mix(P(2, 1), P(1, 2), 0.5), P(2, 2), mix(P(3, 2), P(2, 3), 0.5), P(3, 3), str, lim),
    usm(P(3, 1), mix(P(3, 2), P(2, 1), 0.5), P(2, 2), mix(P(2, 3), P(1, 2), 0.5), P(1, 3), str, lim));
  float g0 = abs(P(1, 1) + P(1, 2) + P(1, 3) - P(3, 1) - P(3, 2) - P(3, 3));
  float g45 = abs(P(2, 1) + P(1, 1) + P(1, 2) - P(3, 2) - P(3, 3) - P(2, 3));
  float g90 = abs(P(1, 1) + P(2, 1) + P(3, 1) - P(1, 3) - P(2, 3) - P(3, 3));
  float g135 = abs(P(2, 1) + P(3, 1) + P(3, 2) - P(1, 2) - P(1, 3) - P(2, 3));
  float m09 = max(g0, g90), n09 = min(g0, g90), m45 = max(g45, g135), n45 = min(g45, g135);
  vec4 w = vec4(0.0);
  if (m09 + m45 > 0.0) {
    float e09 = min(m09 / (m09 + m45), 1.0);
    bool c09 = m09 > n09 * kDetectRatio && m09 > kDetectThres && m09 > n45;
    bool c45 = m45 > n45 * kDetectRatio && m45 > kDetectThres && m45 > n09;
    float f09 = (c09 && c45) ? e09 : 1.0, f45 = (c09 && c45) ? 1.0 - e09 : 1.0;
    w = vec4(c09 && m09 == g0 ? f09 : 0.0, c09 && m09 != g0 ? f09 : 0.0, c45 && m45 == g45 ? f45 : 0.0, c45 && m45 != g45 ? f45 : 0.0);
  }
  o = vec4(clamp(e + dot(d, w), 0.0, 1.0), 1.0);
}`;
const FINAL = { cas: CAS, rcas: RCAS, nis: NIS };

// Clamp_Highlights (Anime4K, MIT): яркость каждой точки после увеличения и резкости — не выше максимума её окрестности
// 5x5 в исходном кадре (гасит светлые ореолы и «звон»). По снимкам настоящих серий (test/_a4kcompare.js): ореолов на
// 10–30 % меньше, PSNR +0.2…0.6 дБ, глазами — как без него; цена — 2 прохода на исходном размере и 1 на итоговом
const CLAMP = 'Anime4K_Clamp_Highlights.glsl';
// Дебандинг (свой, Anix_Deband.glsl): «квадратики» и ступеньки сжатия h264 на ровных участках (тёмные сцены, небо) —
// до Restore, иначе тот и резкость подчёркивают края блоков. По кадрам серий: блоки на тёмном небе уходят, линии и
// мелкие детали — как без него; цена — 1 проход на исходном размере (12 выборок)
const DEBAND = 'Anix_Deband.glsl';

export function createAnime4K(video, { onFail, onFrame, sharp = CAS_AMT, sharpen = 'rcas', chain: base = CHAINS.m, clamp = false, deband = true, full = false } = {}) {
  const chain = [...(deband ? [DEBAND] : []), ...(clamp ? [CLAMP] : []), ...base];
  const canvas = document.createElement('canvas');
  canvas.className = 'sharpen-canvas anime4k-canvas';
  canvas.hidden = true;
  let gl = null; let passes = null; let casProg = null; let mainTex = null; let ready = null;
  let on = false; let failed = false; let frameReq = 0; let rafReq = 0; let shown = false; let sw = 0; let shh = 0;
  const outs = []; // по проходу: { tex, fb, w, h }

  const fail = (why) => {
    if (failed) return;
    failed = true; stop(); canvas.hidden = true;
    window.__anixLog?.(`anime4k: выключено — ${why}`);
    if (onFail) onFail(why);
  };
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fail('контекст WebGL потерян'); });

  function compile(fs) {
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'шейдер');
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'программа');
    return p;
  }
  const params = (linear) => {
    const f = linear ? gl.LINEAR : gl.NEAREST;
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, f], [gl.TEXTURE_MAG_FILTER, f], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  };
  async function init() {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, powerPreference: 'high-performance', desynchronized: true });
    if (!gl) throw new Error('нет WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('нет рендера в RGBA16F');
    const all = (await Promise.all(chain.map(loadText))).flatMap(parsePasses).sort((a, b) => a.stage - b.stage);
    passes = all.map((ps) => ({ ...ps })); // программы — в size(), когда известны размеры текстур
    casProg = compile(FINAL[sharpen] || CAS);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    mainTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, mainTex); params(true);
  }
  // текстуры проходов — под размер кадра источника (их размеры — по //!WIDTH / //!HEIGHT)
  function size(w, h) {
    if (w === sw && h === shh) return;
    sw = w; shh = h;
    for (const o of outs) { gl.deleteTexture(o.tex); gl.deleteFramebuffer(o.fb); }
    outs.length = 0;
    const reg = { MAIN: { w, h } };
    for (const ps of passes) {
      const ow = rpn(ps.width, reg, reg.MAIN.w); const oh = rpn(ps.height, reg, reg.MAIN.h);
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, ow, oh); params(true);
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('кадр RGBA16F не собирается');
      outs.push({ tex, fb, w: ow, h: oh });
      // программа прохода: какие привязанные текстуры — его размера (их соседи — texelFetch); собранные — в кэше
      const same = ps.binds.map((b) => { const t = reg[regKey(b)]; return !!t && t.w === ow && t.h === oh; });
      const key = same.join();
      if (ps.key !== key) {
        if (!ps.progs) ps.progs = new Map();
        if (!ps.progs.has(key)) ps.progs.set(key, compile(passShader(ps, same, full)));
        ps.key = key; ps.prog = ps.progs.get(key);
        ps.loc = { OUT: gl.getUniformLocation(ps.prog, 'OUT'), T: ps.binds.map((_, i) => gl.getUniformLocation(ps.prog, `T${i}`)), S: ps.binds.map((_, i) => gl.getUniformLocation(ps.prog, `S${i}`)) };
      }
      reg[ps.save] = { w: ow, h: oh };
    }
    canvas.width = reg.MAIN.w; canvas.height = reg.MAIN.h;
  }
  // цепочка с увеличением — только когда кадр на экране больше источника (в мини-плеере незачем); без увеличения — всегда
  const upscales = chain.some((f) => /Upscale/.test(nameOf(f)));
  function wanted() {
    if (!on || failed || !video.videoWidth) return false;
    if (!upscales) return true;
    const r = video.getBoundingClientRect();
    return Math.min(r.width / video.videoWidth, r.height / video.videoHeight) * (window.devicePixelRatio || 1) >= 1.2;
  }
  // все проходы на текущем кадре; source — видео или (для замера и проверок) холст
  function renderFrom(source, w, h) {
    size(w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, mainTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const reg = { MAIN: { tex: mainTex, w, h } };
    passes.forEach((ps, k) => {
      const o = outs[k];
      gl.bindFramebuffer(gl.FRAMEBUFFER, o.fb); gl.viewport(0, 0, o.w, o.h);
      gl.useProgram(ps.prog);
      gl.uniform2f(ps.loc.OUT, o.w, o.h);
      ps.binds.forEach((b, i) => {
        const t = reg[regKey(b)];
        gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t.tex);
        gl.uniform1i(ps.loc.T[i], i); gl.uniform2f(ps.loc.S[i], t.w, t.h);
      });
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      reg[ps.save] = o;
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, reg.MAIN.w, reg.MAIN.h);
    gl.useProgram(casProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, reg.MAIN.tex);
    gl.uniform1i(gl.getUniformLocation(casProg, 'U'), 0);
    gl.uniform1f(gl.getUniformLocation(casProg, 'outH'), reg.MAIN.h);
    gl.uniform1f(gl.getUniformLocation(casProg, 'amt'), sharp);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function draw() {
    if (!wanted() || !passes) { canvas.hidden = true; return; }
    try {
      const t0 = performance.now();
      renderFrom(video, video.videoWidth, video.videoHeight);
      const fit = video.style.objectFit || 'contain';
      if (canvas.style.objectFit !== fit) canvas.style.objectFit = fit;
      canvas.hidden = false;
      if (!shown) { shown = true; window.__anixLog?.(`anime4k: работает, ${video.videoWidth}x${video.videoHeight} → ${canvas.width}x${canvas.height}`); }
      if (onFrame) onFrame(performance.now() - t0);
    } catch (e) { fail(String(e && e.message || e)); }
  }
  // успевает ли: кадры видео, показанные мимо нас (requestVideoFrameCallback: presentedFrames с пропусками) — телефон
  // не справляется (например, нагрелся); player.js по ним облегчает цепочку
  const stat = { frames: 0, missed: 0, last: 0 };
  function loop(now, meta) {
    if (meta && meta.presentedFrames) { if (stat.last) { stat.frames += 1; stat.missed += Math.max(0, meta.presentedFrames - stat.last - 1); } stat.last = meta.presentedFrames; }
    draw();
    if (!on || failed) return;
    if (video.requestVideoFrameCallback) frameReq = video.requestVideoFrameCallback(loop);
    else rafReq = requestAnimationFrame(loop);
  }
  function stop() {
    if (frameReq && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameReq);
    if (rafReq) cancelAnimationFrame(rafReq);
    frameReq = 0; rafReq = 0;
  }
  for (const ev of ['seeked', 'loadeddata', 'resize']) video.addEventListener(ev, () => { if (on && !failed && passes) draw(); });

  return {
    canvas,
    stats: () => ({ frames: stat.frames, missed: stat.missed }),
    async setOn(v) {
      on = !!v; stop(); stat.last = 0;
      if (!on || failed) { canvas.hidden = true; return; }
      try { await (ready ??= init()); } catch (e) { fail(String(e && e.message || e)); return; }
      if (on) loop();
    },
    redraw: () => { if (on && !failed && passes) draw(); },
    active: () => !canvas.hidden,
    // для проверок: произвольный кадр (холст) -> холст
    async render(source, w, h) { await (ready ??= init()); renderFrom(source, w, h); },
    // замер (phone-check, diag): кадр w x h — мс на все проходы, с ожиданием видеокарты (readPixels), лучший из runs
    async bench(w, h, runs = 5) {
      await (ready ??= init());
      const cv = new OffscreenCanvas(w, h); const cx = cv.getContext('2d');
      const g = cx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#f2c49b'); g.addColorStop(1, '#2b4c7e');
      cx.fillStyle = g; cx.fillRect(0, 0, w, h);
      const px = new Uint8Array(4);
      // пачка кадров подряд (как при просмотре: видеокарта не успевает сбросить частоту между кадрами) / число кадров
      const once = (n = 6) => { const t0 = performance.now(); for (let i = 0; i < n; i++) renderFrom(cv, w, h); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return (performance.now() - t0) / n; };
      once(3); // прогрев (компиляция, частота)
      const ts = [];
      for (let i = 0; i < runs; i++) { await new Promise((ok) => setTimeout(ok, 30)); ts.push(once()); }
      // лучший прогон: замер ловит и чужую нагрузку (на старте приложение грузит главную) — нужна скорость самого
      // телефона; если на деле не успеет (нагрев), player.js облегчит цепочку во время просмотра
      return Math.min(...ts);
    },
    dispose() { stop(); on = false; failed = true; const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); canvas.remove(); },
  };
}
