'use strict';
// Открытие страницы релиза: когда появляется шапка (из preload карточки списка) и когда — полная страница.
// Плюс проверка предзагрузки при наведении и скриншот скелетона. Запуск: npx electron test/release-timing.js [папка]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(out, { recursive: true });

const OPEN = (rel, prefetch) => `(async () => {
  const r = await import('/js/router.js');
  ${prefetch ? `const a = await import('/js/api.js'); a.prefetchRelease(${rel.id}); await new Promise((ok) => setTimeout(ok, 400));` : ''}
  const t0 = performance.now();
  r.navigate('release', { id: ${rel.id}, preload: ${JSON.stringify(rel)} });
  const scr = document.querySelector('#viewport > .screen');
  let hero = 0, full = 0;
  await new Promise((ok) => { const tick = () => {
    const now = performance.now() - t0;
    if (!hero && scr.querySelector('.rel-hero .rel-title')) hero = now;
    if (!full && scr.querySelector('.rel-body .info-rows .info-row:not(:has(.sk))')) full = now;
    if ((hero && full) || now > 15000) ok(); else setTimeout(tick, 2); }; tick(); });
  return { hero: Math.round(hero), full: Math.round(full), took: Math.round(performance.now() - t0), state: full ? "" : (scr.querySelector(".empty-title")?.textContent || scr.innerHTML.slice(0, 160)) };
})()`;

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await sleep(4000);
  await js("localStorage.setItem('anixart.pref.IS_ADULT','true')");
  const rels = await js(`(async () => { const { A } = await import('/js/api.js'); return (await A.filter(0, {}, true)).content.slice(0, 6); })()`);
  const back = async () => { await js('history.back()'); await sleep(700); };
  for (const [i, rel] of rels.entries()) {
    const res = await js(OPEN(rel, i >= 3));
    console.log(`release ${rel.id}${i >= 3 ? ' (prefetched)' : ''}:`, JSON.stringify(res));
    await back();
  }
  // скриншот скелетона: ответ API задерживаем
  await js(`(() => { const of = window.fetch; window.__slow = true; window.fetch = async (u, o) => { if (window.__slow && String(u).includes('/api/release/')) await new Promise((ok) => setTimeout(ok, 4000)); return of(u, o); }; })()`);
  await js(`(async () => { const r = await import('/js/router.js'); r.navigate('release', { id: ${rels[0].id}, preload: ${JSON.stringify(rels[0])} }); })()`);
  await sleep(900); await win.webContents.capturePage(); await sleep(200);
  fs.writeFileSync(path.join(out, 'skeleton-release.png'), (await win.webContents.capturePage()).toPNG());
  await sleep(3800);
  fs.writeFileSync(path.join(out, 'skeleton-release-full.png'), (await win.webContents.capturePage()).toPNG());
  await back();
  // скелетон списка (вкладка «Обзор» и главная)
  await js(`(() => { const of = window.__of || window.fetch; window.__of = of; window.fetch = async (u, o) => { if (String(u).includes('/api/')) await new Promise((ok) => setTimeout(ok, 4000)); return of(u, o); }; })()`);
  await js(`(async () => { const r = await import('/js/router.js'); r.navigate('top', {}); })()`);
  await sleep(900); await win.webContents.capturePage(); await sleep(200);
  fs.writeFileSync(path.join(out, 'skeleton-list.png'), (await win.webContents.capturePage()).toPNG());
  srv.server.close();
  app.exit(0);
});
