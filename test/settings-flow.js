'use strict';
// Настройки «Непроверенные источники» / «Альтернативное соединение» / «Режим экономии» и их эффект.
// Запуск: npx electron test/settings-flow.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails++; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const reload = async () => { await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); }); await sleep(3500); };
  const go = (code) => js(`(async () => { document.querySelectorAll('.backdrop').forEach(b => b.remove()); const r = await import('/js/router.js'); ${code} })()`);
  await js(`localStorage.clear(); localStorage.setItem('anixart.pref.IS_ADULT','true')`);
  await reload();

  // 1. Пункты в настройках
  await go(`r.navigate('settings', {})`); await sleep(800);
  const labels = await js(`[...document.querySelectorAll('.menu-item')].map(e => e.querySelector('.grow > div')?.textContent)`);
  for (const l of ['Запоминать вариант и источник', 'Непроверенные источники', 'Альтернативное соединение', 'Режим экономии ресурсов']) check(`настройки: «${l}»`, labels.includes(l));

  // 2. «Воспроизвести» → «Онлайн просмотр» → «Искать другие варианты» → подтверждение → варианты
  await go(`r.navigate('release', { id: 21 })`); await sleep(2500);
  await js(`document.querySelector('.btn-watch').click()`); await sleep(1800);
  check('Воспроизвести → Онлайн просмотр', await js(`document.querySelector('#viewport .screen').dataset.screen === 'streaming'`));
  const tpp = await js(`(() => { const it = [...document.querySelectorAll('#viewport .menu-item')].find(e => e.textContent.includes('Искать другие варианты')); it?.click(); return !!it; })()`);
  check('строка «Искать другие варианты»', tpp); await sleep(400);
  const dlg = await js(`document.querySelector('.dialog-title')?.textContent`);
  check('диалог «Подтверждение»', dlg === 'Подтверждение', dlg);
  await js(`[...document.querySelectorAll('.dialog-actions .btn')].find(b => b.textContent === 'Да, искать').click()`); await sleep(1500);
  check('→ экран вариантов', await js(`document.querySelector('#viewport .screen').dataset.screen === 'episodes'`));
  check('SEARCH_VIDEO_TPP и счётчик', await js(`localStorage.getItem('anixart.pref.SEARCH_VIDEO_TPP') === 'true' && localStorage.getItem('anixart.pref.COUNT_SKIP_STREAMING_PLATFORM') === '1'`));
  // на 4-м переходе предлагает запомнить
  await js(`localStorage.setItem('anixart.pref.COUNT_SKIP_STREAMING_PLATFORM', '4')`);
  await go(`r.navigate('streaming', { release: { id: 21 } })`); await sleep(1500);
  await js(`[...document.querySelectorAll('#viewport .menu-item')].find(e => e.textContent.includes('Искать другие варианты')).click()`); await sleep(400);
  check('диалог «Запомнить?»', await js(`document.querySelector('.dialog-title')?.textContent === 'Запомнить?'`));
  await js(`[...document.querySelectorAll('.dialog-actions .btn')].find(b => b.textContent === 'Да').click()`); await sleep(800);
  check('запомнено → IS_REMEMBERING_SKIP_THIRD_PARTY_PLATFORM', await js(`localStorage.getItem('anixart.pref.IS_REMEMBERING_SKIP_THIRD_PARTY_PLATFORM') === 'true'`));
  await go(`r.navigate('release', { id: 21 })`); await sleep(2500);
  await js(`document.querySelector('.btn-watch').click()`); await sleep(1500);
  check('с запоминанием «Воспроизвести» → сразу варианты', await js(`document.querySelector('#viewport .screen').dataset.screen === 'episodes'`));

  // 3. Альтернативное соединение: картинки и адреса из toggles — на зеркалах
  await js(`localStorage.setItem('anixart.pref.FORCE_SHOULD_USE_MIRROR_URLS', 'true')`);
  await reload();
  await go(`r.navigate('release', { id: 21 })`); await sleep(3500);
  const m = await js(`(() => { const im = document.querySelector('.rel-hero .poster img'); return { src: im?.src, w: im?.naturalWidth, base: window.__toggles?.baseUrl, iframe: localStorage.getItem('anixart.pref.IFRAME_EMBED_URL') }; })()`);
  check('постер с зеркала и загрузился', /\/\/mirror-[^/]*anixmirai\.com\//.test(m.src || '') && m.w > 0, `${m.src} w=${m.w}`);
  check('BASE_URL / IFRAME_EMBED_URL на зеркале', /mirror/.test(m.base || '') && /mirror/.test(m.iframe || ''), `${m.base} ${m.iframe}`);
  await js(`localStorage.removeItem('anixart.pref.FORCE_SHOULD_USE_MIRROR_URLS')`);

  // 4. Режим экономии
  await js(`localStorage.setItem('anixart.pref.ECONOMY_MODE', 'true')`);
  await reload();
  check('режим экономии: класс economy', await js(`document.documentElement.classList.contains('economy')`));
  await js(`localStorage.clear()`);

  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  srv.server.close();
  app.exit(fails ? 1 : 0);
});
