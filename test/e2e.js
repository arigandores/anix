'use strict';
// E2E-проверка в Electron: открывает приложение, проходит основные экраны, сохраняет скриншоты
// и выводит ошибки консоли. Запуск: npx electron test/e2e.js [папка-для-скриншотов]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');

const outDir = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(outDir, { recursive: true });
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation: true } });
  win.webContents.on('console-message', (e) => {
    const { level, message, sourceId, lineNumber } = e;
    if (level === 'error' || level === 3) errors.push(`${message} @ ${sourceId}:${lineNumber}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`));
  await win.loadURL(srv.url);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const shot = async (name, wait = 3500) => {
    await sleep(wait);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    const txt = await js(`(document.querySelector('#viewport')?.innerText || '').slice(0, 300).replace(/\\s+/g,' ')`);
    console.log(`[${name}] ${txt}`);
  };
  const steps = (process.env.STEPS || 'home,discover,release,episodes,search,filter,schedule,top,collections,bookmarks,profile,auth,settings').split(',');
  const nav = (screen, params = '{}') => js(`import('/js/router.js').then(m => m.navigate('${screen}', ${params}))`);
  const tab = (t) => js(`import('/js/router.js').then(m => m.switchTab('${t}'))`);
  await sleep(3000);
  for (const s of steps) {
    try {
      if (s === 'home') { await shot('01-home', 5000); }
      if (s === 'discover') { await tab('discover'); await shot('02-discover', 6000); }
      if (s === 'release') { await tab('home'); await nav('release', '{id: 21}'); await shot('03-release', 5000); await js('document.querySelector("#viewport").scrollTop = 900'); await shot('03b-release-scroll', 800); }
      if (s === 'episodes') { await nav('episodes', '{release: {id: 1, title_ru: "Тест"}}'); await shot('04-episodes', 5000); }
      if (s === 'search') { await nav('search', '{query: "наруто"}'); await shot('05-search', 5000); }
      if (s === 'filter') { await nav('filter', '{}'); await shot('06-filter', 2500); }
      if (s === 'schedule') { await nav('schedule'); await shot('07-schedule', 4000); }
      if (s === 'top') { await nav('top'); await shot('08-top', 4000); }
      if (s === 'collections') { await nav('collections', '{sort: 1}'); await shot('09-collections', 4000); }
      if (s === 'bookmarks') { await tab('bookmarks'); await shot('10-bookmarks', 2000); }
      if (s === 'profile') { await tab('discover'); await nav('profile', '{id: 1}'); await shot('11-profile', 4000); }
      if (s === 'auth') { await nav('auth'); await shot('12-auth', 1500); }
      if (s === 'settings') { await nav('settings'); await shot('13-settings', 1500); }
      if (s === 'player') {
        await js(`(async () => {
          const { openBuiltinPlayer } = await import('/js/player.js');
          const r = await (await fetch('/api/episode/1/1/8?sort=1')).json();
          const eps = r.episodes.map(e => ({...e, release: undefined}));
          window.__p = openBuiltinPlayer({ release: { id: 1, title_ru: 'Котёнок Ти' }, episodes: eps, index: 0, sort: 1 });
        })()`);
        await sleep(12000);
        const st = await js(`(() => { const v = document.querySelector('.player-overlay video'); return v ? { t: v.currentTime, d: v.duration, rs: v.readyState, paused: v.paused, err: v.error && v.error.code } : null; })()`);
        console.log('[player]', JSON.stringify(st));
        await shot('14-player', 500);
      }
    } catch (e) { errors.push(`step ${s}: ${e.message}`); }
  }
  console.log('ERRORS:', errors.length ? `\n${errors.join('\n')}` : 'none');
  srv.server.close();
  app.quit();
});
