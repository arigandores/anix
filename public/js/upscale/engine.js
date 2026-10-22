// WebGPU-движок апскейла: свёрточные сети (ArtCNN, Real-ESRGAN Compact / AnimeJaNai V3, SPAN / AnimeJaNai V3.1 / AniSD)
// на кадрах видео. Модель — public/models/upscale/<id>.json + .bin (tools/convert-upscale-model.py): список свёрток
// 3x3 / 1x1 с «хвостом» (активация, умножение на сумму тензоров, прибавление тензоров). Сеть считается на разрешении
// исходника (или половинном — pixel-unshuffle), последняя свёртка раскладывает каналы в картинку 2x (DepthToSpace)
// и пишет её в текстуру rgba16float. Активации — буферы [группа из 4 каналов][y][x] в f16 (если видеокарта умеет) или f32.
// Веса лежат в uniform-буферах (кэш констант): каждая рабочая группа читает одни и те же веса — это быстрее storage.

const MODELS_URL = '/models/upscale/';

import { ANDROID } from '../platform.js';
let gpu = null; // { adapter, device, f16 }

export async function getGpu() {
  if (gpu) return gpu;
  if (!navigator.gpu) throw new Error('WebGPU недоступен');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('Видеокарта не поддерживает WebGPU');
  const f16 = adapter.features.has('shader-f16');
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredFeatures: f16 ? ['shader-f16'] : [],
    requiredLimits: {
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
      maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage,
    },
  });
  const info = adapter.info || {};
  gpu = { adapter, device, f16, info: { vendor: info.vendor || '', architecture: info.architecture || '', description: info.description || '' } };
  device.lost.then(() => { if (gpu && gpu.device === device) gpu = null; });
  return gpu;
}

// f16 little-endian -> float32
function halfToFloat(u16) {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const hb = u16[i]; const s = hb & 0x8000 ? -1 : 1; const e = (hb >> 10) & 31; const m = hb & 1023;
    out[i] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return out;
}

const modelCache = new Map();
// Задержка «отправил → видеокарта сообщила, что готово» без работы (мс, медиана): на Android (WebView) она ~15–20 мс и
// входит в каждый замер через onSubmittedWorkDone — бенчмарк и замер кадров её вычитают, иначе лёгкая модель
// выглядела не успевающей (Anime4K M на 480p: 37 мс замера при ~20 мс работы)
let latency = null;
export function submitLatency(device) {
  if (!latency) {
    latency = (async () => {
      const ts = [];
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now(); device.queue.submit([device.createCommandEncoder().finish()]);
        await device.queue.onSubmittedWorkDone(); ts.push(performance.now() - t0);
      }
      ts.sort((x, y) => x - y);
      return ts[3];
    })();
  }
  return latency;
}

export function loadModel(id) {
  if (!modelCache.has(id)) {
    const get = (ext) => fetch(`${MODELS_URL}${id}.${ext}`).then((r) => { if (!r.ok) throw new Error(`модель ${id}: ${r.status}`); return r; });
    const p = Promise.all([get('json').then((r) => r.json()), get('bin').then((r) => r.arrayBuffer())])
      .then(([spec, bin]) => { spec.data = halfToFloat(new Uint16Array(bin)); return spec; });
    p.catch(() => modelCache.delete(id));
    modelCache.set(id, p);
  }
  return modelCache.get(id);
}

const g4 = (c) => Math.ceil(c / 4);

// Параметры ядра: блок BW x BH потоков, PX пикселей на поток по x, CC групп входов за раз в общей памяти,
// COB групп выходов на рабочую группу (делитель числа групп, чтобы блоки весов были полными).
// телефон (Adreno, замеры diag.js на Snapdragon 8 Gen 1): веса из storage и группы 8x8 — быстрее всего (на ПК-раскладке
// uniform 16x16 кадр считался в 1.3–3 раза дольше)
export const KERNEL = ANDROID ? { BW: 8, BH: 8, PX: 2, CC: 2, COB: 8, noUniform: true } : { BW: 16, BH: 16, PX: 2, CC: 2, COB: 8 };
const UNIFORM_MAX = 65536;
const ALIGN = 256;

// Раскладка входов свёртки: concat тензоров -> подряд идущие группы каналов
function inputLayout(op, tensors) {
  let base = 0;
  return op.in.map((t) => { const c = tensors[t].c; const r = { t, base, groups: g4(c), c }; base += g4(c); return r; });
}

// Веса -> mat4x4 на каждую тройку (группа выходов, группа входов, отвод): столбец k — входной канал k группы,
// строки — 4 выходных канала. Порядок [co4][ci4][tap]. Недостающие каналы — нули.
function packWeights(op, lay, data) {
  const ci4 = lay.reduce((s, l) => s + l.groups, 0); const co4 = g4(op.cout); const T = op.k * op.k;
  const out = new Float32Array(co4 * ci4 * T * 16);
  for (let co = 0; co < op.cout; co++) {
    let ci = 0;
    for (const l of lay) {
      for (let j = 0; j < l.c; j++, ci++) {
        const g = l.base + (j >> 2);
        for (let t = 0; t < T; t++) {
          out[(((co >> 2) * ci4 + g) * T + t) * 16 + (j & 3) * 4 + (co & 3)] = data[op.w + (co * op.cin + ci) * T + t];
        }
      }
    }
  }
  return out;
}
// float32 -> биты float16 (веса для счёта в f16), с округлением к ближайшему
function toHalf(src) {
  if (typeof Float16Array !== 'undefined') return new Uint16Array(new Float16Array(src).buffer); // WebView 135+
  const out = new Uint16Array(src.length);
  const f = new Float32Array(1); const u = new Uint32Array(f.buffer);
  for (let i = 0; i < src.length; i++) {
    f[0] = src[i]; const x = u[0];
    const sign = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 127 + 15; let m = x & 0x7fffff;
    if (e >= 31) { out[i] = sign | 0x7c00; continue; } // переполнение -> бесконечность (у весов не бывает)
    if (e <= 0) { // субнормаль
      if (e < -10) { out[i] = sign; continue; }
      m = (m | 0x800000) >> (1 - e);
      out[i] = sign | ((m + 0x1000) >> 13); continue;
    }
    const r = m + 0x1000; // округление
    if (r & 0x800000) { m = 0; e += 1; if (e >= 31) { out[i] = sign | 0x7c00; continue; } } else m = r;
    out[i] = sign | (e << 10) | (m >> 13);
  }
  return out;
}

// bias и alpha PReLU -> vec4 на группу выходов: [bias co4][alpha co4]
function packBias(op, data) {
  const co4 = g4(op.cout);
  const out = new Float32Array(co4 * 8);
  for (let c = 0; c < op.cout; c++) {
    out[c] = data[op.b + c];
    if (op.act === 'prelu') out[co4 * 4 + c] = data[op.alpha + c];
  }
  return out;
}

const ACT = {
  relu: 'max(r, vec4f(0))',
  prelu: 'select(r * bs[CO4 + g], r, r >= vec4f(0))',
  silu: 'r / (1.0 + exp(-r))',
  tanh: 'tanh(clamp(r, vec4f(-15), vec4f(15)))',
  sigm05: '1.0 / (1.0 + exp(-r)) - 0.5',
  crelu: 'r', // пишется особо (две половины, хвост convShader)
};

// math16 — свёртка считается в f16 (веса mat4x4<f16>, накопители vec4<f16>): у мобильных видеокарт (Adreno, Mali)
// f16 вдвое быстрее f32. Хвост (bias, активация, запись) — по-прежнему в f32. На ПК — f32, как было
function convShader(op, ctx) {
  const { o, f16, spec, tensors, math16 } = ctx;
  const S = f16 ? 'f16' : 'f32';
  const A = math16 ? 'f16' : 'f32'; const MB = math16 ? 32 : 64; // тип счёта и байт на матрицу весов
  const last = op.out === -1;
  const { BW, BH, PX } = o;
  const lay = inputLayout(op, tensors);
  const ci4 = lay.reduce((s, l) => s + l.groups, 0); const co4 = g4(op.cout);
  const K = op.k; const T = K * K; const HALO = (K - 1) / 2;
  const CC = Math.min(o.CC, ci4);
  // группа выходов на рабочую группу: делитель co4, блок весов влезает в uniform; у последней — все выходы сразу
  // bake — веса вшиты в шейдер числами, циклы развёрнуты (как Anime4K): мобильная видеокарта не ходит за весами
  // в память. Только для лёгких сетей (код растёт с числом весов); все выходы — в одной рабочей группе
  const bake = !!(o.bake && ctx.weights);
  let COB = last || bake ? co4 : 1;
  if (!last && !bake) for (let c = Math.min(o.COB, co4); c >= 1; c--) if (co4 % c === 0 && c * ci4 * T * MB <= UNIFORM_MAX) { COB = c; break; }
  const uni = !bake && !o.noUniform && COB * ci4 * T * MB <= UNIFORM_MAX; // noUniform — веса из storage (замеры на телефоне, diag.js)
  const TW = BW * PX + 2 * HALO; const TH = BH + 2 * HALO;
  const extra = [...new Set([...(op.mul || []), ...(op.add || [])].filter((x) => x !== 'self'))];
  const L = [];
  const p = (s) => L.push(s);
  if (f16 || math16) p('enable f16;');
  p('struct Dims { w: i32, h: i32, plane: i32, cob: u32, ow: i32, oh: i32, p0: i32, p1: i32 }');
  p('@group(0) @binding(0) var<uniform> d: Dims;');
  lay.forEach((l, i) => p(`@group(0) @binding(${1 + i}) var<storage, read> src${i}: array<vec4<${S}>>;`));
  if (!bake) {
    p(uni ? `@group(0) @binding(10) var<uniform> wt: array<mat4x4<${A}>, ${COB * ci4 * T}>;`
      : `@group(0) @binding(10) var<storage, read> wt: array<mat4x4<${A}>>;`);
  }
  p('@group(0) @binding(11) var<storage, read> bs: array<vec4<f32>>;');
  if (last) {
    p('@group(0) @binding(12) var dst: texture_storage_2d<rgba16float, write>;');
    if (spec.residual) p(`@group(0) @binding(13) var<storage, read> res: array<vec4<${S}>>;`);
  } else {
    p(`@group(0) @binding(12) var<storage, read_write> dst: array<vec4<${S}>>;`);
  }
  extra.forEach((t, i) => p(`@group(0) @binding(${14 + i}) var<storage, read> x${t}: array<vec4<${S}>>;`));
  p(`const TW = ${TW}u; const CI4 = ${ci4}u; const CO4 = ${co4}u;`);
  p(`var<workgroup> tile: array<vec4<${S}>, ${CC * TW * TH}>;`);
  p(`@compute @workgroup_size(${BW}, ${BH})`);
  p('fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(local_invocation_index) li: u32) {');
  p(`  let ox = i32(wg.x) * ${BW * PX}; let oy = i32(wg.y) * ${BH}; let cob = ${uni ? 'd.cob' : `wg.z * ${COB}u`};`);
  for (let c = 0; c < COB; c++) for (let q = 0; q < PX; q++) p(`  var a${c}_${q} = vec4<${A}>(bs[cob + ${c}u]);`);
  if (bake) {
    const W = ctx.weights;
    const num = (x) => (x === 0 ? '0.0' : String(+x.toPrecision(7)).replace(/^(-?\d+)$/, '$1.0'));
    const lit = (at) => `mat4x4<${A}>(${Array.from(W.subarray(at, at + 16), num).join(',')})`;
    for (let c0 = 0; c0 < ci4; c0 += CC) {
      p('  workgroupBarrier();');
      p(`  for (var i = li; i < ${CC * TW * TH}u; i += ${BW * BH}u) {`);
      p(`    let c = ${c0}u + i / ${TW * TH}u; let r = i % ${TW * TH}u;`);
      p(`    let x = ox + i32(r % TW) - ${HALO}; let y = oy + i32(r / TW) - ${HALO};`);
      p(`    var v = vec4<${S}>(0);`);
      p('    if (c < CI4 && x >= 0 && y >= 0 && x < d.w && y < d.h) {');
      p('      let pix = y * d.w + x;');
      lay.forEach((l, i) => p(`      ${i ? 'else ' : ''}if (c < ${l.base + l.groups}u) { v = src${i}[i32(c - ${l.base}u) * d.plane + pix]; }`));
      p('    }');
      p('    tile[i] = v;');
      p('  }');
      p('  workgroupBarrier();');
      for (let c = 0; c < CC && c0 + c < ci4; c++) {
        for (let t = 0; t < T; t++) {
          p(`  { let tb = ${c * TW * TH}u + (lid.y + ${Math.floor(t / K)}u) * TW + lid.x + ${t % K}u;`);
          for (let q = 0; q < PX; q++) p(`    let v${q} = vec4<${A}>(tile[tb + ${q * BW}u]);`);
          for (let co = 0; co < COB; co++) {
            p(`    { let m = ${lit(((co * ci4 + c0 + c) * T + t) * 16)};`);
            for (let q = 0; q < PX; q++) p(`      a${co}_${q} += m * v${q};`);
            p('    }');
          }
          p('  }');
        }
      }
    }
  } else {
  p(`  for (var c0 = 0u; c0 < CI4; c0 += ${CC}u) {`);
  p('    workgroupBarrier();');
  p(`    for (var i = li; i < ${CC * TW * TH}u; i += ${BW * BH}u) {`);
  p(`      let c = c0 + i / ${TW * TH}u; let r = i % ${TW * TH}u;`);
  p(`      let x = ox + i32(r % TW) - ${HALO}; let y = oy + i32(r / TW) - ${HALO};`);
  p(`      var v = vec4<${S}>(0);`);
  p('      if (c < CI4 && x >= 0 && y >= 0 && x < d.w && y < d.h) {');
  p('        let pix = y * d.w + x;');
  lay.forEach((l, i) => p(`        ${i ? 'else ' : ''}if (c < ${l.base + l.groups}u) { v = src${i}[i32(c - ${l.base}u) * d.plane + pix]; }`));
  p('      }');
  p('      tile[i] = v;');
  p('    }');
  p('    workgroupBarrier();');
  p(`    for (var c = 0u; c < ${CC}u; c++) {`);
  if (ci4 % CC) p('    if (c0 + c >= CI4) { break; }');
  p(`    for (var t = 0u; t < ${T}u; t++) {`);
  p(`      let tb = c * ${TW * TH}u + (lid.y + t / ${K}u) * TW + lid.x + t % ${K}u;`);
  for (let q = 0; q < PX; q++) p(`      let v${q} = vec4<${A}>(tile[tb + ${q * BW}u]);`);
  for (let co = 0; co < COB; co++) {
    p(`      { let m = wt[((${uni ? '' : 'cob + '}${co}u) * CI4 + c0 + c) * ${T}u + t];`);
    for (let q = 0; q < PX; q++) p(`        a${co}_${q} += m * v${q};`);
    p('      }');
  }
  p('    } }');
  p('  }');
  }
  // хвост
  for (let q = 0; q < PX; q++) {
    p(`  { let x = ox + i32(lid.x) + ${q * BW}; let y = oy + i32(lid.y);`);
    p('    if (x < d.w && y < d.h) { let pix = y * d.w + x;');
    if (!last) {
      for (let co = 0; co < COB; co++) {
        p(`    { let g = cob + ${co}u; let r = vec4f(a${co}_${q}); let k = i32(g) * d.plane + pix;`);
        p(`      var o = ${op.act ? ACT[op.act] : 'r'};`);
        if (op.mul) p(`      o *= ${op.mul.map((t) => (t === 'self' ? 'r' : `vec4f(x${t}[k])`)).join(' + ')};`);
        if (op.add) p(`      o += ${op.add.map((t) => `vec4f(x${t}[k])`).join(' + ')};`);
        // crelu (Anime4K): выход — 2·cout каналов: [max(r,0) | max(-r,0)], отрицательная половина — группами после положительной
        if (op.act === 'crelu') p(`      dst[k] = vec4<${S}>(max(r, vec4f(0))); dst[i32(g + CO4) * d.plane + pix] = vec4<${S}>(max(-r, vec4f(0))); }`);
        else p(`      dst[k] = vec4<${S}>(o); }`);
      }
    } else {
      // DepthToSpace(R): CRD — канал c*R*R + i*R + j; DCR — (i*R + j)*C + c. i — строка, j — столбец подпикселя.
      const R = spec.shuffle.r; const C = op.cout / (R * R);
      const ch = (n) => `f32(a${n >> 2}_${q}.${'xyzw'[n & 3]})`;
      // residual 'bilinear' (Anime4K): исходник, растянутый билинейно до подпикселя (веса 9/16, 3/16, 3/16, 1/16), а не
      // ближайший пиксель; shuffle.broadcast — один канал выхода (добавка яркости) прибавляется ко всем трём цветам
      const bil = spec.residual === 'bilinear';
      if (spec.residual && !bil) p('      let base = vec4f(res[pix]);');
      if (bil) {
        p('      let rx0 = max(x - 1, 0); let rx1 = min(x + 1, d.w - 1); let ry0 = max(y - 1, 0); let ry1 = min(y + 1, d.h - 1);');
        p('      let rc = vec4f(res[pix]);');
      }
      const lo = spec.clip ? spec.clip[0] : -60000; const hi = spec.clip ? spec.clip[1] : 60000;
      for (let i = 0; i < R; i++) {
        for (let j = 0; j < R; j++) {
          if (bil) {
            const rx = j ? 'rx1' : 'rx0'; const ry = i ? 'ry1' : 'ry0';
            p(`      let b${i}${j} = 0.5625 * rc + 0.1875 * vec4f(res[y * d.w + ${rx}]) + 0.1875 * vec4f(res[${ry} * d.w + x]) + 0.0625 * vec4f(res[${ry} * d.w + ${rx}]);`);
          }
          const comps = [0, 1, 2].map((c) => {
            const cc = spec.shuffle.broadcast ? 0 : c;
            if (cc >= C) return '0.0';
            const n = spec.shuffle.mode === 'CRD' ? cc * R * R + i * R + j : (i * R + j) * C + cc;
            return ch(n) + (bil ? ` + b${i}${j}.${'xyz'[c]}` : spec.residual ? ` + base.${'xyz'[c]}` : '');
          });
          p(`      { let px = vec2i(x * ${R} + ${j}, y * ${R} + ${i});`);
          p(`        if (px.x < d.ow && px.y < d.oh) { textureStore(dst, px, vec4f(clamp(vec3f(${comps.join(', ')}), vec3f(${lo}), vec3f(${hi})), 1.0)); } }`);
        }
      }
    }
    p('  } }');
  }
  p('}');
  return { code: L.join('\n'), COB, uni, bake, groupsZ: co4 / COB, lay, extra, ci4, T };
}

// Вход сети: кадр видео (texture_external) -> группы тензора 0: rgb, яркость BT.709 или pixel-unshuffle 2
// (группа c = 4 соседних пикселя цвета c, края отражаются как Pad(reflect))
function inputShader(spec, f16, fromTexture, srcLuma) {
  const S = f16 ? 'f16' : 'f32';
  const load = (xy) => (fromTexture ? `textureLoad(frame, ${xy}, 0)` : `textureLoad(frame, ${xy})`);
  let body;
  if (spec.unshuffle === 2) {
    body = `let fw = d.ow; let fh = d.oh;
  var q: array<vec3f, 4>;
  for (var k = 0; k < 4; k++) {
    var px = x * 2 + (k & 1); var py = y * 2 + (k >> 1);
    if (px >= fw) { px = 2 * (fw - 1) - px; }
    if (py >= fh) { py = 2 * (fh - 1) - py; }
    q[k] = ${load('vec2u(u32(px), u32(py))')}.rgb;
  }
  for (var c = 0; c < 3; c++) { dst[c * d.plane + y * d.w + x] = vec4<${S}>(vec4f(q[0][c], q[1][c], q[2][c], q[3][c])); }`;
  } else {
    body = `let c = ${load('vec2u(u32(x), u32(y))')}.rgb;
  dst[y * d.w + x] = vec4<${S}>(${spec.in !== 'luma' ? 'vec4f(c, 0.0)' : srcLuma ? 'vec4f(c.r, 0.0, 0.0, 0.0)' : 'vec4f(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 0.0, 0.0)'});`;
  }
  return `${f16 ? 'enable f16;' : ''}
struct Dims { w: i32, h: i32, plane: i32, cob: u32, ow: i32, oh: i32, p0: i32, p1: i32 }
@group(0) @binding(0) var<uniform> d: Dims;
@group(0) @binding(1) var frame: ${fromTexture ? 'texture_2d<f32>' : 'texture_external'};
@group(0) @binding(2) var<storage, read_write> dst: array<vec4<${S}>>;
@compute @workgroup_size(16, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let x = i32(id.x); let y = i32(id.y);
  if (x >= d.w || y >= d.h) { return; }
  ${body}
}`;
}

// Время жизни тензоров: какой буфер пула занимает каждый (буферы переиспользуются, когда тензор больше не нужен)
function planBuffers(spec) {
  const lastUse = spec.tensors.map(() => -1);
  spec.ops.forEach((op, i) => {
    for (const t of [...op.in, ...(op.mul || []), ...(op.add || [])]) if (t !== 'self') lastUse[t] = Math.max(lastUse[t], i);
  });
  if (spec.residual) lastUse[0] = spec.ops.length - 1;
  const slotOf = spec.tensors.map(() => -1);
  const free = []; let slots = 0;
  slotOf[0] = slots++;
  spec.ops.forEach((op, i) => {
    // выход не должен совпасть с буфером, который этот же проход читает: освобождаем после выделения
    if (op.out >= 0) slotOf[op.out] = free.length ? free.pop() : slots++;
    for (let t = 0; t < spec.tensors.length; t++) if (lastUse[t] === i && slotOf[t] >= 0 && t !== op.out) free.push(slotOf[t]);
  });
  return { slotOf, slots };
}

export async function createUpscaler(spec, opts = {}) {
  const { device, f16: canF16 } = await getGpu();
  const f16 = opts.f16 ?? canF16;
  const math16 = opts.math16 ?? (f16 && ANDROID); // счёт в f16 — на телефоне (convShader)
  const kernel = { ...KERNEL, ...(opts.kernel || {}) };
  const bpe = f16 ? 8 : 16; // байт на vec4
  const { tensors, ops } = spec;
  const U = spec.unshuffle || 1;
  const maxG = Math.max(...tensors.map((t) => g4(t.c)));
  const plan = planBuffers(spec);

  const mod = (code) => device.createShaderModule({ code });
  // вход: кадр видео (texture_external) или текстура предыдущего прохода (opts.input === 'texture');
  // opts.srcLuma — в текстуре только яркость (выход luma-модели), её не пересчитывать из rgb
  const fromTexture = opts.input === 'texture';
  const inPipe = device.createComputePipeline({ layout: 'auto', compute: { module: mod(inputShader(spec, f16, fromTexture, !!opts.srcLuma)), entryPoint: 'main' } });
  let dimSlots = 1; // слот 0 — входной проход; дальше по слоту на каждую z-группу (в ней своё cob)
  const convs = await Promise.all(ops.map(async (op) => {
    const sh = convShader(op, { o: kernel, f16, spec, tensors, math16, weights: kernel.bake ? packWeights(op, inputLayout(op, tensors), spec.data) : null });
    const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: mod(sh.code), entryPoint: 'main' } });
    let wb = packWeights(op, sh.lay, spec.data); const bb = packBias(op, spec.data);
    if (math16) wb = toHalf(wb);
    const es = wb.BYTES_PER_ELEMENT; // байт на число весов: 4 (f32) или 2 (f16)
    let blockBytes = 0; let blockStride = 0;
    if (sh.uni) {
      // каждая z-группа — отдельный блок весов COB x CI4 x T матриц по выровненному смещению
      blockBytes = sh.COB * sh.ci4 * sh.T * 16 * es; blockStride = Math.ceil(blockBytes / ALIGN) * ALIGN;
      const src = wb; wb = new src.constructor(blockStride * sh.groupsZ / es);
      for (let z = 0; z < sh.groupsZ; z++) wb.set(src.subarray(z * blockBytes / es, (z + 1) * blockBytes / es), z * blockStride / es);
    }
    const w = device.createBuffer({ size: wb.byteLength, usage: (sh.uni ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE) | GPUBufferUsage.COPY_DST });
    const b = device.createBuffer({ size: bb.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(w, 0, wb); device.queue.writeBuffer(b, 0, bb);
    const slot = dimSlots; dimSlots += sh.uni ? sh.groupsZ : 1;
    return { op, sh, pipe, w, b, blockBytes, blockStride, slot };
  }));
  const dims = device.createBuffer({ size: dimSlots * ALIGN, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const dimRes = (slot) => ({ buffer: dims, offset: slot * ALIGN, size: 32 });

  let W = 0; let H = 0; let w = 0; let h = 0; let pool = null; let out = null; let binds = null;
  function setSize(fw, fh) {
    if (fw === W && fh === H) return;
    destroyFrames();
    W = fw; H = fh; w = Math.ceil(fw / U); h = Math.ceil(fh / U);
    const dv = new Int32Array(dimSlots * ALIGN / 4);
    const put = (slot, cob) => dv.set([w, h, w * h, cob, fw * 2, fh * 2], slot * ALIGN / 4);
    put(0, 0);
    dv.set([w, h, w * h, 0, fw, fh], 0); // входному проходу — размер кадра
    for (const c of convs) for (let z = 0; z < (c.sh.uni ? c.sh.groupsZ : 1); z++) put(c.slot + z, z * c.sh.COB);
    device.queue.writeBuffer(dims, 0, dv);
    pool = [];
    for (let i = 0; i < plan.slots; i++) pool.push(device.createBuffer({ size: Math.max(16, w * h * bpe * maxG), usage: GPUBufferUsage.STORAGE }));
    const buf = (t) => ({ buffer: pool[plan.slotOf[t]] });
    out = device.createTexture({ size: [fw * 2, fh * 2], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    binds = convs.map((c) => {
      const entries = c.sh.lay.map((l, i) => ({ binding: 1 + i, resource: buf(l.t) }));
      entries.push({ binding: 11, resource: { buffer: c.b } });
      if (c.op.out === -1) {
        entries.push({ binding: 12, resource: out.createView() });
        if (spec.residual) entries.push({ binding: 13, resource: buf(0) });
      } else entries.push({ binding: 12, resource: buf(c.op.out) });
      c.sh.extra.forEach((t, i) => entries.push({ binding: 14 + i, resource: buf(t) }));
      const groups = [];
      for (let z = 0; z < (c.sh.uni ? c.sh.groupsZ : 1); z++) {
        groups.push(device.createBindGroup({ layout: c.pipe.getBindGroupLayout(0), entries: [...entries,
          { binding: 0, resource: dimRes(c.slot + z) },
          ...(c.sh.bake ? [] : [{ binding: 10, resource: c.sh.uni ? { buffer: c.w, offset: z * c.blockStride, size: c.blockBytes } : { buffer: c.w } }])] }));
      }
      return groups;
    });
  }
  function destroyFrames() {
    if (pool) pool.forEach((b) => b.destroy());
    if (out) out.destroy();
    pool = null; out = null; binds = null; W = 0; H = 0;
  }

  // source: HTMLVideoElement / VideoFrame или GPUTexture (input: 'texture'); записывает команды в encoder
  function encode(encoder, source, timestampWrites) {
    const ext = fromTexture ? source.createView() : device.importExternalTexture({ source });
    const inBind = device.createBindGroup({ layout: inPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: dimRes(0) }, { binding: 1, resource: ext }, { binding: 2, resource: { buffer: pool[plan.slotOf[0]] } }] });
    const pass = encoder.beginComputePass(timestampWrites ? { timestampWrites } : undefined);
    pass.setPipeline(inPipe); pass.setBindGroup(0, inBind);
    pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 8));
    const gx = Math.ceil(w / (kernel.BW * kernel.PX)); const gy = Math.ceil(h / kernel.BH);
    convs.forEach((c, i) => {
      pass.setPipeline(c.pipe);
      if (c.sh.uni) binds[i].forEach((bg) => { pass.setBindGroup(0, bg); pass.dispatchWorkgroups(gx, gy, 1); });
      else { pass.setBindGroup(0, binds[i][0]); pass.dispatchWorkgroups(gx, gy, c.sh.groupsZ); }
    });
    pass.end();
  }

  return {
    spec, f16, kernel,
    get output() { return out; },
    get width() { return W; }, get height() { return H; },
    setSize, encode,
    destroy() { destroyFrames(); convs.forEach((c) => { c.w.destroy(); c.b.destroy(); }); dims.destroy(); },
  };
}
