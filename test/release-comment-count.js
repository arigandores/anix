require('./_failfast');
// Число комментариев на странице аниме: у части релизов сервер присылает в comment_count длину превью (5), а не всё
// число — у «Невероятного приключения ДжоДжо» (1387) было «5» при тысячах комментариев. Страница сверяет такое число
// с total_count списка комментариев. У релиза с честным числом (21, «Мастер Муси») — без изменений.
// Запуск: npx electron test/release-comment-count.js
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
  // число на кнопке «Комментарии» страницы и total_count первой страницы списка (для сверки)
  const probe = (id) => js(`(async () => {
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const { A } = await import('/js/api.js');
    const total = (await A.releaseComments(${id}, 0, 1)).total_count;
    (await import('/js/router.js')).navigate('release', { id: ${id} });
    const num = () => {
      const s = document.querySelector('#viewport .screen[data-screen="release"]:last-child');
      const btn = s && !s.querySelector('.sk') && [...s.querySelectorAll('.rel-actions .list-btn')].find((b) => b.querySelector('.ic')?.outerHTML.includes('comment'));
      return btn ? Number(btn.textContent.replace(/\\D/g, '')) : null;
    };
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 && num() !== total) await sleep(50);
    return { total, shown: num() };
  })()`);
  for (const id of [1387, 21]) {
    const r = await probe(id);
    check(r.total > 0 && r.shown === r.total, `релиз ${id}: на кнопке ${r.shown}, комментариев ${r.total}`);
    await js(`history.back(); 1`); await new Promise((ok) => setTimeout(ok, 400));
  }
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
