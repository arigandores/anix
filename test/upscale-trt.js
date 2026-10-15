'use strict';
// Ускорение NVIDIA (TensorRT, electron/trt.js + trt/anix-trt.exe) в плеере на реальной серии: тяжёлая модель
// через TensorRT, плавность, переключатель «Ускорение NVIDIA», цепочка TensorRT + ArtCNN для 4K, закрытие.
// Нужны NVIDIA RTX, собранный trt/bin/anix-trt.exe (node trt/build.js) и библиотеки TensorRT: по умолчанию —
// из SDK в trt/sdk (ANIX_TRT_DLLS переопределяет). Без них тест пропускается («UPSCALE-TRT SKIP»).
// Окно — offscreen с 60 к/с (в скрытом окне браузер рисует раз в секунду). Аккаунт Anixart не затрагивается.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.ANIX_TRT_DLLS = process.env.ANIX_TRT_DLLS || path.join(ROOT, 'trt', 'sdk', 'TensorRT-RTX-1.7.1.116', 'bin');
// движки TensorRT собираются по секунде-две на модель и размер: кэш общий между прогонами (профиль у теста свой)
process.env.ANIX_TRT_CACHE = process.env.ANIX_TRT_CACHE || path.join(require('os').tmpdir(), 'anix-trt-test-cache');
const { start } = require('../server');
require('../electron/trt').register(ipcMain);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ошибка любого шага — сразу FAIL и выход, а не ожидание тайм-аута
app.whenReady().then(() => main().catch((e) => { console.log(`FAIL исключение: ${e && e.message}`); app.exit(1); }));
async function main() {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1700, height: 1000, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, preload: path.join(ROOT, 'electron', 'preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setFrameRate(60);
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || /\[upscale\]/.test(e.message)) errors.push(String(e.message).slice(0, 300)); });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const fails = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
  const finish = (msg) => { console.log(msg); srv.server.close(); app.exit(fails.length ? 1 : 0); };

  const st0 = await js('window.anixartNative.trt ? window.anixartNative.trt.status() : { supported: false }');
  if (!st0.supported || !st0.installed || !fs.existsSync(path.join(ROOT, 'trt', 'bin', 'anix-trt.exe'))) {
    finish(`UPSCALE-TRT SKIP (${st0.supported ? 'нет библиотек TensorRT' : `нет поддержки: ${st0.reason || ''} ${st0.error || ''}`})`);
    return;
  }
  console.log(`видеокарта: ${st0.gpu}, compute ${st0.cc}`);

  await js(`localStorage.clear(); localStorage.setItem('anixart.theme','dark'); localStorage.setItem('anixart.pref.SELECTED_PLAYER','2'); localStorage.setItem('anixart.pref.ON_EPISODE_DISCLAIMER','true'); 1`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(2500);
  await js(`(async () => {
    const { A } = await import('/js/api.js');
    const types = (await A.types(2487)).types; const ty = types.find((x) => x.name === 'Studio Band') || types[0];
    const so = (await A.sources(2487, ty.id)).sources.find((s) => /kodik/i.test(s.name));
    (await import('/js/router.js')).navigate('episodes', { release: { id: 2487, title_ru: 'Атака титанов 3' }, type: ty, source: so });
  })(); 1`);
  await sleep(3500);
  await js(`document.querySelector('#viewport .screen:last-child .ep-row').click(); 1`);
  for (let i = 0; i < 60 && !(await js(`!!document.querySelector('.player-overlay video') && document.querySelector('.player-overlay video').readyState >= 2`)); i++) await sleep(250);
  await js(`document.querySelectorAll('.backdrop').forEach((b) => b.querySelector('.sheet-item')?.click()); 1`);
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.muted = true; v.currentTime = 300; v.play(); })(); 1`);
  await sleep(2000);
  const st = () => js(`(() => { const ov = document.querySelector('.player-overlay'); const d = ov.upscale.debug; const c = document.querySelector('.up-canvas');
    const q = ov.querySelector('video').getVideoPlaybackQuality();
    return { mode: ov.upscale.mode, status: ov.upscale.status.text, stages: d.stages, canvas: !c.hidden, drawn: d.drawn, total: q.totalVideoFrames, dropped: q.droppedVideoFrames, ms: Math.round(d.lastMs), failed: d.trtFailed }; })()`);
  const openUp = () => js(`(() => { if (!document.querySelector('.player-menu')) document.querySelector('.player-controls .gear').click();
    [...document.querySelectorAll('.player-menu .pm-row')].find((x) => /Улучшение/.test(x.textContent)).click(); })(); 1`);
  const pick = (label) => js(`[...document.querySelectorAll('.player-menu .pm-opt')].find((x) => x.innerText.split('\\n')[0].trim() === ${JSON.stringify(label)}).click(); 1`);
  const closeMenu = () => js(`document.querySelector('.player-menu') && document.querySelector('.player-controls .gear').click(); 1`);
  const trtSwitch = () => js(`[...document.querySelectorAll('.player-menu label.pm-row')].find((x) => /Ускорение NVIDIA/.test(x.textContent)).querySelector('input').click(); 1`);
  const waitFor = async (cond, ms = 15000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await st(); if (cond(s)) return s; await sleep(250); } return s; };

  // «Авто» -> предложение бенчмарка -> «Начать» -> прогресс -> «Авто» берёт лучший пресет, который успевает
  await openUp(); await pick('Авто'); await closeMenu();
  let prompt = false;
  for (let i = 0; i < 40 && !prompt; i++) { await sleep(500); prompt = await js(`[...document.querySelectorAll('.dialog-title')].some((x) => /Подобрать модели/.test(x.textContent))`); }
  check(prompt, 'при первом включении — «Подобрать модели под видеокарту?»');
  await js(`[...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent === 'Начать').click(); 1`);
  const tb = Date.now(); let progress = '';
  for (let i = 0; i < 600; i++) {
    await sleep(500);
    const d = await js(`(() => { const l = document.querySelector('.bench-label'); return l ? l.textContent : null; })()`);
    if (d) progress = d; else if (i > 4) break;
  }
  const bench = JSON.parse(await js(`localStorage.getItem('anixart.pref.UPSCALE_BENCH')`) || 'null');
  const trtCells = bench ? Object.keys(bench.ms).filter((k) => k.endsWith('|trt')).length : 0;
  check(!!bench && bench.trt && trtCells >= 12, `бенчмарк за ${Math.round((Date.now() - tb) / 1000)} с: замеров ${bench ? Object.keys(bench.ms).length : 0}, из них TensorRT ${trtCells} (последний шаг: ${progress})`);
  console.log('   720p:', bench && ['janai-v31-bal', 'janai-v3-compact', 'janai-v31-perf', 'anisd', 'artcnn-c4f16'].map((a) => `${a} ${Math.round(bench.ms[a + '|hd|gpu'])}/${Math.round(bench.ms[a + '|hd|trt'])} мс`).join(', '));
  let s0 = await waitFor((x) => /:trt$/.test(x.stages[0] || '') && x.canvas);
  // первый пресет списка для класса исходника (по кадрам серии) и «Обычно», который по бенчмарку успевает
  const best = await js(`(() => { const d = document.querySelector('.player-overlay').upscale.debug; const ok = d.auto.find((x) => x.ms != null && x.ms <= d.budget) || d.auto[d.auto.length - 1];
    return { id: ok.id, cls: d.need.cls, list: d.auto.map((x) => x.id + ' ' + Math.round(x.ms)).join(', '), budget: Math.round(d.budget) }; })()`);
  check((s0.stages[0] || '').replace(/:trt$/, '') === best.id, `«Авто» после проверки (${best.cls}): ${s0.stages.join(' + ')}, ждали ${best.id} — ${best.list} мс при бюджете ${best.budget}`);
  // пресеты ручного уровня с временем по бенчмарку; выбор SD Compact и «Резкость: Резче»
  await openUp(); await pick('Максимальное');
  await js(`[...document.querySelectorAll('.player-menu .pm-row')].find((x) => /^Модель/.test(x.innerText)).click(); 1`);
  const presets = await js(`[...document.querySelectorAll('.player-menu .pm-opt')].map((x) => x.innerText.split('\\n').join(' · ')).join(' | ')`);
  check(/Balanced/.test(presets) && /SD Compact/.test(presets) && /AniSD/.test(presets) && /мс/.test(presets), `пресеты «Максимального»: ${presets}`);
  await js(`[...document.querySelectorAll('.player-menu .pm-opt')].find((x) => /SD Compact/.test(x.innerText)).click(); 1`);
  s0 = await waitFor((x) => /^janai-sd-compact/.test(x.stages[0] || ''), 90000); // первая сборка движка TensorRT — дольше
  check(/^janai-sd-compact/.test(s0.stages[0] || ''), `выбран AnimeJaNai SD Compact: ${s0.stages.join(' + ')}`);
  await js(`[...document.querySelectorAll('.player-menu .pm-row')].find((x) => /^Модель/.test(x.innerText)).click(); 1`);
  await js(`[...document.querySelectorAll('.player-menu .pm-opt')].find((x) => /Balanced/.test(x.innerText)).click(); 1`);
  await js(`[...document.querySelectorAll('.player-menu .pm-row')].find((x) => /^Резкость/.test(x.innerText)).click(); 1`);
  await js(`[...document.querySelectorAll('.player-menu .pm-opt')].find((x) => /^Резче/.test(x.innerText)).click(); 1`);
  s0 = await waitFor((x) => /^janai-v31-bal-sharp/.test(x.stages[0] || ''));
  check(/^janai-v31-bal-sharp/.test(s0.stages[0] || ''), `«Резче» — Sharp1: ${s0.stages.join(' + ')}`);
  await js(`[...document.querySelectorAll('.player-menu .pm-row')].find((x) => /^Резкость/.test(x.innerText)).click(); 1`);
  await js(`[...document.querySelectorAll('.player-menu .pm-opt')].find((x) => /^Обычно/.test(x.innerText)).click(); 1`);
  await closeMenu();

  // «Максимальное» — через TensorRT
  await openUp();
  check(await js(`[...document.querySelectorAll('.player-menu .pm-row')].some((x) => /Ускорение NVIDIA/.test(x.textContent))`), 'в меню есть «Ускорение NVIDIA»');
  await pick('Максимальное'); await closeMenu();
  let s = await waitFor((x) => /:trt$/.test(x.stages[0] || '') && /TensorRT/.test(x.status));
  check(/:trt$/.test(s.stages[0] || '') && s.canvas, `«Максимальное» через TensorRT: ${s.stages.join(' + ')} · ${s.status}`);
  await sleep(2000);
  const a0 = await st(); await sleep(5000); const a1 = await st();
  const total = a1.total - a0.total; const drawn = a1.drawn - a0.drawn;
  check(total > 90 && drawn >= total * 0.9 && a1.dropped - a0.dropped === 0 && !a1.failed, `плавно: кадров ${total}, улучшено ${drawn}, пропущено ${a1.dropped - a0.dropped}, ${a1.ms} мс на кадр`);
  // переключатель: выкл — WebGPU, вкл — снова TensorRT
  await openUp(); await trtSwitch(); await closeMenu();
  s = await waitFor((x) => x.stages.length && !/:trt$/.test(x.stages[0]));
  check(!/:trt$/.test(s.stages[0] || ''), `ускорение выключено — WebGPU (${s.stages.join(' + ')})`);
  await openUp(); await trtSwitch(); await closeMenu();
  s = await waitFor((x) => /:trt$/.test(x.stages[0] || ''));
  check(/:trt$/.test(s.stages[0] || ''), 'включено снова — TensorRT');
  // 4K: TensorRT + второй проход ArtCNN на WebGPU по его результату
  await js(`document.querySelector('.player-overlay').upscale.setTarget('2160'); 1`);
  s = await waitFor((x) => x.stages.length === 2 && x.ms > 0, 15000);
  await sleep(1500); s = await st();
  check(s.stages.length === 2 && /:trt$/.test(s.stages[0]) && s.canvas && s.drawn > 0, `4K: ${s.stages.join(' + ')}, ${s.ms} мс`);
  // закрытие плеера
  await js(`document.querySelector('.player-top .icon-btn').click(); 1`);
  await sleep(800);
  check(!(await js(`!!document.querySelector('.up-canvas')`)), 'плеер закрыт — холст убран');
  check(!errors.length, `консоль без ошибок${errors.length ? ': ' + errors.join(' / ') : ''}`);
  finish(fails.length ? `UPSCALE-TRT FAIL: ${fails.length}` : 'UPSCALE-TRT OK');
}
