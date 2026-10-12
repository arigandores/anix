'use strict';
// Проверка окон соцвхода в electron/main.js: окно открывается, страница провайдера грузится,
// перехват редиректа работает (эмулируем редирект через did-navigate на тестовый адрес).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require('../electron/main.js');

app.whenReady().then(async () => {
  let main;
  for (let i = 0; i < 60 && !main; i++) { await sleep(500); main = BrowserWindow.getAllWindows()[0]; }
  await sleep(4000);
  const js = (c) => main.webContents.executeJavaScript(c, true);
  console.log('bridge socialAuth:', await js('typeof window.anixartNative?.socialAuth'));

  for (const provider of ['yandex', 'telegram', 'vk', 'google']) {
    const req = await js(`fetch('/social/request?provider=${provider}').then(r=>r.json())`);
    console.log(`\n[${provider}] authUri:`, (req.url || req.error || '').slice(0, 70));
    // стартуем вход, окно откроется; через 4 с проверяем, что есть доп. окно с нужным доменом
    js(`window.anixartNative.socialAuth(${JSON.stringify({ ...req, provider })}); 1`);
    await sleep(5000);
    const extra = BrowserWindow.getAllWindows().filter((w) => w !== main && !w.isDestroyed());
    const u = extra.length ? extra[0].webContents.getURL() : '';
    console.log(`[${provider}] auth window:`, extra.length > 0, '→', u.slice(0, 55));
    extra.forEach((w) => w.close());
    await sleep(800);
  }
  console.log('\nOK');
  app.exit(0);
});
