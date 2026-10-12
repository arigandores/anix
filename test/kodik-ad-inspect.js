'use strict';
// Диагностика страницы рекламы Kodik: фреймы, кнопки, видео, скриншот.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
require('../electron/main.js');
app.whenReady().then(async () => {
  let main;
  for (let i = 0; i < 60 && !main; i++) { await sleep(400); main = BrowserWindow.getAllWindows()[0]; }
  await sleep(4000);
  main.webContents.executeJavaScript(`(async () => { const t = await (await fetch('/api/episode/target/1/8/1')).json(); const { showKodikAd } = await import('/js/player.js'); showKodikAd(t.episode.url); })()`, true);
  await sleep(13000);
  const ad = BrowserWindow.getAllWindows().find((w) => w !== main);
  if (!ad) { console.log('no ad window'); app.exit(0); return; }
  for (const f of ad.webContents.mainFrame.framesInSubtree) {
    try {
      const info = await f.executeJavaScript(`({
        url: location.href.slice(0, 110),
        videos: document.querySelectorAll('video').length,
        iframes: [...document.querySelectorAll('iframe')].map(i => (i.src || '').slice(0, 80)),
        buttons: [...document.querySelectorAll('button, [role=button], .play, [class*=play]')].slice(0, 8).map(b => (b.className || b.tagName).toString().slice(0, 60)),
        text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 160),
      })`, true);
      console.log(JSON.stringify(info));
    } catch (e) { console.log('frame err', String(e).slice(0, 80)); }
  }
  const out = process.argv[2] || path.join(__dirname, 'shots');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'kodik-ad.png'), (await ad.webContents.capturePage()).toPNG());
  console.log('saved');
  app.exit(0);
});
