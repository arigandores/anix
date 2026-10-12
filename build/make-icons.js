'use strict';
// Растеризует build/icon.svg → build/icon.png (256), public/icon.png (192), build/icon.ico (16–256).
// Запуск: npx electron build/make-icons.js
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');

async function render(win, size) {
  const html = `<html><body style="margin:0;background:transparent">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await win.webContents.executeJavaScript('document.querySelector("img").decode()');
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

// ICO с PNG-кадрами (поддерживается Windows Vista+)
function ico(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + dir.length;
  frames.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e); dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt8(0, e + 2); dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(png.length, e + 8); dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 256, height: 256, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true } });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const size of sizes) frames.push({ size, png: await render(win, size) });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), frames.find((f) => f.size === 256).png);
  fs.writeFileSync(path.join(root, 'public', 'icon.png'), await render(win, 192));
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico(frames));
  console.log('icon.png, public/icon.png, icon.ico готовы');
  app.quit();
});
