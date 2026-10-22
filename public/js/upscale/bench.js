// Бенчмарк улучшения картинки и прогноз скорости: каждая сеть каталога на кадре 720p, на WebGPU и (если
// установлено ускорение NVIDIA) на TensorRT. Свёрточная сеть считается пропорционально числу пикселей, поэтому
// 480p и 1080p пересчитываются из 720p — проверка идёт секунды, а не минуты. Замеры хранятся по видеокарте; по ним «Авто»
// берёт самый качественный пресет, который успевает, а меню подписывает уровни «тяжело / не потянет».
// Пока бенчмарка нет — прогноз по формуле (умножений на пиксель / скорость видеокарты); замеры на реальных
// кадрах уточняют сохранённые значения.
import { getGpu, loadModel, createUpscaler, submitLatency } from './engine.js';
import { MODELS, CLASS_SIZE, sizeClass, modelName } from './catalog.js';
import { prefs } from '../store.js';
import { ANDROID } from '../platform.js';
import { h, dialog } from '../ui.js';

// --- Ускорение NVIDIA (TensorRT, electron/trt.js) ---
export const native = () => (window.anixartNative && window.anixartNative.trt) || null;
let trtStatusP = null;
// { supported, installed, gpu, … } — поддерживает ли видеокарта, скачаны ли библиотеки
export function trtStatus(refresh) {
  if (!native()) return Promise.resolve({ supported: false });
  if (!trtStatusP || refresh) trtStatusP = native().status().catch(() => ({ supported: false }));
  return trtStatusP;
}
export async function trtInstall(onProgress) {
  const off = native().onProgress(onProgress || (() => {}));
  try { const r = await native().install(); await trtStatus(true); return r; } finally { off(); }
}
export const trtEnabled = () => prefs.get('UPSCALE_TRT') !== false;
export const trtUsable = (st) => !!(st && st.supported && st.installed && trtEnabled());

// --- Замеры: { key, trt, at, partial, ms: { 'сеть|класс|gpu|trt': мс на кадр исходника класса, -1 — слишком медленно } } ---
export const gpuKey = (info) => `${info.vendor}|${info.architecture}|${info.description}`;
const load = () => prefs.get('UPSCALE_BENCH') || null;
// бенчмарк пройден для этой видеокарты (и с TensorRT, если он сейчас доступен)
export function benchDone(key, withTrt) { const b = load(); return !!(b && b.key === key && !b.partial && (!withTrt || b.trt)); }
export function benchInfo() { return load(); }
export function benchReset() { prefs.set('UPSCALE_BENCH', null); prefs.set('UPSCALE_GPU', null); }

// время кадра (мс) пресета id на исходнике w x h; null — замера нет, Infinity — замерено «слишком медленно»
export function measuredMs(key, id, w, h, backend) {
  const b = load();
  if (!b || b.key !== key) return null;
  const cls = sizeClass(h); const [cw, chh] = CLASS_SIZE[cls];
  const v = b.ms[`${MODELS[id].arch}|${cls}|${backend}`];
  if (v == null) return null;
  return v < 0 ? Infinity : v * (w * h) / (cw * chh);
}
// уточнение по реальным кадрам: время, приведённое к размеру класса, смешивается с сохранённым
const LEARN_SLOWER = 1.3;
export function learn(key, id, w, h, backend, ms) {
  const cls = sizeClass(h); const [cw, chh] = CLASS_SIZE[cls];
  const b = load() && load().key === key ? load() : { key, trt: false, partial: true, at: Date.now(), ms: {} };
  const k = `${MODELS[id].arch}|${cls}|${backend}`;
  const v = ms * (cw * chh) / (w * h);
  // заметно медленнее сохранённого — скорее всего, видеокарту занял кто-то ещё: такой замер не запоминаем
  if (b.ms[k] > 0 && v > b.ms[k] * LEARN_SLOWER) return;
  b.ms[k] = b.ms[k] > 0 ? b.ms[k] * 0.7 + v * 0.3 : v;
  prefs.set('UPSCALE_BENCH', b);
}

// --- Сам бенчмарк ---
const RUNS = 3;
const TOO_SLOW = 120; // мс на 720p: такую сеть дальше не гоняем — всё равно не успеет
export async function runBenchmark({ onProgress = () => {}, cancelled = () => false } = {}) {
  const gpu = await getGpu();
  const key = gpuKey(gpu.info);
  const st = await trtStatus(true);
  const withTrt = trtUsable(st);
  // по одному пресету на сеть
  const reps = {};
  for (const [id, m] of Object.entries(MODELS)) if (!reps[m.arch] || id === m.arch) reps[m.arch] = id;
  const tasks = [];
  for (const [arch, id] of Object.entries(reps)) {
    for (const backend of ['gpu', ...(withTrt && MODELS[id].trt ? ['trt'] : [])]) {
      tasks.push({ arch, id, backend, cls: ANDROID ? 'sd' : 'hd' }); // телефон — на 480p: меньше держим видеокарту
    }
  }
  const ms = {};
  const { device } = gpu;
  for (let i = 0; i < tasks.length; i++) {
    if (cancelled()) return null;
    const t = tasks[i];
    const [w, h] = CLASS_SIZE[t.cls];
    onProgress(i, tasks.length, `${modelName(t.id).replace(/ Sharp1| DN| DS/, '')} · ${t.backend === 'trt' ? 'TensorRT' : 'WebGPU'}`);
    let v;
    if (ANDROID) await new Promise((ok) => setTimeout(ok, 150));
    try {
      v = t.backend === 'trt' ? await benchTrt(t.id, w, h) : await benchGpu(device, t.id, w, h);
      if (ANDROID && v > 0) v = Math.max(0.5, v - await submitLatency(device)); // без задержки отправки (engine.js)
    } catch (e) {
      console.warn('[upscale] бенчмарк', t.arch, t.backend, e && e.message);
      v = -1;
    }
    window.__anixLog?.(`bench ${t.arch} ${w}x${h} ${t.backend}: ${v < 0 ? 'не тянет' : `${v.toFixed(1)} мс`}`); // телефон: в журнал (adb logcat -s AnixWeb)
    // 480p и 1080p — по числу пикселей; у TensorRT часть времени — передача кадра, она тоже растёт с размером
    for (const cls of ['sd', 'hd', 'fhd']) {
      const [cw, chh] = CLASS_SIZE[cls];
      const scaled = v < 0 ? -1 : v * (cw * chh) / (w * h);
      ms[`${t.arch}|${cls}|${t.backend}`] = scaled > TOO_SLOW * 4 ? -1 : scaled;
    }
  }
  onProgress(tasks.length, tasks.length, 'Готово');
  const result = { key, trt: withTrt, at: Date.now(), ms };
  prefs.set('UPSCALE_BENCH', result);
  // скорость WebGPU-движка (умножений в секунду) — для прикидок: по средней сети на 720p
  const ref = ms['janai-v31-perf|hd|gpu'];
  if (ref > 0) prefs.set('UPSCALE_GPU', { key, tput: Math.round(MODELS['janai-v31-perf'].macs * 1280 * 720 / (ref / 1000)) });
  return result;
}

function testFrame(w, h) {
  const cv = new OffscreenCanvas(w, h); const cx = cv.getContext('2d');
  const g = cx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#f2c49b'); g.addColorStop(1, '#2b4c7e');
  cx.fillStyle = g; cx.fillRect(0, 0, w, h);
  return new VideoFrame(cv, { timestamp: 0 });
}
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

// телефон: кадр — текстурой (кадр VideoFrame из холста во WebView на Android как внешняя текстура не принимался —
// проход отбрасывался с ошибкой, и бенчмарк мерил пустоту: 1 мс вместо секунд на настоящем видео)
function testTexture(device, w, h) {
  const cv = new OffscreenCanvas(w, h); const cx = cv.getContext('2d');
  const g = cx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#f2c49b'); g.addColorStop(1, '#2b4c7e');
  cx.fillStyle = g; cx.fillRect(0, 0, w, h);
  const t = device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  device.queue.copyExternalImageToTexture({ source: cv }, { texture: t }, [w, h]);
  return { tex: t, close: () => t.destroy() };
}

async function benchGpu(device, id, w, h) {
  const up = await createUpscaler(await loadModel(id), ANDROID ? { input: 'texture' } : {});
  const src = ANDROID ? testTexture(device, w, h) : null;
  const frame = src ? src.tex : testFrame(w, h);
  try {
    up.setSize(w, h);
    const once = async () => {
      const e = device.createCommandEncoder(); up.encode(e, frame);
      const t0 = performance.now(); device.queue.submit([e.finish()]);
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };
    // телефон: видеокарта не прерывает тяжёлую работу ради экрана — между прогонами даём ей нарисовать кадр, а сеть,
    // которая и первый прогон считает дольше 120 мс, дальше не гоняем (раньше бенчмарк вешал приложение — ANR)
    const breathe = () => (ANDROID ? new Promise((ok) => setTimeout(ok, 120)) : null);
    // первый прогон — с компиляцией шейдеров (на телефоне — сотни мс): только прогрев, в оценку не идёт
    if (ANDROID) { await once(); await breathe(); }
    const first = await once();
    if (first > (ANDROID ? TOO_SLOW : TOO_SLOW * 3)) return -1;
    const ts = []; for (let i = 0; i < RUNS; i++) { await breathe(); ts.push(await once()); }
    return median(ts);
  } finally { if (src) src.close(); else frame.close(); up.destroy(); }
}

async function benchTrt(id, w, h) {
  const r = await native().open({ model: id, w, h });
  if (!r.ok) throw new Error(r.error || 'TensorRT не запустился');
  // кадр как от декодера (NV12) — весь путь: копия, передача в anix-trt, расчёт, текстура обратно
  const buf = new Uint8Array(w * h * 3 / 2);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) >>> 24;
  const frame = new VideoFrame(buf, { format: 'NV12', codedWidth: w, codedHeight: h, timestamp: 0 });
  try {
    let slot = 0;
    const once = async () => {
      const t0 = performance.now();
      const rr = await native().run({ session: r.session, slot, frame });
      slot = (slot + 1) % r.ring;
      if (!rr.ok) throw new Error(rr.error || 'кадр не посчитан');
      const out = native().frame(r.session, (slot + r.ring - 1) % r.ring); if (out) out.close();
      return performance.now() - t0;
    };
    await once();
    const ts = []; for (let i = 0; i < RUNS; i++) ts.push(await once());
    return median(ts);
  } finally { frame.close(); await native().close(r.session); }
}

// --- Окна: предложение и прогресс ---
// «Подобрать модели под видеокарту?» -> true (начать) / false (позже)
export function benchPrompt(withTrt) {
  return new Promise((resolve) => {
    let start = false;
    dialog({
      title: 'Подобрать модели под видеокарту?',
      content: h('div', null,
        h('p', null, `Приложение проверит, какие нейросети ваша видеокарта успевает считать на сериях 480p, 720p и 1080p${withTrt ? ' — с ускорением NVIDIA и без' : ''}. «Авто» после этого будет брать лучшую модель, которая не тормозит.`),
        h('p', { class: 'muted3' }, 'Займёт несколько секунд, видео на это время встанет на паузу. Повторить можно в настройках.')),
      actions: [{ label: 'Позже' }, { label: 'Начать', primary: true, onClick: () => { start = true; } }],
      onClose: () => resolve(start),
    });
  });
}
// бенчмарк с окном прогресса и «Отмена»; результат или null (отменён / ошибка)
export function benchRunDialog() {
  return new Promise((resolve) => {
    let cancel = false;
    // серия на паузе, пока идёт проверка: видеокарта нужна бенчмарку целиком, а кадры серии ему мешают
    const v = document.querySelector('.player-overlay video');
    const resume = v && !v.paused;
    if (resume) v.pause();
    const done = (r) => { if (resume) v.play().catch(() => {}); resolve(r); };
    const fill = h('div', { class: 'bench-fill' });
    const label = h('div', { class: 'bench-label' }, 'Подготовка…');
    const d = dialog({
      title: 'Проверка видеокарты',
      content: h('div', { class: 'bench' }, h('div', { class: 'bench-bar' }, fill), label),
      actions: [{ label: 'Отмена', onClick: () => { cancel = true; label.textContent = 'Останавливаю…'; return true; } }],
      onClose: () => { cancel = true; },
    });
    runBenchmark({
      cancelled: () => cancel,
      onProgress: (i, n, text) => { fill.style.width = `${Math.round((i / n) * 100)}%`; label.textContent = `${text} (${Math.min(i + 1, n)} из ${n})`; },
    }).then((r) => { d.close(); done(r); }, (e) => { console.warn('[upscale] бенчмарк', e); d.close(); done(null); });
  });
}
// таблица результатов: сеть × класс -> мс (WebGPU / TensorRT)
export function benchResultsDialog() {
  const b = load();
  if (!b || b.partial) { dialog({ title: 'Проверка видеокарты', content: h('p', null, 'Проверки ещё не было.'), actions: [{ label: 'OK', primary: true }] }); return; }
  const archs = [...new Set(Object.values(MODELS).map((m) => m.arch))];
  const cell = (k) => { const v = b.ms[k]; return v == null ? '—' : v < 0 ? 'не тянет' : `${Math.round(v)} мс`; };
  const rows = archs.map((a) => {
    const m = Object.entries(MODELS).find(([id, x]) => x.arch === a && id === a) || Object.entries(MODELS).find(([, x]) => x.arch === a);
    return h('tr', null, h('td', null, `${m[1].family} ${m[1].preset.replace(/ Sharp1| DN| DS/, '')}`),
      ...['sd', 'hd', 'fhd'].map((c) => h('td', null, cell(`${a}|${c}|gpu`), b.trt && m[1].trt ? h('div', { class: 'trt' }, cell(`${a}|${c}|trt`)) : null)));
  });
  dialog({
    title: 'Результаты проверки', cls: 'bench-results',
    content: h('div', null,
      h('table', { class: 'bench-table' }, h('tr', null, h('th', null, 'Сеть'), ...['480p', '720p', '1080p'].map((x) => h('th', null, x))), ...rows),
      h('p', { class: 'muted3' }, `Время на кадр: WebGPU${b.trt ? ', ниже зелёным — с ускорением NVIDIA (TensorRT)' : ''}. Проверено ${new Date(b.at).toLocaleDateString('ru-RU')}.`)),
    actions: [{ label: 'OK', primary: true }],
  });
}
