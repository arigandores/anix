'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Плеер на паузе: посреди экрана — «Продолжить» (круглая ▶). Нажали — серия идёт, кнопка ушла. Как и раньше,
// продолжить можно тапом по любому месту экрана. Пробел — то же. Нажатие по кнопке до жестов экрана не доходит
// (двойное нажатие по ней — не полный экран). Мини-плеер — без неё, развернули на паузе — снова она.
// Пока грузится (крутилка) — её нет. Снимок — test/shots/player-center.png. Окно offscreen с 60 к/с.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (js, cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(cond)) return true; await sleep(150); } return false; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const fails = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
  const finish = () => { srv.server.close(); app.exit(fails.length ? 1 : 0); };
  const win = new BrowserWindow({ width: 1280, height: 800, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setFrameRate(60);
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`localStorage.clear(); localStorage.setItem('anixart.theme','dark'); localStorage.setItem('anixart.pref.SELECTED_PLAYER','2'); localStorage.setItem('anixart.pref.ON_EPISODE_DISCLAIMER','true'); 1`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await until(js, '!!document.querySelector("#rail .nav-item")', 8000);
  await js(`(async () => { const { A } = await import('/js/api.js');
    const types = (await A.types(2487)).types; const ty = types.find((x) => x.name === 'Studio Band') || types[0];
    const so = (await A.sources(2487, ty.id)).sources.find((s) => /kodik/i.test(s.name));
    (await import('/js/router.js')).navigate('episodes', { release: { id: 2487, title_ru: 'Атака титанов 3' }, type: ty, source: so }); })(); 1`);
  if (!(await until(js, `[...document.querySelectorAll('#viewport > .screen:last-child .ep-row')].some((r) => !r.closest('.skeleton, .sk-root'))`, 15000))) { check(false, 'список серий'); finish(); return; }
  await js(`[...document.querySelectorAll('#viewport > .screen:last-child .ep-row')].find((r) => !r.closest('.skeleton, .sk-root')).click(); 1`);
  if (!(await until(js, `(document.querySelectorAll('.backdrop').forEach((b) => b.querySelector('.sheet-item')?.click()), !!document.querySelector('.player-overlay video') && document.querySelector('.player-overlay video').readyState >= 3)`, 30000))) { check(false, 'серия загрузилась'); finish(); return; }
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.muted = true; v.currentTime = 120; v.play(); })(); 1`);
  await until(js, `!document.querySelector('.player-overlay video').paused && document.querySelector('.player-overlay video').readyState >= 3`, 10000);
  await sleep(500);
  const st = () => js(`(() => { const v = document.querySelector('.player-overlay video'); const b = document.querySelector('.p-center'); const r = b.getBoundingClientRect(); const s = document.querySelector('.player-stage').getBoundingClientRect();
    return { paused: v.paused, show: b.classList.contains('show'), op: Number(getComputedStyle(b).opacity), cx: Math.round(r.left + r.width / 2 - (s.left + s.width / 2)), cy: Math.round(r.top + r.height / 2 - (s.top + s.height / 2)), w: Math.round(r.width), fs: !!document.fullscreenElement }; })()`);
  const settleAnim = () => sleep(400);

  let s = await st();
  check(!s.paused && !s.show, `идёт — кнопки нет (${JSON.stringify(s)})`);
  // пауза пробелом — посреди экрана «Продолжить»
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); 1`);
  await settleAnim(); s = await st();
  if (!s.paused) { await js(`document.querySelector('.player-overlay video').pause(); 1`); await settleAnim(); s = await st(); }
  check(s.paused && s.show && s.op > 0.95 && Math.abs(s.cx) <= 1 && Math.abs(s.cy) <= 1 && s.w === 76, `пауза — посреди экрана «Продолжить» (${JSON.stringify(s)})`);
  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'shots', 'player-center.png'), (await win.webContents.capturePage()).toPNG());
  // нажали кнопку — серия идёт, кнопка ушла; двойное нажатие по ней — не полный экран (жесты экрана не ловят)
  await js(`document.querySelector('.p-center').click(); 1`);
  await settleAnim(); s = await st();
  check(!s.paused && !s.show && s.op < 0.05, `нажали «Продолжить» — идёт, кнопки нет (${JSON.stringify(s)})`);
  await js(`document.querySelector('.player-overlay video').pause(); 1`); await settleAnim();
  await js(`(() => { const b = document.querySelector('.p-center'); b.click(); })(); 1`); await sleep(120);
  await js(`document.querySelector('.player-overlay video').pause(); 1`); await sleep(50);
  await js(`document.querySelector('.p-center').click(); 1`); await sleep(500);
  s = await st();
  check(!s.fs && !s.paused, `два быстрых нажатия по кнопке — не полный экран (${JSON.stringify(s)})`);
  // тап по любому месту экрана — продолжить, как раньше
  await js(`document.querySelector('.player-overlay video').pause(); 1`); await settleAnim();
  await js(`(() => { const st = document.querySelector('.player-stage'); const r = st.getBoundingClientRect(); st.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.2 })); })(); 1`);
  await sleep(500); s = await st();
  check(!s.paused && !s.show, `пауза, тап по экрану мимо кнопки — продолжается (${JSON.stringify(s)})`);
  // мини-плеер — без кнопки; развернули на паузе — она снова
  await js(`document.querySelector('.player-overlay video').pause(); document.querySelector('.player-overlay').mini(true); 1`); await settleAnim();
  s = await st();
  check(s.paused && !s.show, `мини-плеер на паузе — без кнопки посреди (${JSON.stringify(s)})`);
  await js(`document.querySelector('.player-overlay').mini(false); 1`); await settleAnim();
  s = await st();
  check(s.paused && s.show, `развернули на паузе — кнопка снова (${JSON.stringify(s)})`);
  // крутилка загрузки — кнопки нет
  const spin = await js(`(() => { document.querySelector('.player-overlay video').dispatchEvent(new Event('waiting')); return document.querySelector('.p-center').classList.contains('show'); })()`);
  check(!spin, 'пока грузится (крутилка) — кнопки нет');
  finish();
});
