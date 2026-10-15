'use strict';
// Скелетон ↔ контент: для каждого экрана снимок во время загрузки (ответы API задержаны) и после,
// склеенные рядом в одну картинку skm-<экран>.png. Запуск: npx electron test/skeleton-match.js [папка] [экран…]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const settle = require('./_settle');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.argv[2] || path.join(__dirname, 'shots');
const only = process.argv.slice(3);
fs.mkdirSync(out, { recursive: true });

const DELAY = 2500;
const WORKERS = 3;

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`localStorage.setItem('anixart.theme','dark'); localStorage.setItem('anixart.pref.IS_ADULT','true')`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(3500);
  const A = (expr) => js(`(async () => { const { A } = await import('/js/api.js'); return ${expr}; })()`);
  const chans = (await A('A.channels(0, { permission: null, is_blog: null, is_subscribed: null, sort: 1 })')).content;
  const channel = chans.find((c) => !c.is_blog) || chans[0];
  const article = ((await A(`A.channelArticles(${channel.id}, 0)`)).content || [])[0];
  const collection = ((await A('A.collections(0, -1, 1, 1)')).content || [])[0];
  const rel = (await A('A.release(21, true)')).release;
  const comment = (rel.comments || []).find((c) => c.reply_count > 0) || (rel.comments || [])[0];
  const type = ((await A('A.types(21)')).types || [])[0];
  const sources = type ? ((await A(`A.sources(21, ${type.id})`)).sources || []) : [];

  const P = (o) => JSON.stringify(o);
  const screens = [
    ['channel-preload', `r.navigate('channel', { id: ${channel.id}, preload: ${P(channel)} })`],
    ['channel', `r.navigate('channel', { id: ${channel.id} })`],
    article && ['article-preload', `r.navigate('article', { id: ${article.id}, preload: ${P(article)} })`],
    article && ['article', `r.navigate('article', { id: ${article.id} })`],
    collection && ['collection-preload', `r.navigate('collection', { id: ${collection.id}, preload: ${P(collection)} })`],
    ['profile', `r.navigate('profile', { id: 1 })`],
    ['schedule', `r.navigate('schedule', {})`],
    ['episodes-types', `r.navigate('episodes', { release: { id: 21, title_ru: ${P(rel.title_ru)} }, pick: true })`],
    type && sources[0] && ['episodes-list', `r.navigate('episodes', { release: { id: 21, title_ru: ${P(rel.title_ru)} }, type: ${P(type)}, source: ${P(sources[0])} })`],
    comment && ['replies', `r.navigate('replies', { kind: 'release', id: ${comment.id}, release: { id: 21 } })`],
    ['streaming', `r.navigate('streaming', { release: { id: 21 } })`],
    ['release-videos', `r.navigate('release-videos', { release: { id: 21 } })`],
    ['channels', `r.navigate('channels', {})`],
    ['comments', `r.navigate('comments', { kind: 'release', id: 21 })`],
    ['collections', `r.navigate('collections', { sort: 1 })`],
    ['top', `r.navigate('top', {})`],
    ['discover', `r.switchTab('discover')`],
    ['search-profiles', `r.navigate('search', { query: 'ani', scope: 'profiles' })`],
    ['friends', `r.navigate('friends', { profile: { id: 1 } })`],
  ].filter(Boolean).filter(([n]) => !only.length || only.includes(n));

  // (первое окно не закрываем: без окон Electron завершает приложение раньше воркеров)
  // Экраны снимаются в WORKERS окнах одновременно: у каждого своя задержка запросов и своё окно склейки
  const queue = screens.slice();
  await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(srv, i, queue)));
  srv.server.close();
  app.exit(0);
});

async function worker(srv, wi, queue) {
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  const join = new BrowserWindow({ width: 2220, height: 780, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await settle(js, 3500);
  // задержка всех запросов к API (кроме тех, что уже в полёте); счётчик запросов — поверх неё
  await js(`(() => { const of = window.fetch; window.__delay = 0; window.fetch = async (u, o) => { if (window.__delay && String(u).includes('/api/')) await new Promise((ok) => setTimeout(ok, window.__delay)); return of(u, o); }; })()`);
  await js('delete window.__inflight; 1');
  await js(settle.INSTALL);
  const cap = async (file) => {
    await win.webContents.capturePage(); await sleep(150);
    const p = path.join(out, file);
    fs.writeFileSync(p, (await win.webContents.capturePage()).toPNG());
    return `file:///${p.replace(/\\/g, '/')}`;
  };
  while (queue.length) {
    const [name, code] = queue.shift();
    await js(`(async () => { document.querySelectorAll('.backdrop').forEach(b => b.remove()); window.__delay = ${DELAY}; const r = await import('/js/router.js'); ${code} })()`);
    await sleep(800);
    const a = await cap(`_a${wi}.png`);
    await js('window.__delay = 0');
    await sleep(DELAY - 800); // уже задержанные запросы ответят не раньше
    await settle(js, 4000, 500);
    const b = await cap(`_b${wi}.png`);
    const page = path.join(out, `_join${wi}.html`);
    fs.writeFileSync(page, `<body style="margin:0;background:#000;display:flex;gap:20px"><img src="${a}?${Date.now()}" style="width:1100px"><img src="${b}?${Date.now()}" style="width:1100px"></body>`);
    await join.loadFile(page);
    await sleep(300);
    fs.writeFileSync(path.join(out, `skm-${name}.png`), (await join.webContents.capturePage()).toPNG());
    console.log('saved', name);
    // назад к корню вкладки
    await js(`(async () => { const r = await import('/js/router.js'); r.switchTab('home', { reset: true }); })()`);
    await settle(js, 1500);
  }
  win.destroy(); join.destroy();
}
