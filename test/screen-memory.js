require('./_failfast');
// Память экранов (api.js remembered): профиль, коллекция (шапка и первая страница релизов), «Популярное» — повторный
// заход сразу, без скелетона (сеть замедлена до 600 мс); изменившиеся данные приходят фоном и обновляют экран;
// смена аккаунта память очищает. Запуск: npx electron test/screen-memory.js
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
    const of = window.fetch; window.__rename = '';
    window.fetch = async (u, o) => {
      const url = String(u.url || u);
      if (url.includes('/api/')) await sleep(600);
      const res = await of(u, o);
      // «данные изменились»: другое название коллекции в ответе сервера
      if (window.__rename && url.split('?')[0].endsWith('collection/1')) { const j = await res.clone().json(); if (j.collection) j.collection.title = window.__rename; return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } }); }
      return res;
    };
    const router = await import('/js/router.js');
    const open = async (name, params) => {
      router.navigate(name, params);
      // ждём полной загрузки экрана (и вложенных блоков: блог профиля, релизы коллекции) — без индикаторов 1 с подряд
      let sk = false; let calm = 0; const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const s = document.querySelector('#viewport .screen:last-child');
        if (s?.dataset.screen === name) {
          if (s.querySelector('.sk-root, .sk')) sk = true;
          if (!s.querySelector('.sk-root, .sk, .spinner-wrap, .load-reveal')) { calm += 16; if (calm >= 1000) break; } else calm = 0;
        }
        await sleep(16);
      }
      return sk;
    };
    const back = async () => { history.back(); await sleep(900); };
    const out = {};
    for (const [name, params] of [['profile', { id: 1 }], ['collection', { id: 1 }], ['top', {}]]) {
      const first = await open(name, params); await back();
      const again = await open(name, params); await back();
      out[name] = { first, again };
    }
    // изменились данные: показанная из памяти коллекция обновляется сама
    window.__rename = 'Название из теста';
    router.navigate('collection', { id: 1 });
    // заголовок — тот же элемент (правка на месте, а не пересборка), смена — с анимацией
    let titleEl = null; const tq = Date.now(); while (Date.now() - tq < 3000 && !(titleEl = document.querySelector('#viewport .screen:last-child .rel-title'))) await sleep(16);
    const t0 = Date.now(); let renamed = false;
    while (Date.now() - t0 < 4000) { if (titleEl?.textContent === 'Название из теста') { renamed = true; out.titleAnimated = titleEl.getAnimations().length > 0; break; } await sleep(50); }
    out.renamed = renamed && titleEl.isConnected; window.__rename = ''; await back();
    // смена аккаунта: память очищена
    window.dispatchEvent(new CustomEvent('auth-changed'));
    const t1 = Date.now(); while (Date.now() - t1 < 6000 && (document.querySelector('#viewport .screen:last-child .sk-root, #viewport .screen:last-child .sk') || Date.now() - t1 < 500)) await sleep(50);
    out.afterAuth = await open('collection', { id: 1 }); await back();
    return out;
  })()`);
  for (const n of ['profile', 'collection', 'top']) {
    check(r[n].first === true, `${n}: первый заход при медленной сети — со скелетоном`);
    check(r[n].again === false, `${n}: повторный заход — сразу, без скелетона`);
  }
  check(r.renamed, 'изменились данные — показанная из памяти коллекция обновилась сама, на месте (тот же заголовок)');
  check(r.titleAnimated, 'изменение — плавное (анимация на изменившемся тексте)');
  check(r.afterAuth === true, 'смена аккаунта очищает память — заход снова загружает данные');
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
