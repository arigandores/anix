require('./_failfast');
// Шапка релиза: полупрозрачные кнопки и бейджи не меняют цвет, когда заканчивается въезд экрана. С backdrop-filter
// под ними Chromium, пока у экрана идёт анимация прозрачности, размывал другой фон — после въезда кнопки темнели.
// Анимация въезда ставится на паузу у самого конца (экран почти непрозрачен), цвет кнопки сравнивается с цветом
// после конца анимации. С тех пор как въезжает контент под шапкой (а не весь экран), исходная ошибка не
// воспроизводится и с backdrop-filter — тест охраняет сам инвариант (цвет не меняется после въезда).
// Запуск: npx electron test/hero-backdrop.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 700, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`localStorage.setItem('anixart.theme','dark')`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await settle(js, 4000);
  // страница релиза уже загружена (данные в кэше) — при повторном входе экран въезжает с готовым контентом
  await js(`(async () => { const { A } = await import('/js/api.js'); await A.release(21, true); })()`);
  const p = await js(`(async () => {
    const until = async (fn, max = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); } return null; };
    (await import('/js/router.js')).navigate('release', { id: 21 });
    const scr = await until(() => document.querySelector('#viewport .screen[data-screen="release"]'));
    // въезд — у контента под шапкой (router.js, app.css): все его анимации — на паузу у самого конца
    const anims = await until(() => { const a = scr.getAnimations({ subtree: true }).filter((x) => x.id === 'screen-forward' || x.animationName === 'screen-forward'); return a.length ? a : null; });
    if (!anims) return null;
    anims.forEach((a) => { a.pause(); a.currentTime = a.effect.getTiming().duration - 1; });
    const btn = await until(() => scr.querySelector('.rel-actions .list-btn:not(.tag)'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // фон за постером проявляется после загрузки картинки (release.js heroBg) — сравниваем кнопку на готовом фоне
    await until(() => scr.querySelector('.rel-hero .bg.ready')); await new Promise((r) => setTimeout(r, 650));
    const b = btn.getBoundingClientRect(); window.__anims = anims;
    return { x: Math.round(b.x + 5), y: Math.round(b.y + b.height / 2) };
  })()`);
  if (!p) { check(false, 'нет анимации въезда экрана релиза'); app.exit(1); return; }
  await sleep(300);
  const px = async () => { const bm = (await win.webContents.capturePage({ x: p.x, y: p.y, width: 1, height: 1 })).toBitmap(); return [bm[2], bm[1], bm[0]]; };
  const during = await px();
  await js('window.__anims.forEach((a) => a.finish())'); await sleep(300);
  const after = await px();
  const diff = Math.max(...during.map((v, i) => Math.abs(v - after[i])));
  check(diff <= 2, `кнопка в конце въезда rgb(${during}) и после rgb(${after}) — разница ${diff} (не больше 2)`);
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
