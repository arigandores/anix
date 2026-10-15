'use strict';
// Установка ускорения NVIDIA кнопкой в меню плеера, в чистом временном профиле: «Установить» нажимается,
// идёт скачивание (93 МБ с PyPI, SHA-256), после — переключатель и «Максимальное» через TensorRT.
// Без NVIDIA RTX или без trt/bin/anix-trt.exe — пропуск («UPSCALE-TRT-INSTALL SKIP»). Аккаунт не затрагивается.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anix-trt-install-'));
app.setPath('userData', dir);
delete process.env.ANIX_TRT_DLLS; // библиотеки — только те, что поставит кнопка
const { start } = require('../server');
require('../electron/trt').register(ipcMain);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ошибка любого шага — сразу FAIL и выход, а не ожидание тайм-аута
app.whenReady().then(() => main().catch((e) => { console.log(`FAIL исключение: ${e && e.message}`); app.exit(1); }));
async function main() {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1500, height: 950, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, preload: path.join(ROOT, 'electron', 'preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setFrameRate(60);
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const fails = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
  const finish = (msg) => {
    console.log(msg); srv.server.close();
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* занято — останется во временной папке */ } app.exit(fails.length ? 1 : 0); }, 1500);
  };
  const st0 = await js('window.anixartNative.trt ? window.anixartNative.trt.status() : { supported: false }');
  if (!st0.supported) { finish(`UPSCALE-TRT-INSTALL SKIP (${st0.reason || ''} ${st0.error || ''})`); return; }
  check(!st0.installed, 'в чистом профиле библиотеки не установлены');

  await js(`localStorage.setItem('anixart.pref.SELECTED_PLAYER','2'); localStorage.setItem('anixart.pref.ON_EPISODE_DISCLAIMER','true'); localStorage.setItem('anixart.pref.UPSCALE_MODE', '"max"'); 1`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(2500);
  await js(`(async () => {
    const { A } = await import('/js/api.js');
    const types = (await A.types(2487)).types; const ty = types.find((x) => x.name === 'Studio Band') || types[0];
    const so = (await A.sources(2487, ty.id)).sources.find((s) => /kodik/i.test(s.name));
    (await import('/js/router.js')).navigate('episodes', { release: { id: 2487, title_ru: 'Атака титанов 3' }, type: ty, source: so });
  })(); 1`);
  await sleep(3500);
  await js(`document.querySelector('#viewport .screen:last-child .ep-row').click(); 1`);
  for (let i = 0; i < 60 && !(await js(`!!document.querySelector('.player-overlay video') && document.querySelector('.player-overlay video').readyState >= 2`)); i++) await sleep(250);
  await js(`document.querySelectorAll('.backdrop').forEach((b) => b.querySelector('.sheet-item')?.click()); 1`);
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.muted = true; v.play(); })(); 1`);
  await sleep(1500);
  await js(`(() => { document.querySelector('.player-controls .gear').click();
    [...document.querySelectorAll('.player-menu .pm-row')].find((x) => /Улучшение/.test(x.textContent)).click(); })(); 1`);
  await sleep(500);
  const btn = await js(`(() => { const b = document.querySelector('.player-menu .trt-row'); return b ? { disabled: b.disabled, text: b.innerText.replace(/\\n/g, ' | ') } : null; })()`);
  check(btn && !btn.disabled && /Установить/.test(btn.text), `кнопка «Установить» доступна: ${btn ? btn.text : 'нет'}`);
  await js(`document.querySelector('.player-menu .trt-row').click(); 1`);
  await sleep(400);
  const during = await js(`(document.querySelector('.player-menu .trt-row small') || {}).textContent || ''`);
  console.log('   во время установки:', during);
  let installed = false;
  for (let i = 0; i < 240 && !installed; i++) { await sleep(500); installed = await js(`[...document.querySelectorAll('.player-menu label.pm-row')].some((x) => /Ускорение NVIDIA/.test(x.textContent))`); }
  check(installed, 'после установки — переключатель «Ускорение NVIDIA»');
  let s = null;
  for (let i = 0; i < 40; i++) { s = await js(`document.querySelector('.player-overlay').upscale.debug.stages`); if (/:trt$/.test(s[0] || '')) break; await sleep(500); }
  check(/:trt$/.test((s || [])[0] || ''), `«Максимальное» сразу через TensorRT: ${(s || []).join(' + ')}`);
  await js(`document.querySelector('.player-top .icon-btn').click(); 1`);
  await sleep(500);
  finish(fails.length ? `UPSCALE-TRT-INSTALL FAIL: ${fails.length}` : 'UPSCALE-TRT-INSTALL OK');
}
