// «Настоящее» разрешение серии — по кадрам, а не по подписи качества: «720p» часто оказывается растянутым SD.
// Мера — ширина самых резких контуров (в пикселях кадра): у переходов яркости ширина = контраст монотонного
// участка / самый большой шаг между соседними пикселями. Апскейл в k раз расширяет контуры примерно в k раз,
// и от ядра (bilinear / bicubic / lanczos) и сжатия это почти не зависит. Берётся 10-й перцентиль по тайлу 4x4
// (самые резкие контуры тайла), из тайлов — третий по резкости: хардсаб и логотип занимают один-два тайла.
// По синтетике (чёткий кадр, растянутый в k раз и пережатый x264): w ≈ 0.70 + 0.666·k.
// Результат: blur — во сколько раз картинка мягче своего кадра (≈1 — честное разрешение), eff — высота, на которой
// эта картинка была бы чёткой.

const PCT = 0.10; const TILES = 4; const RANK = 2; const R = 12; const CMIN = 0.2; const STEP = 0.04;
export const FIT = { a: 0.70, b: 0.666 };

// поля (letterbox / pillarbox): строки и столбцы, где нет ничего ярче почти чёрного
function activeBox(Y, W, H, thr = 0.04) {
  let top = -1; let bot = -1; let left = W; let right = -1;
  for (let y = 0; y < H; y++) {
    let any = false;
    for (let x = 0, i = y * W; x < W; x++, i++) if (Y[i] > thr) { any = true; if (x < left) left = x; if (x > right) right = x; }
    if (any) { if (top < 0) top = y; bot = y; }
  }
  if (top < 0 || bot - top < 16 || right - left < 16) return { x0: 0, y0: 0, x1: W, y1: H };
  const m = 4;
  return { x0: left + m, y0: top + m, x1: right - m, y1: bot - m }; // [x0, x1) x [y0, y1)
}

// переходы вдоль одной оси: at(i) — яркость i-го пикселя линии, step — шаг вдоль линии, cross — шаг поперёк
function scan(Y, W, box, vertical, perTile) {
  const { x0, y0, x1, y1 } = box;
  const BW = x1 - x0; const BH = y1 - y0;
  const along = vertical ? W : 1; const across = vertical ? 1 : W;
  const n = vertical ? BH : BW; const lines = vertical ? BW : BH;
  for (let l = 0; l < lines; l++) {
    const base = vertical ? y0 * W + x0 + l : (y0 + l) * W + x0;
    const tileC = vertical ? Math.floor(l * TILES / BW) : -1; const tileR = vertical ? -1 : Math.floor(l * TILES / BH);
    for (let i = R; i < n - R - 1; i++) {
      const p = base + i * along;
      const d = Y[p + along] - Y[p]; const ad = Math.abs(d);
      if (ad <= STEP) continue;
      if (Math.abs(Y[p] - Y[p - along]) > ad || Math.abs(Y[p + 2 * along] - Y[p + along]) >= ad) continue; // локальный максимум шага
      // переход почти перпендикулярен линии: поперечный шаг заметно меньше
      const lineEnd = vertical ? l === lines - 1 : i === n - 1;
      if (!lineEnd && Math.abs(Y[p + across] - Y[p]) >= 0.5 * ad) continue;
      const s = Math.sign(d);
      let top = Y[p + along];
      for (let k = 1; k < R; k++) { const q = p + k * along; if (Math.sign(Y[q + along] - Y[q]) !== s) break; top = Y[q + along]; }
      let bot = Y[p];
      for (let k = 1; k < R; k++) { const q = p - k * along; if (Math.sign(Y[q + along] - Y[q]) !== s) break; bot = Y[q]; }
      const C = Math.abs(top - bot);
      if (C <= CMIN) continue;
      const r = vertical ? Math.floor(i * TILES / BH) : tileR; const c = vertical ? tileC : Math.floor(i * TILES / BW);
      perTile[r * TILES + c].push(C / ad);
    }
  }
}

function quantile(arr, q) {
  const a = Float32Array.from(arr).sort();
  const pos = (a.length - 1) * q; const lo = Math.floor(pos); const hi = Math.min(a.length - 1, lo + 1);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

// Y — яркость 0..1 (Float32Array W*H). { w, tiles, h } — ширина контура (NaN — мало контуров) и высота без полей
export function edgeWidth(Y, W, H) {
  const box = activeBox(Y, W, H);
  const perTile = Array.from({ length: TILES * TILES }, () => []);
  scan(Y, W, box, true, perTile);
  scan(Y, W, box, false, perTile);
  const vals = perTile.filter((t) => t.length >= 30).map((t) => quantile(t, PCT)).sort((a, b) => a - b);
  return { w: vals.length >= 4 ? vals[Math.min(RANK, vals.length - 1)] : NaN, tiles: vals.length, h: box.y1 - box.y0 };
}

// rgba (ImageData.data) -> яркость BT.709
export function lumaOf(rgba, W, H) {
  const Y = new Float32Array(W * H);
  for (let i = 0, j = 0; i < Y.length; i++, j += 4) Y[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
  return Y;
}

// по ширинам с нескольких кадров: { blur, eff, w, n, spread } или null (мало кадров с контурами)
export function estimate(widths, h, min = 3) {
  const ok = widths.filter((w) => Number.isFinite(w));
  if (ok.length < min) return null;
  const w = quantile(ok, 0.5);
  const blur = Math.max(0.5, (w - FIT.a) / FIT.b);
  // разброс: межквартильный размах размытия относительно медианы (0 — все кадры согласны)
  const spread = (quantile(ok, 0.75) - quantile(ok, 0.25)) / FIT.b / blur;
  return { blur, eff: Math.round(h / Math.max(1, blur)), w, n: ok.length, spread };
}

// Замер на идущем видео. Счёт — в воркере (native-worker.js): главный поток только берёт кадр (VideoFrame —
// ссылка на кадр в видеопамяти) и отдаёт его, поэтому замер не задерживает плеер и не искажает время кадра апскейла
// (а на всякий случай кадры, пришедшиеся на замер, index.js в статистику не берёт — overlaps()).
// Первые FAST замеров — раз в FAST_MS, дальше раз в EVERY; оценка — медиана последних KEEP.
// key — источник (тайтл:озвучка-плеер:качество): устоявшаяся оценка запоминается (load/save), и со следующей
// серии класс исходника известен сразу. onChange(est) — когда оценка появилась или размытие сдвинулось больше 8%.
const FAST = 12; const FAST_MS = 1500; const EVERY = 60000; const KEEP = 24; const MOVE = 0.08;
export function createNativeProbe(video, { onChange = () => {}, load = () => null, save = () => {}, active = () => true } = {}) {
  let widths = []; let est = null; let timer = 0; let key = ''; let srcKey = ''; let dead = false;
  let worker = null; let seq = 0; let busy = null; let last = { start: 0, end: 0 }; let saved = false;
  try {
    worker = new Worker(new URL('./native-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => done(data);
    worker.onerror = (e) => { console.warn('[upscale] замер разрешения', e && e.message); worker = null; busy = null; };
  } catch (e) { console.warn('[upscale] замер разрешения недоступен', e && e.message); }

  const schedule = () => { clearTimeout(timer); if (!dead && worker) timer = setTimeout(tick, widths.length < FAST ? FAST_MS : EVERY); };
  function rekey() {
    const k = `${srcKey || video.currentSrc}|${video.videoWidth}x${video.videoHeight}`;
    if (k === key) return;
    // запомненные замеры этого источника (прошлые серии): оценка сразу и продолжает копиться
    key = k; saved = false;
    const c = srcKey ? load(k) : null;
    widths = c && Array.isArray(c.widths) ? c.widths.slice(-KEEP) : [];
    const h = c && c.h ? c.h : video.videoHeight;
    est = widths.length ? estimate(widths, h) : null;
    if (est) { est.cached = true; onChange(est); }
  }
  if (video.videoWidth) rekey();
  function tick() {
    timer = 0;
    const W = video.videoWidth; const H = video.videoHeight;
    if (busy || !active() || !W || !H || video.paused || video.seeking || video.readyState < 2) { schedule(); return; }
    rekey();
    let frame;
    try { frame = new VideoFrame(video); } catch { schedule(); return; }
    busy = { id: ++seq, key, start: performance.now() };
    worker.postMessage({ id: busy.id, frame }, [frame]);
  }
  function done(d) {
    if (!busy || d.id !== busy.id) return;
    const b = busy; busy = null; last = { start: b.start, end: performance.now() };
    if (b.key === key && !d.error) {
      widths.push(d.w); if (widths.length > KEEP) widths.shift();
      const next = estimate(widths, d.h || d.H);
      if (next && (!est || est.cached || Math.abs(next.blur - est.blur) / est.blur > MOVE)) { est = next; onChange(est); } else if (next) est = { ...next, blur: est.blur, eff: est.eff };
      // запоминаем замеры источника, когда их набралось достаточно, и дальше — с каждым новым (раз в минуту)
      if (next && srcKey && (saved || next.n >= FAST - 2)) { saved = true; save(key, { widths: widths.filter(Number.isFinite), h: d.h || d.H }); }
    }
    schedule();
  }
  schedule();
  return {
    get estimate() { return est; },
    get samples() { return widths.slice(); },
    // ключ источника от плеера (серия другого тайтла / озвучки / качества — своя оценка)
    setKey(k) { srcKey = k || ''; key = ''; if (video.videoWidth) rekey(); schedule(); },
    // пересекается ли [t0, t1] с замером (кадры апскейла в это время в статистику не идут)
    overlaps(t0, t1) { return !!busy || (t0 <= last.end && t1 >= last.start); },
    reset() { key = ''; widths = []; est = null; schedule(); },
    destroy() { dead = true; clearTimeout(timer); if (worker) worker.terminate(); worker = null; },
  };
}
