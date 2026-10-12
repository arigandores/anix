'use strict';
// Открывается ли окно соцвхода: electron test/social-open.js <vk|yandex|telegram> (Google — в системном браузере)
const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(os.tmpdir(), `anix-test-${Date.now()}`));
require('../electron/main.js');
const provider = process.argv[process.argv.length - 1];

app.whenReady().then(async () => {
  let main;
  for (let i = 0; i < 60 && !main; i++) { await sleep(300); main = BrowserWindow.getAllWindows()[0]; }
  await sleep(2000);
  const res = await main.webContents.executeJavaScript(`(async () => {
    const req = await (await fetch('/social/request?provider=${provider}')).json();
    if (req.error) return { step: 'request', error: req.error };
    req.provider = '${provider}';
    const p = window.anixartNative.socialAuth(req).then((r) => ({ step: 'auth', r }), (e) => ({ step: 'auth', error: String(e && e.message || e) }));
    return Promise.race([p, new Promise((r) => setTimeout(() => r({ step: 'open', url: req.url && req.url.slice(0, 90) }), 6000))]);
  })()`, true).catch((e) => ({ step: 'js', error: String(e) }));
  console.log('RESULT', JSON.stringify(res));
  const w = BrowserWindow.getAllWindows().find((x) => x !== main && !x.isDestroyed());
  if (w) console.log('WINDOW', w.webContents.getURL().slice(0, 120), '::', (await w.webContents.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '')).replace(/\s+/g, ' ').slice(0, 160));
  else console.log('WINDOW none');
  app.exit(0);
});
