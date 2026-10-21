// Апскейл видео в плеере: выбор модели, «Авто», цепочка проходов, цикл по кадрам и защита от рывков.
// Пользователь выбирает режим (Выкл / Авто / Лёгкое / Сильное / Максимальное), для ручного уровня — пресет
// (catalog.js: LEVELS) и «Резкость» (Мягче / Обычно / Резче) — только для ручного уровня; разрешение (Авто / 1080p / 1440p / 4K). Класс
// исходника (чёткий / мягкий / растянутый SD) — по кадрам самой серии (native.js), а не по подписи качества.
// «Авто» идёт по списку для класса и «Резкости» (catalog.js: autoList) и берёт первый пресет, который по бенчмарку
// (bench.js) успевает; если на реальном видео не успевает — опускается ниже, а когда видеокарта освободится — поднимается
// обратно (молча: текущая модель видна в строке состояния меню). Ручной уровень — выбор пользователя: модель не
// меняется, лишние кадры пропускаются: метка «не успевает» в строке состояния и одно onNotice на модель за сеанс.
// Ещё onNotice — когда улучшение выключилось из-за ошибки видеокарты.
// На NVIDIA RTX тяжёлые модели считает TensorRT на тензорных ядрах (electron/trt.js, anix-trt.exe): кадр уходит
// в отдельную программу, результат возвращается общей текстурой (VideoFrame). Если TensorRT не установлен или
// сломался — те же модели считает WebGPU-движок.
import { getGpu, loadModel, createUpscaler } from './engine.js';
import { has } from '../platform.js';
import { createPresenter } from './present.js';
import { MODELS, LEVELS, TIER_LABEL, SECOND, styled, tierOf, autoList, modelName, sourceClass } from './catalog.js';
import { native, trtStatus, trtInstall, trtEnabled, trtUsable, gpuKey, benchDone, measuredMs, learn } from './bench.js';
import { createNativeProbe } from './native.js';
import { prefs } from '../store.js';

export { TIERS, TIER_LABEL, MODELS, modelName } from './catalog.js';
export { SHARPNESS, SHARP_LABEL } from './catalog.js';
export { trtStatus, trtInstall, benchPrompt, benchRunDialog, benchResultsDialog, benchReset, benchInfo } from './bench.js';
export const MODES = ['off', 'auto', 'fast', 'quality', 'max'];
export const TARGETS = ['auto', '1080', '1440', '2160'];

// доля интервала между кадрами, которую может занимать апскейл: модель, что укладывается в BUDGET, берётся; выше
// OVERLOAD на реальном видео — «Авто» снижает модель (рывки — только выше 100%: тогда кадр пропускается).
// Пример: SD Compact на TensorRT для 720p — ~26 мс, у серии 29.97 к/с кадр 33.4 мс — 78%, успевает.
const BUDGET = 0.8;
const OVERLOAD = 0.9; // выше — видеокарта не успевает: снижаем уровень
const NEED = 1.12; // увеличение меньше этого — апскейл не нужен
// «Авто» после снижения из-за нагрузки: через UP_WAIT пробует ступень выше, если она успеет с запасом (UP_ROOM от
// бюджета) при текущей загрузке видеокарты; не удержалась дольше UP_FAIL — следующая попытка вдвое позже (до UP_MAX)
const UP_WAIT = 20000; const UP_MAX = 600000; const UP_FAIL = 30000; const UP_ROOM = 0.8; const UP_OK = 60000;
// ~накладные расходы TensorRT на кадр до бенчмарка: копия кадра, передача в anix-trt и обратно (мс; px — пикселей)
const trtOverhead = (px) => 1 + 3.5 * px / 1e6;

// выбранный пользователем пресет уровня для класса исходника (без «Резкости»)
const picked = (t, cls) => { const p = (prefs.get('UPSCALE_PICK') || {})[t] || {}; return LEVELS[t][cls].includes(p[cls]) ? p[cls] : LEVELS[t][cls][0]; };
const sharpness = () => prefs.get('UPSCALE_SHARP') || 'normal'; // только для ручного уровня

// Скорость WebGPU-движка до бенчмарка: средняя модель на кадре 640x360, медиана из 4 прогонов
let calibrating = null;
function calibrate(device) {
  if (!calibrating) {
    calibrating = (async () => {
      const spec = await loadModel('janai-v31-perf');
      const up = await createUpscaler(spec);
      const W = 640; const H = 360;
      up.setSize(W, H);
      const cv = new OffscreenCanvas(W, H); const cx = cv.getContext('2d');
      cx.fillStyle = '#7a5'; cx.fillRect(0, 0, W, H); cx.fillStyle = '#123'; cx.fillRect(W / 4, H / 4, W / 2, H / 2);
      const frame = new VideoFrame(cv, { timestamp: 0 });
      const run = async () => {
        const e = device.createCommandEncoder(); up.encode(e, frame);
        const t0 = performance.now(); device.queue.submit([e.finish()]);
        await device.queue.onSubmittedWorkDone();
        return performance.now() - t0;
      };
      try {
        await run();
        const ts = []; for (let i = 0; i < 4; i++) ts.push(await run());
        ts.sort((a, b) => a - b);
        return (spec.macs * W * H) / (((ts[1] + ts[2]) / 2) / 1000);
      } finally { frame.close(); up.destroy(); }
    })();
    calibrating.catch(() => { calibrating = null; });
  }
  return calibrating;
}

export function createUpscale({ video, stage, onChange = () => {}, onNotice = () => {}, onBenchPrompt = () => {} }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'up-canvas';
  canvas.hidden = true;
  video.after(canvas);

  let gpu = null; let gpuError = null; let presenter = null; let key = '';
  let tput = 0; // MAC/с WebGPU-движка (прикидка до бенчмарка)
  let mode = has.upscale ? prefs.get('UPSCALE_MODE') || 'off' : 'off'; // на Android улучшения нет (platform.js)
  let target = prefs.get('UPSCALE_TARGET') || 'auto';
  let tier = null; // уровень текущей модели (для «Авто» — уровень выбранного пресета)
  let autoCap = 0; // «Авто»: не выше этого места в рейтинге (растёт, когда модель не успела на реальном видео)
  // возврат наверх: когда снизились, когда поднимались, когда проверяли, текущая пауза, таймер повтора (ничего не успевало)
  let capAt = 0; let upAt = 0; let checkAt = 0; let backoff = UP_WAIT; let retryTimer = 0;
  const trail = []; const note = (x) => { trail.push(`${Math.round(performance.now() / 100) / 10}с ${x}`); if (trail.length > 30) trail.shift(); }; // для отладки
  let current = null; // базовый пресет (без «Резкости»), который сейчас работает
  let split = 0; let holdOriginal = false;
  let stages = []; let stagesKey = ''; let building = null; let buildSeq = 0;
  let rvfc = 0; let inflight = 0; let destroyed = false;
  let samples = []; let lastMs = 0; let overloadSince = 0;
  let slow = false; let slowNoticed = ''; // ручной уровень не успевает (метка в меню); о чём уже сказали (модель@высота)
  let fps = 24; let lastMedia = 0; let lastFrames = 0; let cbs = 0; let drawn = 0;
  let need = null; // { srcW, srcH, dispH, outH, passes, cls } — что требуется сейчас
  let trt = null; let trtFailed = false; let trtBusy = false; let benchAsked = false; let benching = false;
  const useTrt = (id) => !!(MODELS[id].trt && trtUsable(trt) && !trtFailed);
  let status = { text: '', state: 'off' };
  // «настоящее» разрешение серии по кадрам (native.js): класс исходника — по нему, а не по высоте кадра
  const NATIVE_KEEP = 300;
  const probe = createNativeProbe(video, {
    active: () => mode !== 'off' && !benching,
    load: (k) => (prefs.get('UPSCALE_NATIVE') || {})[k] || null,
    save: (k, v) => {
      const all = { ...(prefs.get('UPSCALE_NATIVE') || {}) }; delete all[k]; all[k] = v;
      const ks = Object.keys(all); for (const x of ks.slice(0, Math.max(0, ks.length - NATIVE_KEEP))) delete all[x];
      prefs.set('UPSCALE_NATIVE', all);
    },
    onChange: () => { if (!destroyed && mode !== 'off') onChange(status); }, // класс сменится — onFrame пересоберёт
  });

  // --- Геометрия: прямоугольник картинки внутри stage (object-fit: contain) ---
  function layout() {
    const sw = stage.clientWidth; const sh = stage.clientHeight;
    const vw = video.videoWidth; const vh = video.videoHeight;
    if (!sw || !sh || !vw || !vh) return null;
    const k = Math.min(sw / vw, sh / vh);
    const w = vw * k; const hh = vh * k;
    const dpr = window.devicePixelRatio || 1;
    return { left: (sw - w) / 2, top: (sh - hh) / 2, w, h: hh, pw: Math.round(w * dpr), ph: Math.round(hh * dpr) };
  }
  function placeCanvas(l) {
    Object.assign(canvas.style, { left: `${l.left}px`, top: `${l.top}px`, width: `${l.w}px`, height: `${l.h}px` });
    if (canvas.width !== l.pw || canvas.height !== l.ph) { canvas.width = l.pw; canvas.height = l.ph; }
  }

  // --- Что нужно: исходник, экран, цель, число проходов ---
  const displayHeight = () => { const l = layout(); return l ? l.ph : Math.round((stage.clientHeight || 0) * (window.devicePixelRatio || 1)); };
  function computeNeed() {
    const srcH = video.videoHeight; const l = layout();
    if (!srcH || !l) return null;
    const outH = target === 'auto' ? l.ph : Number(target);
    const passes = outH <= srcH * NEED ? 0 : outH > srcH * 2 * 1.25 ? 2 : 1;
    return { srcW: video.videoWidth, srcH, dispH: l.ph, outH, passes, cls: sourceClass(srcH, probe.estimate, video.videoWidth, need && need.srcH === srcH ? need.cls : '') };
  }
  // время кадра (мс) пресета на текущем исходнике: замер бенчмарка, иначе прикидка; null — не знаем
  function modelMs(id, n = need) {
    if (!n) return null;
    const be = useTrt(id) ? 'trt' : 'gpu';
    let ms = measuredMs(key, id, n.srcW, n.srcH, be);
    if (ms == null) {
      if (!tput) return null;
      const px = n.srcW * n.srcH;
      ms = be === 'trt' ? (MODELS[id].macs * px / (tput * MODELS[id].trt)) * 1000 + trtOverhead(px) : (MODELS[id].macs * px / tput) * 1000;
    }
    if (n.passes === 2) {
      const s2 = measuredMs(key, SECOND, n.srcW * 2, n.srcH * 2, 'gpu');
      ms += s2 != null ? s2 : tput ? (MODELS[SECOND].macs * n.srcW * n.srcH * 4 / tput) * 1000 : 0;
    }
    return ms;
  }
  const frameMs = () => 1000 / Math.max(1, fps * (video.playbackRate || 1));
  const loadOf = (ms) => (ms == null ? null : ms <= frameMs() * BUDGET ? 'ok' : ms <= frameMs() * 0.95 ? 'heavy' : 'no');
  // какую модель берём сейчас: { base, id } или null (ничего не успевает)
  function choose(n) {
    if (mode === 'auto') {
      const list = autoList(n.cls); // готовые пресеты класса: «Резкость» в «Авто» не участвует
      for (let i = Math.min(autoCap, list.length - 1); i < list.length; i++) {
        const ms = modelMs(list[i], n);
        if (ms == null && i === list.length - 1) return { base: list[i], id: list[i], rank: i };
        if (ms != null && ms <= frameMs() * BUDGET) return { base: list[i], id: list[i], rank: i };
        if (ms == null && !tput) return { base: list[list.length - 1], id: list[list.length - 1], rank: list.length - 1 };
      }
      return null;
    }
    const base = picked(mode, n.cls);
    return { base, id: styled(base, sharpness(), n.cls), tier: mode };
  }

  function setStatus(state, text) {
    if (status.state === state && status.text === text) return;
    status = { state, text }; onChange(status);
  }
  function describe() {
    if (!stages.length) return '';
    const out = need.passes === 2 ? need.srcH * 4 : need.srcH * 2;
    const shown = Math.min(out, need.outH);
    // «настоящее» разрешение — когда заметно ниже кадра (растянутый SD или мягкий HD)
    const est = probe.estimate; const real = est && est.eff < need.srcH * 0.85 ? ` (≈ ${Math.round(est.eff / 10) * 10}p)` : '';
    return `${need.srcH}p${real} → ${shown}p · ${modelName(stages[0].id)}${stages.length > 1 ? ' + ArtCNN' : ''}${stages[0].trt ? ' · TensorRT' : ''}${lastMs ? ` · ${Math.round(lastMs)} мс` : ''}${slow ? ' · не успевает' : ''}`;
  }

  // --- Сборка проходов (асинхронно; старые работают, пока новые не готовы) ---
  async function ensureStages(first) {
    const ids = need.passes ? [first, ...(need.passes === 2 ? [SECOND] : [])] : [];
    const k = `${ids.map((id, i) => (!i && useTrt(id) ? `${id}:trt` : id)).join('+')}@${need.srcW}x${need.srcH}`;
    if (k === stagesKey || (building && building.key === k)) return;
    const seq = ++buildSeq;
    building = { key: k };
    if (!stages.length) setStatus('loading', 'Готовлю модель…');
    try {
      const built = [];
      let w = need.srcW; let h = need.srcH; let prevLuma = false; let prevTrt = false;
      for (let i = 0; i < ids.length; i++) {
        if (!i && useTrt(ids[0])) {
          // TensorRT: сеанс под модель и размер кадра (движок собирается один раз и кэшируется на диске)
          if (!stages.length) setStatus('loading', 'Готовлю TensorRT…');
          // старый сеанс закроется вместе с открытием нового: его кадры в полёте вернутся с ошибкой — это не поломка
          if (stages[0] && stages[0].trt) stages[0].closing = true;
          const r = await native().open({ model: ids[0], w, h });
          if (!r.ok) throw Object.assign(new Error(r.error || 'TensorRT не запустился'), { trt: true });
          built.push({ id: ids[0], trt: true, session: r.session, ring: r.ring, slot: 0, last: null, luma: false, w, h });
          prevTrt = true;
        } else {
          const spec = await loadModel(ids[i]);
          // вход второго прохода: текстура WebGPU-прохода или VideoFrame результата TensorRT
          const up = await createUpscaler(spec, i && !prevTrt ? { input: 'texture', srcLuma: prevLuma } : {});
          up.setSize(w, h);
          built.push({ id: ids[i], up, luma: spec.in === 'luma', w, h });
          prevLuma = spec.in === 'luma'; prevTrt = false;
        }
        w *= 2; h *= 2;
      }
      if (seq !== buildSeq || destroyed) { dropStages(built); return; }
      const old = stages;
      stages = built; stagesKey = k; samples = []; lastMs = 0; overloadSince = 0;
      // старые буферы освобождаем после того, как видеокарта закончит с ними
      if (old.length) dropStages(old, built.some((s) => s.trt));
      // показывает слой первая отрисовка (reveal): в скрытом холсте — старый кадр в старом месте (мини-плеер
      // развернули — а TensorRT первый кадр ещё считает), показать его сразу — мелькнёт
      if (!stages.length || holdOriginal) canvas.hidden = true;
      renderNow();
    } catch (e) {
      console.warn('[upscale] сборка', ids.join('+'), e && e.message);
      // во время бенчмарка сеанс TensorRT у плеера отбирают — это не поломка: после бенчмарка соберём заново
      if (seq === buildSeq && !benching) { if (e && e.trt) trtError(e); else fail(e); }
    } finally {
      if (seq === buildSeq) building = null;
    }
  }

  // кадр из <video> не взять (источник сменился, кадр ещё не декодирован) — это не поломка: кадр пропускаем
  const noFrame = (e) => !!e && e.name === 'OperationError' && /importExternalTexture/.test(e.message || '');
  function fail(e) {
    // имя и текст: DOMException в консоли иначе виден как [object DOMException]
    console.warn('[upscale]', e && e.name ? `${e.name}: ${e.message}` : e, e && e.stack ? e.stack.split(/\n/).slice(0, 4).join(' ‹ ') : '');
    gpuError = e;
    clearStages();
    setStatus('error', 'Не удалось включить: видеокарта не справилась');
    onNotice('Улучшение картинки выключено: видеокарта не справилась');
  }
  function clearStages() {
    buildSeq++; building = null;
    const old = stages; stages = []; stagesKey = '';
    canvas.hidden = true;
    if (old.length) dropStages(old);
  }
  // освободить проходы после того, как видеокарта закончит с ними; сеанс TensorRT закрыть, если новый его не заменил
  function dropStages(list, keepTrt) {
    const done = gpu ? gpu.device.queue.onSubmittedWorkDone() : Promise.resolve();
    done.then(() => list.forEach((s) => { if (s.trt) { if (s.last) s.last.close(); s.last = null; } else s.up.destroy(); }));
    if (!keepTrt && native()) for (const s of list) if (s.trt) native().close(s.session).catch(() => {});
  }
  // TensorRT сломался — дальше те же модели считает WebGPU
  function trtError(e) {
    console.warn('[upscale] TensorRT', e && e.message);
    if (trtFailed || benching) return;
    trtFailed = true;
    stagesKey = '';
    update();
  }

  // --- Решение: что считать сейчас и нужен ли апскейл вообще ---
  async function update() {
    if (destroyed || benching) return;
    if (mode === 'off') { clearStages(); stopLoop(); setStatus('off', ''); return; }
    if (gpuError && !gpu) { setStatus('error', 'Недоступно: видеокарта не поддерживает WebGPU'); return; }
    if (!gpu) {
      try {
        gpu = await getGpu();
        key = gpuKey(gpu.info);
        const saved = prefs.get('UPSCALE_GPU'); tput = saved && saved.key === key ? saved.tput : 0;
        presenter = createPresenter(gpu.device, canvas);
        gpu.device.lost.then(() => { if (!destroyed) { presenter = null; gpu = null; clearStages(); setStatus('error', 'Видеокарта сбросилась — включите заново'); } });
      } catch (e) { gpuError = e; setStatus('error', 'Недоступно: видеокарта не поддерживает WebGPU'); return; }
      if (destroyed || mode === 'off') return;
    }
    if (!trt) { trt = await trtStatus(); if (destroyed || mode === 'off') return; }
    // бенчмарка для этой видеокарты (и TensorRT) ещё нет — предложить (один раз за сеанс плеера и не после «Позже»)
    if (!benchAsked && !benchDone(key, trtUsable(trt)) && prefs.get('UPSCALE_BENCH_LATER') !== `${key}|${trtUsable(trt)}`) {
      benchAsked = true; onBenchPrompt();
    }
    if (!tput && !benchDone(key, false)) {
      setStatus('loading', 'Проверяю видеокарту…');
      try { tput = await calibrate(gpu.device); prefs.set('UPSCALE_GPU', { key, tput: Math.round(tput) }); } catch (e) { console.warn('[upscale] замер', e && e.message); }
      if (destroyed || mode === 'off') return;
    }
    need = computeNeed();
    if (!need) { setStatus('wait', 'Ждёт видео'); startLoop(); return; }
    if (!need.passes) { clearStages(); setStatus('idle', 'Не требуется: серия уже в разрешении окна'); startLoop(); return; }
    // второй проход — только если укладывается в бюджет (в «Авто») — иначе один проход и мягкое увеличение
    let pick = choose(need);
    if (!pick && need.passes === 2 && mode === 'auto') { need = { ...need, passes: 1 }; pick = choose(need); }
    if (pick && need.passes === 2 && mode === 'auto' && (modelMs(pick.id) || 0) > frameMs() * BUDGET) need = { ...need, passes: 1 };
    if (!pick) { note(`ничего не успевает: ${need.cls}`); clearStages(); setStatus('idle', 'Видеокарта не успевает даже лёгкое улучшение'); startLoop(); return; }
    if (pick.base !== current) note(`${need.cls}: ${pick.id}`);
    current = pick.base; tier = pick.tier || tierOf(pick.base);
    startLoop();
    await ensureStages(pick.id);
  }

  // --- Цикл по кадрам видео ---
  function startLoop() {
    if (rvfc || destroyed || !video.requestVideoFrameCallback) return;
    rvfc = video.requestVideoFrameCallback(onFrame);
  }
  function stopLoop() { if (rvfc) video.cancelVideoFrameCallback(rvfc); rvfc = 0; }
  function onFrame(_now, meta) {
    rvfc = 0; cbs++;
    if (destroyed || mode === 'off') return;
    // частота кадров видео — по mediaTime между кадрами
    if (lastMedia && meta.presentedFrames > lastFrames && meta.mediaTime > lastMedia) {
      const f = (meta.presentedFrames - lastFrames) / (meta.mediaTime - lastMedia);
      if (f > 5 && f < 121) fps = fps * 0.9 + f * 0.1;
    }
    lastMedia = meta.mediaTime; lastFrames = meta.presentedFrames;
    startLoop();
    const n = computeNeed();
    if (!n || !need || n.srcH !== need.srcH || n.srcW !== need.srcW || n.dispH !== need.dispH || n.outH !== need.outH || n.cls !== need.cls) { update(); return; }
    renderNow(true);
  }

  function renderNow(fromFrame) {
    if (!stages.length || !presenter || !gpu || holdOriginal || benching) return;
    if (stages[0].trt) { if (!stages[0].closing) runTrt(fromFrame); return; }
    if (video.readyState < 2) return; // кадра ещё нет (серия только открылась, перемотка) — нечего брать
    if (inflight >= 2) { overloaded(); return; } // видеокарта не успевает: кадр пропускаем, уровень снизим
    const l = layout();
    if (!l) return;
    placeCanvas(l);
    const { device } = gpu;
    try {
      const enc = device.createCommandEncoder();
      let prev = null; let color = null; let luma = null;
      for (const s of stages) {
        s.up.encode(enc, prev ? prev.up.output : video);
        if (s.luma) luma = s.up.output; else { color = s.up.output; luma = null; }
        prev = s;
      }
      presenter.draw(enc, video, { color, luma, split });
      const t0 = performance.now(); const solo = inflight === 0;
      inflight++;
      device.queue.submit([enc.finish()]); if (fromFrame) drawn++;
      reveal();
      device.queue.onSubmittedWorkDone().then(() => {
        inflight--;
        if (fromFrame && solo) measure(performance.now() - t0, t0);
      });
    } catch (e) { if (!noFrame(e)) fail(e); }
  }

  // --- TensorRT: кадр видео -> anix-trt -> VideoFrame результата; остальное — как у WebGPU ---
  function runTrt(fromFrame) {
    const st = stages[0];
    if (!fromFrame) { presentTrt(); return; } // перерисовка (размер окна, шторка) — последним результатом
    if (trtBusy) { overloaded(); return; } // предыдущий кадр ещё считается — этот пропускаем
    let vf;
    try { vf = new VideoFrame(video); } catch { return; } // кадра ещё нет
    trtBusy = true;
    const slot = st.slot; st.slot = (st.slot + 1) % st.ring;
    const t0 = performance.now();
    native().run({ session: st.session, slot, frame: vf }).then((r) => {
      if (stages[0] !== st || destroyed) return;
      if (!r.ok) throw Object.assign(new Error(r.error || 'кадр не посчитан'), { trt: true });
      const out = native().frame(st.session, slot);
      if (!out) throw Object.assign(new Error('нет текстуры результата'), { trt: true });
      if (st.last) st.last.close();
      st.last = out; drawn++;
      presentTrt(() => measure(performance.now() - t0, t0));
    }).catch((e) => { if (stages[0] === st && !st.closing) trtError(e); }).finally(() => { vf.close(); trtBusy = false; });
  }
  function presentTrt(after) {
    const l = layout();
    if (!l || !stages.length || !stages[0].last) return;
    placeCanvas(l);
    const { device } = gpu;
    try {
      const enc = device.createCommandEncoder();
      let src = null; let color = null; let colorFrame = null; let luma = null;
      for (const s of stages) {
        if (s.trt) { colorFrame = s.last; src = s.last; continue; }
        s.up.encode(enc, src || video);
        src = s.up.output;
        if (s.luma) luma = s.up.output; else { color = s.up.output; colorFrame = null; luma = null; }
      }
      presenter.draw(enc, video, { color, colorFrame, luma, split });
      device.queue.submit([enc.finish()]);
      reveal();
      if (after) device.queue.onSubmittedWorkDone().then(after);
    } catch (e) { if (!noFrame(e)) fail(e); }
  }
  // слой виден только с кадром, нарисованным по текущему размеру
  function reveal() {
    if (canvas.hidden && stages.length && !holdOriginal) canvas.hidden = false;
  }

  // --- Замер и защита от рывков ---
  function measure(ms, t0) {
    if (!stages.length) return;
    if (probe.overlaps(t0, t0 + ms)) return; // кадр пришёлся на замер разрешения — в статистику не берём
    samples.push(ms); if (samples.length > 24) samples.shift();
    if (samples.length < 6) return;
    const sorted = samples.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    lastMs = med;
    // реальные кадры уточняют замеры бенчмарка (одиночный проход — его время целиком)
    // (только когда успеваем: замеры под чужой нагрузкой на видеокарту в бенчмарк не пишем)
    const over = med > frameMs() * OVERLOAD;
    if (!over && stages.length === 1 && samples.length % 12 === 6) learn(key, stages[0].id, need.srcW, need.srcH, stages[0].trt ? 'trt' : 'gpu', med);
    if (over) overloaded(); else { overloadSince = 0; slow = false; tryUp(med); }
    setStatus('on', describe());
  }
  function overloaded() {
    const now = performance.now();
    if (!overloadSince) { overloadSince = now; return; }
    if (now - overloadSince < 1500) return;
    overloadSince = 0;
    if (mode !== 'auto') {
      // ручной уровень — выбор пользователя: модель не меняем, лишние кадры пропускаются. Метка в строке состояния
      // и одно уведомление на модель за сеанс — иначе рывки выглядят как поломка
      slow = true; setStatus('on', describe());
      const k = `${stages[0] ? stages[0].id : ''}@${need ? need.srcH : 0}`;
      if (k !== slowNoticed) { slowNoticed = k; onNotice(`Видеокарта не успевает за уровнем «${TIER_LABEL[mode] || mode}» — видео может подтормаживать. Плавнее будет в «Авто» или на уровне полегче`); }
      return;
    }
    // «Авто»: на ступень ниже по рейтингу; если только что поднимались и не удержались — следующая попытка позже
    if (upAt && now - upAt < UP_FAIL) backoff = Math.min(UP_MAX, backoff * 2);
    upAt = 0; capAt = now;
    const list = need ? autoList(need.cls) : [];
    const i = list.indexOf(current);
    note(`перегрузка ${current} (${i}/${list.length})`);
    // текущей модели нет в списке (класс исходника только что сменился) — просто пересобрать по новому списку
    if (i < 0 && list.length) { update(); return; }
    if (i >= 0 && i < list.length - 1) {
      autoCap = i + 1;
      update();
      return;
    }
    clearStages();
    setStatus('idle', 'Видеокарта не успевает даже лёгкое улучшение');
    // замеров больше нет — повторить по таймеру, когда видеокарта, возможно, освободится
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = 0; if (!destroyed && mode === 'auto') { autoCap = list.length - 1; upAt = performance.now(); update(); } }, backoff);
  }
  // «Авто»: ступень выше, если при нынешней загрузке видеокарты она успеет с запасом
  function tryUp(med) {
    const now = performance.now();
    if (upAt && now - upAt > UP_OK) { upAt = 0; backoff = UP_WAIT; } // подъём удержался — пауза снова короткая
    if (mode !== 'auto' || !autoCap || !need || building || !stages.length || samples.length < 12) return;
    if (now - capAt < backoff || now - upAt < backoff || now - checkAt < backoff) return;
    if (med > frameMs() * BUDGET * UP_ROOM) return;
    const list = autoList(need.cls); const i = list.indexOf(current);
    if (i <= 0) return;
    checkAt = now;
    // загрузка: во сколько раз текущая модель сейчас медленнее своего замера; с ней прикидываем ступень выше
    const exp = modelMs(stages[0].id);
    const load = exp ? Math.max(1, med / exp) : 1;
    const up = list[i - 1];
    const pred = modelMs(up);
    if (pred == null || pred * load > frameMs() * BUDGET) return;
    autoCap = i - 1; upAt = now;
    update();
  }

  const ro = new ResizeObserver(() => { if (mode !== 'off') { if (!rvfc) startLoop(); renderNow(); } });
  ro.observe(stage);
  video.addEventListener('loadedmetadata', onSource);
  function resetCap() { autoCap = 0; capAt = 0; upAt = 0; checkAt = 0; backoff = UP_WAIT; clearTimeout(retryTimer); retryTimer = 0; }
  function onSource() { samples = []; lastMedia = 0; resetCap(); if (mode !== 'off') update(); }
  if (mode !== 'off') update();

  return {
    get debug() { return { auto: need ? autoList(need.cls).map((id) => ({ id, ms: modelMs(id) })) : null, budget: frameMs() * BUDGET, trail: trail.slice(), native: probe.estimate, nativeSamples: probe.samples, tput, tier, current, autoCap, need, stages: stages.map((x) => (x.trt ? `${x.id}:trt` : x.id)), trt, trtFailed, stagesKey, building: building && building.key, samples: samples.slice(), lastMs, fps, cbs, drawn, inflight, gpuError: gpuError && String(gpuError.message || gpuError) }; },
    // источник серии от плеера (тайтл:озвучка-плеер:качество) — для запомненной оценки разрешения
    setSourceKey(k) { probe.setKey(k); },
    // оценка «настоящего» разрешения: { blur, eff, n, cached } или null
    get native() { return probe.estimate; },
    get mode() { return mode; },
    get target() { return target; },
    get split() { return split; },
    get status() { return status; },
    get tier() { return tier; },
    get sharpness() { return sharpness(); },
    displayHeight,
    setMode(m) {
      if (!has.upscale) return;
      mode = m; tier = null; resetCap(); prefs.set('UPSCALE_MODE', m);
      if (m === 'off') { split = 0; }
      update();
    },
    setTarget(t) { target = t; prefs.set('UPSCALE_TARGET', t); update(); },
    setSharpness(s) { prefs.set('UPSCALE_SHARP', s); if (mode !== 'auto') update(); },
    // пресеты уровня для текущего исходника: [{ id, name, ms, load, chosen }]
    presets(t) {
      const n = need || computeNeed();
      if (!n) return [];
      const cur = picked(t, n.cls);
      return LEVELS[t][n.cls].map((id) => { const ms = n.passes ? modelMs(styled(id, sharpness(), n.cls), n) : null; return { id, name: modelName(id), ms, load: loadOf(ms), chosen: id === cur }; });
    },
    setPreset(t, id) {
      const n = need || computeNeed(); if (!n) return;
      const all = { ...(prefs.get('UPSCALE_PICK') || {}) }; all[t] = { ...(all[t] || {}), [n.cls]: id };
      prefs.set('UPSCALE_PICK', all); update();
    },
    // ускорение NVIDIA: состояние для меню, вкл/выкл, установка библиотек
    trtInfo() {
      if (!trt) trtStatus().then((st) => { if (!trt && !destroyed) { trt = st; onChange(status); } });
      return { ...(trt || {}), enabled: trtEnabled(), failed: trtFailed, active: !!(stages[0] && stages[0].trt) };
    },
    setTrt(on) { prefs.set('UPSCALE_TRT', on); trtFailed = false; stagesKey = ''; update(); },
    async installTrt(onProgress) {
      const r = await trtInstall(onProgress);
      trt = await trtStatus(); trtFailed = false; stagesKey = ''; benchAsked = false;
      update();
      return r;
    },
    // бенчмарк: пройден ли для этой видеокарты; после прохождения — пересчитать выбор
    benchNeeded() { return !!key && !benchDone(key, trtUsable(trt)); },
    benchLater() { prefs.set('UPSCALE_BENCH_LATER', `${key}|${trtUsable(trt)}`); },
    // на время бенчмарка плеер не считает: бенчмарк закрывает сеанс TensorRT и занимает видеокарту
    benchStart() { benching = true; buildSeq++; building = null; if (stages[0] && stages[0].trt) stages[0].closing = true; },
    benchFinished() { benching = false; resetCap(); stagesKey = ''; trtStatus(true).then((st) => { trt = st; update(); }); },
    setSplit(v) { split = v; renderNow(); },
    // размер области сменился не от окна (мини-плеер свернули/развернули): слой ставим по новому размеру сразу,
    // до отрисовки — иначе до следующего кадра видео он мелькает в старом месте
    relayout() { renderNow(); },
    setHoldOriginal(v) { holdOriginal = v; if (v || !stages.length) canvas.hidden = true; else renderNow(); },
    // для меню: сколько уровень займёт при текущем исходнике. load: 'ok' — с запасом, 'heavy' — успевает, но
    // видеокарта почти без запаса, 'no' — не успеет (кадры будут пропадать), null — ещё не знаем
    tierInfo(t) {
      const n = need || computeNeed();
      if (!n || !n.passes) return { load: null };
      const id = styled(picked(t, n.cls), sharpness(), n.cls);
      const ms = modelMs(id, n);
      return { load: loadOf(ms), ms, model: modelName(id), cls: n.cls, srcH: n.srcH };
    },
    destroy() {
      destroyed = true; stopLoop(); ro.disconnect(); video.removeEventListener('loadedmetadata', onSource);
      clearStages(); probe.destroy(); clearTimeout(retryTimer); if (presenter) presenter.destroy(); canvas.remove();
    },
  };
}
