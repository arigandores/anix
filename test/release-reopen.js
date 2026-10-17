require('./_failfast');
// Повторный заход на страницу аниме — сразу, без скелетона, каждый раз (раньше скелетон появлялся «через раз»:
// успеют ли данные за ожидание перехода, зависело от предзагрузки при наведении и скорости сети). Сеть замедлена
// до 600 мс — дольше ожидания перехода, поэтому первый заход со скелетоном, второй и третий — из памяти.
// Запуск: npx electron test/release-reopen.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await settle(js, 5000);
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const of = window.fetch;
    window.__bump = 0; // прибавка к числу «в избранном» в ответе сервера — «данные изменились, пока страница в памяти»
    window.fetch = async (u, o) => {
      const url = String(u.url || u);
      if (url.includes('/api/')) await sleep(600);
      const r = await of(u, o);
      if (window.__bump && url.split('?')[0].endsWith('release/21')) { const j = await r.clone().json(); if (j.release) j.release.favorites_count += window.__bump; return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } }); }
      return r;
    };
    const router = await import('/js/router.js');
    // заход: был ли виден скелетон на экране релиза, пока он открывался
    const open = async () => {
      router.navigate('release', { id: 21 });
      let sk = false; const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        const s = document.querySelector('#viewport .screen:last-child');
        if (s?.dataset.screen === 'release') {
          if (s.querySelector('.sk-root, .sk')) sk = true;
          if (s.querySelector('.rel-body .info-rows .info-row') && !s.querySelector('.sk-root, .sk')) break;
        }
        await sleep(16);
      }
      history.back(); await sleep(900);
      return sk;
    };
    const res = [await open(), await open(), await open()];
    // данные изменились: страница из памяти показывается сразу и сама обновляется, когда придут свежие
    window.__bump = 5;
    router.navigate('release', { id: 21 });
    const favNow = () => document.querySelector('#viewport .screen:last-child .rel-actions .list-btn:nth-child(2)')?.textContent.replace(/[^0-9]/g, '');
    await sleep(150); const before = favNow();
    // точечно, а не пересборкой: шапка, сердце и полосы рейтинга — те же элементы
    const scr0 = document.querySelector('#viewport .screen:last-child');
    const heroEl = scr0.querySelector('.rel-hero'); const heartEl = scr0.querySelector('.rel-actions .lt'); const ratingFill = scr0.querySelector('.rating-bar .fill');
    let after = before; const t0 = Date.now();
    while (Date.now() - t0 < 4000 && after === before) { await sleep(50); after = favNow(); }
    res.push({ before, after, same: heroEl.isConnected && heartEl.isConnected && (!ratingFill || ratingFill.isConnected) });
    history.back(); await sleep(900); window.__bump = 0;
    // другой аккаунт: память очищена — личные поля прежнего не показываются (заход снова со скелетоном)
    window.dispatchEvent(new CustomEvent('auth-changed'));
    // смена аккаунта перестраивает главную — переход открываем, когда она собралась
    const t1 = Date.now(); while (Date.now() - t1 < 6000 && (document.querySelector('#viewport .screen:last-child .sk-root, #viewport .screen:last-child .sk') || Date.now() - t1 < 500)) await sleep(50);
    res.push(await open());
    return res;
  })()`);
  check(r[0] === true, `первый заход при медленной сети — со скелетоном (${r[0]})`);
  check(r[1] === false && r[2] === false, `второй и третий заход — сразу, без скелетона (${r[1]}, ${r[2]})`);
  check(r[3].same, 'обновление точечное: шапка, сердце и полосы рейтинга не пересобраны');
  check(r[3].before && Number(r[3].after) === Number(r[3].before) + 5, `данные изменились — показанная из памяти страница обновилась сама (${r[3].before} → ${r[3].after})`);
  check(r[4] === true, 'смена аккаунта очищает память — заход снова загружает данные');
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
