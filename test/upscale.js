'use strict';
// Улучшение картинки (апскейл нейросетью, public/js/upscale/): модели на синтетическом кадре и плеер на реальной серии.
// Окно — offscreen с 60 к/с: в скрытом окне браузер рисует раз в секунду, и плавность не проверить.
// Профиль Electron чистый, вход в Anixart не выполняется — аккаунт не затрагивается.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODELS = fs.readdirSync(path.join(__dirname, '..', 'public', 'models', 'upscale')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

// ошибка любого шага — сразу FAIL и выход, а не ожидание тайм-аута
app.whenReady().then(() => main().catch((e) => { console.log(`FAIL исключение: ${e && e.message}`); app.exit(1); }));
async function main() {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1700, height: 1000, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setFrameRate(60);
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || /\[upscale\]/.test(e.message)) errors.push(String(e.message).slice(0, 300)); });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const fails = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };

  // --- 1. Модели: кадр 640x360 -> 1280x720; уменьшенный обратно результат должен совпадать с кадром ---
  for (const id of MODELS) {
    const r = await js(`(async () => {
      const E = await import('/js/upscale/engine.js');
      const { device } = await E.getGpu();
      const errs = []; device.onuncapturederror = (e) => errs.push(e.error.message.slice(0, 200));
      const spec = await E.loadModel(${JSON.stringify(id)});
      const up = await E.createUpscaler(spec);
      const W = 640, H = 360;
      const cv = new OffscreenCanvas(W, H); const cx = cv.getContext('2d');
      const g = cx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#f4d2a0'); g.addColorStop(1, '#3a6ea5');
      cx.fillStyle = g; cx.fillRect(0, 0, W, H);
      cx.strokeStyle = '#141418'; cx.lineWidth = 3; for (let i = 0; i < 12; i++) { cx.beginPath(); cx.arc(320, 180, 20 + i * 14, 0, 6.2); cx.stroke(); }
      cx.fillStyle = '#e83a5a'; cx.fillRect(40, 40, 120, 80);
      const src = cx.getImageData(0, 0, W, H).data;
      const frame = new VideoFrame(cv, { timestamp: 0 });
      up.setSize(W, H);
      const W2 = W * 2, H2 = H * 2, bpr = Math.ceil(W2 * 8 / 256) * 256;
      const rb = device.createBuffer({ size: bpr * H2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder(); up.encode(enc, frame);
      enc.copyTextureToBuffer({ texture: up.output }, { buffer: rb, bytesPerRow: bpr }, [W2, H2]);
      device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const u16 = new Uint16Array(rb.getMappedRange().slice(0)); rb.unmap(); frame.close(); up.destroy();
      const h2f = (hb) => { const s = hb & 0x8000 ? -1 : 1; const e = (hb >> 10) & 31; const m = hb & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15); };
      const C = spec.in === 'luma' ? 1 : 3;
      let se = 0, n = 0, bad = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < C; c++) {
        let v = 0; for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) v += h2f(u16[(y * 2 + dy) * bpr / 2 + (x * 2 + dx) * 4 + c]) / 4;
        if (!isFinite(v)) { bad++; continue; }
        const p = (y * W + x) * 4;
        const ref = C === 1 ? (0.2126 * src[p] + 0.7152 * src[p + 1] + 0.0722 * src[p + 2]) / 255 : src[p + c] / 255;
        se += (Math.min(1, Math.max(0, v)) - ref) ** 2; n++;
      }
      return { psnr: +(10 * Math.log10(1 / (se / n))).toFixed(1), bad, errs };
    })()`);
    check(r.bad === 0 && !r.errs.length && r.psnr > 26, `модель ${id}: PSNR после обратного уменьшения ${r.psnr} дБ, NaN ${r.bad}${r.errs.length ? ', ошибки ' + r.errs.join('; ') : ''}`);
  }

  // --- 2. Плеер: «Атака титанов 3», Kodik 720p ---
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
  // окно «Подобрать модели под видеокарту?» здесь не нужно (бенчмарк — в upscale-trt.js): «Позже»
  await js(`(async () => { const { getGpu } = await import('/js/upscale/engine.js'); const { gpuKey } = await import('/js/upscale/bench.js');
    localStorage.setItem('anixart.pref.UPSCALE_BENCH_LATER', JSON.stringify(gpuKey((await getGpu()).info) + '|false')); })()`);
  const st = () => js(`(() => { const ov = document.querySelector('.player-overlay'); const d = ov.upscale.debug; const c = document.querySelector('.up-canvas');
    const q = ov.querySelector('video').getVideoPlaybackQuality();
    return { mode: ov.upscale.mode, status: ov.upscale.status.text, stages: d.stages, canvas: !c.hidden, drawn: d.drawn, total: q.totalVideoFrames, dropped: q.droppedVideoFrames, ms: Math.round(d.lastMs) }; })()`);
  const openUp = () => js(`(() => { if (!document.querySelector('.player-menu')) document.querySelector('.player-controls .gear').click();
    [...document.querySelectorAll('.player-menu .pm-row')].find((x) => /Улучшение/.test(x.textContent)).click(); })(); 1`);
  const pick = (label) => js(`[...document.querySelectorAll('.player-menu .pm-opt')].find((x) => x.innerText.split('\\n')[0].trim() === ${JSON.stringify(label)}).click(); 1`);
  const closeMenu = () => js(`document.querySelector('.player-menu') && document.querySelector('.player-controls .gear').click(); 1`);
  const waitStages = async () => { await sleep(500); let x; for (let i = 0; i < 60; i++) { x = await st(); if (x.stages.length && !(await js(`document.querySelector('.player-overlay').upscale.debug.building`))) break; await sleep(250); } return x; };
  const key = async (k, up = true) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k }); if (up) win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(250); };

  let s = await st();
  check(s.mode === 'off' && !s.canvas, `по умолчанию выключено (режим ${s.mode}, холст ${s.canvas})`);
  await openUp();
  const rows = await js(`[...document.querySelectorAll('.player-menu .pm-opt')].map((x) => x.innerText.split('\\n')[0].trim()).join(', ')`);
  check(rows.startsWith('Выключено, Авто, Лёгкое, Сильное, Максимальное'), `варианты в меню: ${rows}`);
  await pick('Авто'); await closeMenu();
  await sleep(6000);
  const a0 = await st(); await sleep(5000); const a1 = await st();
  const drawn = a1.drawn - a0.drawn; const total = a1.total - a0.total;
  check(a1.canvas && /→/.test(a1.status), `«Авто»: ${a1.status}`);
  console.log('   журнал «Авто»:', (await js(`document.querySelector('.player-overlay').upscale.debug.trail`)).join(' | '));
  check(total > 90 && drawn >= total * 0.9 && a1.dropped - a0.dropped === 0, `«Авто» плавно: кадров ${total}, улучшено ${drawn}, пропущено ${a1.dropped - a0.dropped}`);
  await openUp();
  const note = await js(`document.querySelector('.player-menu .pm-note').innerText`);
  check(/→/.test(note) && /мс/.test(note), `строка состояния в меню: ${note.replace(/\n/g, ' | ')}`);
  // «настоящее» разрешение по кадрам (native.js, в воркере): оценка появляется за первые ~20 с и запоминается
  // для источника (тайтл:озвучка:качество); замеры шли во время проверки плавности выше
  let nat = null;
  for (let i = 0; i < 60 && !(nat && nat.n >= 10); i++) { await sleep(500); nat = await js(`document.querySelector('.player-overlay').upscale.native`); }
  check(nat && nat.blur > 0.5 && nat.blur < 3.5 && nat.eff > 200 && nat.eff <= 720, `оценка разрешения: ${nat ? `размытие ${nat.blur.toFixed(2)}, ≈${nat.eff}p, кадров ${nat.n}, разброс ${nat.spread.toFixed(2)}` : 'нет'}`);
  const cached = await js(`Object.keys(JSON.parse(localStorage.getItem('anixart.pref.UPSCALE_NATIVE') || '{}'))`);
  check(cached.some((k) => /^2487:\d+:\w+\|\d+x\d+$/.test(k)), `оценка запомнена для источника: ${cached.join(', ') || 'нет'}`);
  // меню не перестраивается от замеров: строки те же (hover не мигает), строка состояния обновляется на месте
  await js(`document.querySelector('.player-menu .pm-opt').dataset.mark = '1'; 1`);
  await sleep(2000);
  check(await js(`document.querySelector('.player-menu .pm-opt').dataset.mark === '1'`), 'меню улучшения не пересоздаётся во время работы');
  // страница «Качество» не закрывается сама, пока работает улучшение
  await js(`document.querySelector('.player-menu .pm-head').click(); [...document.querySelectorAll('.player-menu .pm-row')].find((x) => /Качество/.test(x.textContent)).click(); 1`);
  await sleep(2000);
  check(await js(`(document.querySelector('.player-menu .pm-head') || {}).textContent === 'Качество'`), 'страница «Качество» остаётся открытой');
  await closeMenu();
  // перегрузка: на скорости ×2 «Максимальное» может не успевать — ручной выбор не меняется; если не успевает —
  // одно уведомление и метка «не успевает» в строке состояния
  await openUp(); await pick('Максимальное'); await closeMenu();
  const before = (await waitStages()).stages.join('+');
  await js(`document.querySelector('.player-overlay video').playbackRate = 2; 1`);
  let toastSeen = '';
  for (let i = 0; i < 24; i++) { await sleep(250); toastSeen = toastSeen || await js(`(() => { const t = document.getElementById('toast'); return t && t.classList.contains('show') && /видеокарт/i.test(t.textContent) ? t.textContent : ''; })()`); }
  await openUp();
  const after = await st();
  const checked = await js(`(document.querySelector('.player-menu .pm-opt.on') || {}).innerText?.split('\\n')[0]`);
  check(after.mode === 'max' && checked === 'Максимальное' && after.stages.join('+') === before && JSON.parse(await js(`localStorage.getItem('anixart.pref.UPSCALE_MODE')`)) === 'max',
    `перегрузка «Максимального»: режим ${after.mode}, отмечено «${checked}», модель ${after.stages.join('+')} (была ${before}, ${after.ms} мс)`);
  const slowNow = /не успевает/.test(after.status);
  check(slowNow ? /Максимальное/.test(toastSeen) : !toastSeen, `ручной уровень: ${slowNow ? `не успевает — уведомление «${toastSeen}»` : `успевает (${after.ms} мс) — без уведомления`}`);
  await js(`document.querySelector('.player-overlay video').playbackRate = 1; 1`);
  await pick('Лёгкое'); await closeMenu(); await sleep(2500);
  s = await st();
  check(/^artcnn/.test(s.stages[0] || ''), `«Лёгкое» — ArtCNN (${s.stages.join('+')}, ${s.ms} мс)`);
  // шторка, удержание C, клавиша U
  await openUp();
  await js(`[...document.querySelectorAll('.player-menu label.pm-row')].find((x) => /Сравнить/.test(x.textContent)).querySelector('input').click(); 1`);
  await closeMenu(); await sleep(400);
  check(await js(`!document.querySelector('.up-split').hidden`), 'шторка сравнения видна');
  await key('C', false);
  check(!(await st()).canvas, 'удержание C — оригинал');
  await key('C');
  await sleep(300);
  check((await st()).canvas, 'C отпущена — снова улучшено');
  await key('U');
  s = await st();
  check(s.mode === 'off' && !s.canvas && (await js(`document.querySelector('.up-split').hidden`)), 'U — выключить (и шторка спряталась)');
  await key('U'); await sleep(2500);
  s = await st();
  check(s.mode === 'fast' && s.canvas, `U — включить последний режим (${s.mode})`);
  // разрешение 4K для 720p: два прохода
  await js(`localStorage.setItem('anixart.pref.UPSCALE_TARGET', '"2160"'); document.querySelector('.player-overlay').upscale.setTarget('2160'); 1`);
  await sleep(3000);
  s = await st();
  check(s.stages.length === 2, `4K из 720p — два прохода (${s.stages.join(' + ')}, ${s.ms} мс)`);
  // закрытие
  await js(`document.querySelector('.player-top .icon-btn').click(); 1`);
  await sleep(500);
  check(!(await js(`!!document.querySelector('.up-canvas')`)), 'плеер закрыт — холст убран');
  check(!errors.length, `консоль без ошибок${errors.length ? ': ' + errors.join(' / ') : ''}`);

  console.log(fails.length ? `UPSCALE FAIL: ${fails.length}` : 'UPSCALE OK');
  srv.server.close(); app.exit(fails.length ? 1 : 0);
}
