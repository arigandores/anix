require('./_failfast');
'use strict';
// «Авто» улучшения картинки не выключается навсегда (жалоба: «ДжоДжо», AniLibria 1080p, после перемотки и пропуска
// опенинга картинка без улучшения, пока снова не нажмёшь «Авто»). Следующая ступень «Авто» бывает медленнее нынешней
// (ArtCNN на WebGPU и V3.1 на TensorRT), и снижение уводило в «ничего не успевает» без повтора.
// Скорость видеокарты в тесте задаётся: подмена device.queue.onSubmittedWorkDone растягивает кадр до нужного времени,
// замеры бенчмарка подставлены (нижняя ступень не успевает) — результат не зависит от нагрузки и модели видеокарты.
// Без бенчмарка и TensorRT: движок WebGPU, серия — настоящая, «Атака титанов 3», Kodik 720p.
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(() => main().catch((e) => { console.log(`FAIL исключение: ${e && e.message}`); app.exit(1); }));
async function main() {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1700, height: 1000, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setFrameRate(60);
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const fails = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
  const finish = () => { console.log(fails.length ? `UPSCALE-AUTO FAIL: ${fails.length}` : 'UPSCALE-AUTO OK'); srv.server.close(); app.exit(fails.length ? 1 : 0); };

  await js(`localStorage.clear(); localStorage.setItem('anixart.theme','dark'); localStorage.setItem('anixart.pref.SELECTED_PLAYER','2'); localStorage.setItem('anixart.pref.ON_EPISODE_DISCLAIMER','true'); 1`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(1500);
  // замеры: тяжёлые модели «не тянут», V3.1 Performance успевает, нижняя ступень (ArtCNN) в бюджет не влезает.
  // До открытия плеера: иначе «Авто» начнёт с прикидки и предложит бенчмарк
  await js(`(async () => {
    const { getGpu } = await import('/js/upscale/engine.js'); const { gpuKey } = await import('/js/upscale/bench.js'); const { MODELS } = await import('/js/upscale/catalog.js');
    const { device, info } = await getGpu();
    const ms = {}; for (const m of Object.values(MODELS)) for (const c of ['sd', 'hd', 'fhd']) ms[m.arch + '|' + c + '|gpu'] = m.arch === 'janai-v31-perf' ? 5 : m.arch === 'artcnn-c4f16' ? 1000 : -1;
    localStorage.setItem('anixart.pref.UPSCALE_BENCH', JSON.stringify({ key: gpuKey(info), trt: false, at: Date.now(), ms }));
    localStorage.setItem('anixart.pref.UPSCALE_MODE', JSON.stringify('auto'));
    // кадр занимает не меньше __gpuMs: «Авто» меряет именно это время
    const q = device.queue; const real = q.onSubmittedWorkDone.bind(q); window.__gpuMs = 0;
    q.onSubmittedWorkDone = () => { const t = performance.now(); const d = window.__gpuMs; return real().then(() => { const left = d - (performance.now() - t); return left > 0 ? new Promise((ok) => setTimeout(ok, left)) : undefined; }); };
  })()`);
  await js(`(async () => {
    const { A } = await import('/js/api.js');
    const types = (await A.types(2487)).types; const ty = types.find((x) => x.name === 'Studio Band') || types[0];
    const so = (await A.sources(2487, ty.id)).sources.find((s) => /kodik/i.test(s.name));
    (await import('/js/router.js')).navigate('episodes', { release: { id: 2487, title_ru: 'Атака титанов 3' }, type: ty, source: so });
  })(); 1`);
  await sleep(2500);
  await js(`document.querySelector('#viewport .screen:last-child .ep-row').click(); 1`);
  for (let i = 0; i < 80 && !(await js(`!!document.querySelector('.player-overlay video') && document.querySelector('.player-overlay video').readyState >= 2`)); i++) await sleep(250);
  await js(`document.querySelectorAll('.backdrop').forEach((b) => b.querySelector('.sheet-item')?.click()); 1`);
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.muted = true; v.currentTime = 300; v.play(); })(); 1`);

  const st = () => js(`(() => { const ov = document.querySelector('.player-overlay'); const d = ov.upscale.debug; const c = document.querySelector('.up-canvas');
    return { mode: ov.upscale.mode, state: ov.upscale.status.state, status: ov.upscale.status.text, stages: d.stages, canvas: !c.hidden, ms: Math.round(d.lastMs), trail: d.trail, cap: d.autoCap }; })()`);
  const until = async (test, max) => { const t = Date.now(); let s = await st(); while (!test(s) && Date.now() - t < max) { await sleep(100); s = await st(); } return s; };
  const working = (x) => x.stages.length > 0 && x.canvas;
  const overloads = (x) => x.trail.filter((l) => /перегрузка/.test(l)).length;

  let s = await until((x) => working(x) && x.state === 'on', 15000);
  check(working(s) && /^janai-v31-perf/.test(s.stages[0] || ''), `«Авто» выбрало V3.1 Performance: ${s.stages.join('+')} · ${s.status}`);
  if (!working(s)) { finish(); return; }

  // 1. Перемотка: кадры какое-то время не успевают (декодер, загрузка) — это не перегрузка видеокарты
  await js(`new Promise((ok) => { const v = document.querySelector('.player-overlay video'); window.__gpuMs = 300;
    v.addEventListener('seeked', () => setTimeout(() => { window.__gpuMs = 0; ok(1); }, 1800), { once: true }); v.currentTime += 85; })`);
  await sleep(1200);
  s = await st();
  check(overloads(s) === 0 && working(s), `после перемотки перегрузки нет, модель на месте: ${s.stages.join('+') || 'выключено'}; ${s.trail.slice(-2).join(' · ')}`);

  // 2. Запас мал (90–95% времени кадра), а легче модели нет: улучшение остаётся. На скорости ×0.125 кадр 334 мс:
  // окно 300–317 мс шире, чем запаздывание таймера подмены (на ×0.25 окно 8 мс — таймер опаздывал и на 9)
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.playbackRate = 0.125; window.__gpuMs = 302; })(); 1`);
  s = await until((x) => overloads(x) > 0 || !working(x), 15000);
  await sleep(3000);
  s = await st();
  check(overloads(s) > 0, `при 302 мс на кадр «Авто» видит перегрузку (${s.ms} мс)`);
  check(working(s), `легче модели нет, кадры успевают — улучшение осталось: ${s.stages.join('+') || 'выключено'} · ${s.status}`);

  // 3. Кадры и правда не успевают: улучшение отступает, но возвращается само, когда видеокарта освободилась
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.playbackRate = 1; window.__gpuMs = 300; document.querySelector('.player-overlay').upscale.setMode('auto'); })(); 1`);
  s = await until((x) => !x.stages.length && x.state === 'idle', 12000);
  check(!s.stages.length && s.state === 'idle', `кадр 300 мс: улучшение отступило — ${s.status}`);
  await js(`window.__gpuMs = 0; 1`);
  s = await until((x) => working(x) && x.state === 'on', 26000);
  check(working(s) && s.mode === 'auto', `видеокарта освободилась — «Авто» вернулось само, без нажатий: ${s.stages.join('+') || 'выключено'} · ${s.status}`);
  finish();
}
