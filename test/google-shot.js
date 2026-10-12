'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
require('../electron/main.js');
app.whenReady().then(async () => {
  let main;
  for (let i = 0; i < 60 && !main; i++) { await sleep(400); main = BrowserWindow.getAllWindows()[0]; }
  await sleep(4000);
  const req = await main.webContents.executeJavaScript(`fetch('/social/request?provider=google').then(r=>r.json())`, true);
  main.webContents.executeJavaScript(`window.anixartNative.socialAuth(${JSON.stringify({ ...req, provider: 'google' })}); 1`, true);
  await sleep(7000);
  const extra = BrowserWindow.getAllWindows().filter((w) => w !== main && !w.isDestroyed());
  if (extra.length) {
    const g = extra[0];
    const url = g.webContents.getURL();
    const title = g.webContents.getTitle();
    const bodyText = await g.webContents.executeJavaScript(`document.body ? document.body.innerText.slice(0,200) : ''`).catch(() => '');
    console.log('URL:', url.slice(0, 80));
    console.log('TITLE:', title);
    console.log('TEXT:', bodyText.replace(/\s+/g, ' ').slice(0, 160));
    const out = process.argv[2] || path.join(__dirname, 'shots');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'google-auth.png'), (await g.webContents.capturePage()).toPNG());
    console.log('saved');
  } else console.log('no window');
  app.exit(0);
});
