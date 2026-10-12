'use strict';
// Проверка окна рекламы Kodik в реальном electron/main.js.
// Запуск: npx electron test/kodik-ad.js [папка-для-скриншотов]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require('../electron/main.js');

app.whenReady().then(async () => {
  let main;
  for (let i = 0; i < 60 && !main; i++) { await sleep(500); main = BrowserWindow.getAllWindows()[0]; }
  await sleep(4000);
  const js = (c) => main.webContents.executeJavaScript(c, true);
  console.log('bridge:', await js('typeof window.anixartNative?.showKodikAd'));
  // Тот же путь, что при выборе серии
  js(`(async () => {
    const t = await (await fetch('/api/episode/target/1/8/1')).json();
    const { showKodikAd } = await import('/js/player.js');
    window.__adStart = Date.now();
    window.__adDone = await showKodikAd(t.episode.url).then(() => Date.now() - window.__adStart);
  })()`);
  await sleep(10000);
  const wins = BrowserWindow.getAllWindows();
  const ad = wins.find((w) => w !== main);
  console.log('ad window open:', !!ad, ad ? ad.webContents.getURL().slice(0, 90) : '');
  if (ad) {
    // автозапуск: есть ли во фреймах видео, которое уже играет
    const states = [];
    for (const f of ad.webContents.mainFrame.framesInSubtree) {
      try {
        states.push(...await f.executeJavaScript(`[...document.querySelectorAll('video')].map(v => ({t: +v.currentTime.toFixed(1), paused: v.paused, muted: v.muted}))`, true));
      } catch { /* ignore */ }
    }
    console.log('videos in ad:', JSON.stringify(states));
    console.log('KodikInterface in ad page:', await ad.webContents.executeJavaScript('typeof window.KodikInterface?.advertEnded'));
    fs.writeFileSync(path.join(outDir, '15-kodik-ad.png'), (await ad.webContents.capturePage()).toPNG());
    // имитируем вызов страницы рекламы по окончании
    await ad.webContents.executeJavaScript('window.KodikInterface.advertEnded()');
    await sleep(1500);
  }
  console.log('resolved after advertEnded:', await js('window.__adDone ?? null'), 'ad closed:', ad ? ad.isDestroyed() : 'n/a');
  app.exit(0);
});
