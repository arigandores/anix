// Улучшение картинки на телефоне (как «720p +» в Anixart): резкость контуров без увеличения разрешения — AMD FidelityFX
// CAS (MIT), один проход WebGL2 по кадру в его собственном размере; до экрана растягивает браузер. В Anixart то же
// делает фильтр Media3 (AnixAnime4KShaderProgram — лапласиан и нерезкая маска); CAS даёт ту же чёткость с меньшими
// ореолами и за 9 выборок (roadmap.md, пункт 11). Апскейл с нейросетями (upscale/) на телефоне не включается: тяжёлый.
// Холст — над <video> и с тем же object-fit (режим кадра и щипок работают). Кадры — по requestVideoFrameCallback:
// на паузе GPU не работает. Только для источника до 720p и когда кадр на экране не меньше источника (в мини-плеере
// резкость не нужна). Нет WebGL2, кадр нельзя прочитать или контекст потерян — холст прячется, видео как есть.
const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = p * 0.5 + 0.5; uv.y = 1.0 - uv.y; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uAmt;
in vec2 uv; out vec4 o;
vec3 T(vec2 q) { return texture(uSrc, q).rgb; }
void main() {
  vec2 d = uTexel;
  vec3 a = T(uv + vec2(-d.x, -d.y)), b = T(uv + vec2(0.0, -d.y)), c = T(uv + vec2(d.x, -d.y));
  vec3 dd = T(uv + vec2(-d.x, 0.0)), e = T(uv), f = T(uv + vec2(d.x, 0.0));
  vec3 g = T(uv + vec2(-d.x, d.y)), h = T(uv + vec2(0.0, d.y)), i = T(uv + vec2(d.x, d.y));
  vec3 mn = min(min(min(dd, e), min(f, b)), h); mn += min(mn, min(min(a, c), min(g, i)));
  vec3 mx = max(max(max(dd, e), max(f, b)), h); mx += max(mx, max(max(a, c), max(g, i)));
  vec3 amp = sqrt(clamp(min(mn, 2.0 - mx) / max(mx, 1e-5), 0.0, 1.0));
  vec3 w = amp * (-1.0 / mix(8.0, 5.0, uAmt));
  o = vec4(clamp(((b + dd + f + h) * w + e) / (1.0 + 4.0 * w), 0.0, 1.0), 1.0);
}`;
// сила CAS по режиму (настройка PLAYER_SHARPEN)
export const SHARPEN_MODES = { off: 0, soft: 0.45, strong: 0.85 };
export const SHARPEN_LABEL = { off: 'Выкл', soft: 'Чётче', strong: 'Сильнее' };
const MAX_SOURCE_PX = 1280 * 960; // источник до 720p (и 4:3 — 1280×960): 1080p и так чёткий

export function createSharpen(video, { onFail } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'sharpen-canvas';
  canvas.hidden = true;
  let gl = null; let prog = null; let tex = null; let uTexel = null; let uAmt = null;
  let amt = 0; let failed = false; let frameReq = 0; let rafReq = 0;

  function init() {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, powerPreference: 'low-power', desynchronized: true });
    if (!gl) throw new Error('нет WebGL2');
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'шейдер');
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(prog, 0, 'p'); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'программа');
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'uSrc'), 0);
    uTexel = gl.getUniformLocation(prog, 'uTexel'); uAmt = gl.getUniformLocation(prog, 'uAmt');
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  }
  const fail = (why) => {
    if (failed) return;
    failed = true; stop(); canvas.hidden = true;
    if (onFail) onFail(why);
  };
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fail('контекст WebGL потерян'); });

  // нужно ли сейчас: режим включён, источник до 720p, кадр на экране не меньше источника
  function wanted() {
    if (!amt || failed || !video.videoWidth) return false;
    if (video.videoWidth * video.videoHeight > MAX_SOURCE_PX) return false;
    const r = video.getBoundingClientRect();
    const k = Math.min(r.width / video.videoWidth, r.height / video.videoHeight) * (window.devicePixelRatio || 1);
    return k >= 0.9;
  }
  function draw() {
    if (!wanted()) { canvas.hidden = true; return; }
    try {
      if (!gl) init();
      const w = video.videoWidth; const hgt = video.videoHeight;
      if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; gl.viewport(0, 0, w, hgt); }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.uniform2f(uTexel, 1 / w, 1 / hgt); gl.uniform1f(uAmt, amt);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const fit = video.style.objectFit || 'contain';
      if (canvas.style.objectFit !== fit) canvas.style.objectFit = fit;
      canvas.hidden = false;
    } catch (e) { fail(String(e && e.message || e)); }
  }
  // каждый новый кадр видео; нет requestVideoFrameCallback — по кадрам экрана, пока играет
  function loop() {
    draw();
    if (!amt || failed) return;
    if (video.requestVideoFrameCallback) frameReq = video.requestVideoFrameCallback(loop);
    else rafReq = requestAnimationFrame(loop);
  }
  function stop() {
    if (frameReq && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameReq);
    if (rafReq) cancelAnimationFrame(rafReq);
    frameReq = 0; rafReq = 0;
  }
  // перемотка на паузе, смена серии или режима кадра — перерисовать, даже без нового кадра
  for (const ev of ['seeked', 'loadeddata', 'resize']) video.addEventListener(ev, () => { if (amt && !failed) draw(); });

  return {
    canvas,
    setMode(mode) {
      amt = SHARPEN_MODES[mode] || 0;
      stop();
      if (amt && !failed) loop(); else canvas.hidden = true;
    },
    redraw: () => { if (amt && !failed) draw(); },
    active: () => !canvas.hidden,
    // закрыли плеер — видеокарту освобождаем сами: событие «контекст потерян» после этого — не сбой (без тоста)
    dispose() { stop(); amt = 0; failed = true; const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); canvas.remove(); },
  };
}
