'use strict';
// Продолжение просмотра: сохранить позицию, открыть серию снова → диалог «Воспроизведение».
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await sleep(3000);
  const open = () => js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/1/1/8?sort=1')).json();
    window.__p = openBuiltinPlayer({ release: { id: 1, title_ru: 'Котёнок Ти' }, episodes: r.episodes, index: 0, sort: 1 });
  })()`);
  await js(`localStorage.removeItem('anixart.db.episodes'); 1`);
  await open(); await sleep(9000);
  console.log('first open dialog:', await js(`!!document.querySelector('.backdrop .dialog-title')`));
  await js(`document.querySelector('.player-overlay video').currentTime = 42; 1`);
  await sleep(1500);
  await js(`window.__p.close(); 1`);
  console.log('saved:', await js(`JSON.stringify(Object.values(JSON.parse(localStorage.getItem('anixart.db.episodes')||'{}')).map(e=>e.playbackPosition))`));
  await sleep(800);
  await open(); await sleep(9000);
  console.log('second open dialog:', JSON.stringify(await js(`(() => { const d = document.querySelector('.backdrop .dialog'); return d ? { title: d.querySelector('.dialog-title').textContent, items: [...d.querySelectorAll('.sheet-item')].map(b => b.textContent), paused: document.querySelector('.player-overlay video').paused } : null; })()`)));
  await js(`[...document.querySelectorAll('.backdrop .sheet-item')].find(b => b.textContent === 'Продолжить').click(); 1`);
  await sleep(2500);
  console.log('after continue t≈', await js(`Math.round(document.querySelector('.player-overlay video').currentTime)`));
  srv.server.close(); app.exit(0);
});
