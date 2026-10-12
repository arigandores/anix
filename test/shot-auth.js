'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
require('../electron/main.js');
app.whenReady().then(async () => {
  let w;
  for (let i = 0; i < 60 && !w; i++) { await sleep(400); w = BrowserWindow.getAllWindows()[0]; }
  await sleep(3500);
  await w.webContents.executeJavaScript(`import('/js/router.js').then(m=>m.navigate('auth'))`, true);
  await sleep(2000); await w.webContents.capturePage();
  const out = process.argv[2] || path.join(__dirname, 'shots');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'auth-social.png'), (await w.webContents.capturePage()).toPNG());
  console.log('saved');
  app.exit(0);
});
