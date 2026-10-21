'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Мини-плеер с улучшением картинки: «Развернуть» не показывает слой апскейла в старом месте. В мини-плеере апскейл
// не нужен (окно меньше серии) и снимается, после «Развернуть» собирается заново — слой виден только с кадром,
// нарисованным по новому размеру (раньше TensorRT считал первый кадр, а холст уже показывал старый кадр
// мини-плеера в углу). Проверка — каждый кадр 4 с после «Развернуть»: видимый холст во всю ширину картинки.
// Через TensorRT (если есть RTX и библиотеки) и через WebGPU. Окно — offscreen с 60 к/с.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.ANIX_TRT_DLLS = process.env.ANIX_TRT_DLLS || path.join(ROOT, 'trt', 'sdk', 'TensorRT-RTX-1.7.1.116', 'bin');
process.env.ANIX_TRT_CACHE = process.env.ANIX_TRT_CACHE || path.join(require('os').tmpdir(), 'anix-trt-test-cache');
const { start } = require('../server');
require('../electron/trt').register(ipcMain);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// условие в странице — с ограничением времени: true, когда выполнилось
const until = async (js, cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(cond)) return true; await sleep(150); } return false; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1700, height: 1000, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, preload: path.join(ROOT, 'electron', 'preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setFrameRate(60);
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const fails = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
  const finish = () => { srv.server.close(); app.exit(fails.length ? 1 : 0); };

  const trt = await js('window.anixartNative.trt ? window.anixartNative.trt.status() : { supported: false }');
  await js(`localStorage.clear(); localStorage.setItem('anixart.theme','dark'); localStorage.setItem('anixart.pref.SELECTED_PLAYER','2'); localStorage.setItem('anixart.pref.ON_EPISODE_DISCLAIMER','true'); 1`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await until(js, '!!document.querySelector("#rail .nav-item")', 8000);
  await js(`(async () => {
    const { A } = await import('/js/api.js');
    const types = (await A.types(2487)).types; const ty = types.find((x) => x.name === 'Studio Band') || types[0];
    const so = (await A.sources(2487, ty.id)).sources.find((s) => /kodik/i.test(s.name));
    (await import('/js/router.js')).navigate('episodes', { release: { id: 2487, title_ru: 'Атака титанов 3' }, type: ty, source: so });
  })(); 1`);
  if (!(await until(js, `[...document.querySelectorAll('#viewport .screen:last-child .ep-row')].some((r) => !r.closest('.skeleton, .sk-root'))`, 15000))) { check(false, 'список серий открылся'); finish(); return; }
  await js(`[...document.querySelectorAll('#viewport .screen:last-child .ep-row')].find((r) => !r.closest('.skeleton, .sk-root')).click(); 1`);
  // перед серией может спросить, с какого места продолжить, — первый пункт
  if (!(await until(js, `(document.querySelectorAll('.backdrop').forEach((b) => b.querySelector('.sheet-item')?.click()), !!document.querySelector('.player-overlay video') && document.querySelector('.player-overlay video').readyState >= 2)`, 30000))) {
    const why = await js(`(() => { const v = document.querySelector('.player-overlay video'); return { player: !!v, ready: v && v.readyState, src: v && (v.currentSrc || '').slice(0, 60), err: v && v.error && v.error.message, dialog: [...document.querySelectorAll('.backdrop')].map((b) => b.innerText.slice(0, 80)) }; })()`);
    check(false, `серия загрузилась ${JSON.stringify(why)}`); finish(); return;
  }
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.muted = true; v.currentTime = 300; v.play(); })(); 1`);
  await sleep(1000);

  // предложение бенчмарка закрываем «Позже»: здесь нужен только уровень, а не подбор моделей
  const st = () => js(`(() => { const ov = document.querySelector('.player-overlay'); const d = ov.upscale.debug; const c = document.querySelector('.up-canvas');
    [...document.querySelectorAll('.dialog .btn')].find((b) => /Позже/.test(b.textContent))?.click();
    return { stages: d.stages, canvas: !c.hidden, status: ov.upscale.status.text, mini: ov.classList.contains('mini') }; })()`);
  const waitFor = async (cond, ms = 30000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await st(); if (cond(s)) return { ok: true, s }; await sleep(200); } return { ok: false, s }; };

  async function scenario(label, isMine) {
    const ready = (x) => !x.mini && x.stages.length > 0 && isMine(x.stages[0]) && x.canvas;
    let w = await waitFor(ready);
    if (!w.ok) { check(false, `${label}: апскейл во весь размер (${JSON.stringify(w.s)})`); return; }
    await js(`document.querySelector('.player-overlay').mini(true); 1`);
    w = await waitFor((x) => x.mini && !x.stages.length && !x.canvas);
    if (!w.ok) { check(false, `${label}: в мини-плеере апскейл снят (${JSON.stringify(w.s)})`); return; }
    await sleep(800);
    await js(`(() => {
      const c = document.querySelector('.up-canvas'); const stage = c.parentElement; const v = stage.querySelector('video');
      window.__bad = []; window.__frames = 0; const t0 = performance.now();
      const tick = () => {
        window.__frames++;
        const k = Math.min(stage.clientWidth / v.videoWidth, stage.clientHeight / v.videoHeight); const want = v.videoWidth * k;
        const r = c.getBoundingClientRect();
        if (!c.hidden && Math.abs(r.width - want) > 2) window.__bad.push({ t: Math.round(performance.now() - t0), w: Math.round(r.width), want: Math.round(want) });
        if (performance.now() - t0 < 4000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })(); 1`);
    await js(`document.querySelector('.player-overlay').mini(false); 1`);
    w = await waitFor(ready);
    await until(js, 'window.__frames >= 230', 8000); // 4 с кадров после «Развернуть»
    const r = await js(`({ bad: window.__bad.slice(0, 4), n: window.__bad.length, frames: window.__frames })`);
    check(w.ok, `${label}: после «Развернуть» апскейл снова включился (${w.s.stages.join(' + ')})`);
    check(r.n === 0 && r.frames >= 100, `${label}: после «Развернуть» слой апскейла не мелькает в старом месте — кадров ${r.frames}, неверных ${r.n} ${r.n ? JSON.stringify(r.bad) : ''}`);
  }

  await js(`document.querySelector('.player-overlay').upscale.setMode('max'); 1`);
  if (trt.supported && trt.installed) {
    await js(`document.querySelector('.player-overlay').upscale.setTrt(true); 1`);
    await scenario('TensorRT', (id) => /:trt$/.test(id));
  } else console.log(`SKIP [upscale-mini] TensorRT: ${trt.supported ? 'нет библиотек' : 'нет поддержки'}`);
  await js(`document.querySelector('.player-overlay').upscale.setTrt(false); 1`);
  await scenario('WebGPU', (id) => !/:trt$/.test(id));
  finish();
});
