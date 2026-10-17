require('./_failfast');
// Пустые экраны и «не найдено» — по центру всей области экрана, чуть выше середины (оптический центр). Раньше
// «Ничего не найдено» висело у верха, потом — по центру места под шапкой и смотрелось ниже середины окна.
// Ширина 1180 и 420. Запуск: npx electron test/empty-center.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CASES = [
  ['поиск без результатов', "r.navigate('search', { query: 'zzqxwvkjhqq' })"],
  ['релиз не найден', "r.navigate('release', { id: 99999999 })"],
  ['профиль не найден', "r.navigate('profile', { id: 999999999 })"],
];
// середина содержимого заглушки (иконка…подпись) против середины области экрана (#viewport): ожидается чуть
// выше — на подъём ui.js centerEmpties (4 % высоты, 16…40 px)
const MEASURE = `(() => {
  const scr = document.querySelector('#viewport .screen:last-child');
  const e = scr && scr.querySelector('.empty'); if (!e) return null;
  const kids = [...e.children].map((k) => k.getBoundingClientRect()).filter((b) => b.height);
  const top = Math.min(...kids.map((b) => b.top)); const bottom = Math.max(...kids.map((b) => b.bottom));
  const vp = document.getElementById('viewport').getBoundingClientRect();
  return { off: Math.round((top + bottom) / 2 - (vp.top + vp.bottom) / 2), freeH: Math.round(vp.height) };
})()`;

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1180, height: 800, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await settle(js, 4000);
  for (const W of [1180, 420]) {
    win.setContentSize(W, 800); await sleep(300);
    for (const [name, code] of CASES) {
      await js(`(async () => { const r = await import('/js/router.js'); ${code}; })()`);
      await sleep(300); await settle(js, 6000);
      const m = await js(MEASURE);
      check(m && m.off <= -10 && m.off >= -45, `${W}px, ${name}: по центру экрана, чуть выше середины (сдвиг ${m ? m.off : '—'} px, высота ${m ? m.freeH : '—'})`);
    }
  }
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
