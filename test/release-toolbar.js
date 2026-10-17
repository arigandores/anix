require('./_failfast');
// Шапка страницы релиза: колокольчик и «Ещё» видны с первого кадра (пока страница грузится) и после загрузки
// не пересоздаются — раньше они появлялись только с данными и сдвигали «Смотреть вместе».
// Запуск: npx electron test/release-toolbar.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await settle(js, 4000);
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const scr = () => document.querySelector('#viewport .screen[data-screen="release"]');
    const seen = []; let bell0 = null; let same = true;
    (await import('/js/router.js')).navigate('release', { id: 21 });
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      const s = scr();
      const bar = s && s.querySelector('.appbar');
      if (bar) {
        const titles = [...bar.querySelectorAll('.actions > button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.title).join(' | ');
        if (seen.at(-1) !== titles) seen.push(titles);
        const bell = bar.querySelector('button[title="Уведомления о новых сериях"]');
        if (bell && !bell0) bell0 = bell; else if (bell0 && bell !== bell0) same = false;
        if (s.querySelector('.rel-title') && !s.querySelector('.sk')) break;
      }
      await sleep(20);
    }
    return { seen, same, loaded: !!scr()?.querySelector('.rel-title') };
  })()`);
  check(r.loaded, 'страница релиза загрузилась');
  check(r.seen.length === 1 && r.seen[0].includes('Уведомления о новых сериях') && r.seen[0].includes('Ещё'),
    `кнопки шапки с первого кадра и до загрузки одни и те же: ${r.seen.map((x) => `[${x}]`).join(' → ')}`);
  check(r.same, 'колокольчик не пересоздаётся при загрузке');
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
