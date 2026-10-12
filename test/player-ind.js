'use strict';
// Индикаторы плеера: двойной тап (±10 секунд с накоплением) и удержание (скорость ×2).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const out = process.argv[2] || path.join(__dirname, 'shots');
  fs.mkdirSync(out, { recursive: true });
  const shot = async (n) => { await win.webContents.capturePage(); await sleep(250); fs.writeFileSync(path.join(out, `${n}.png`), (await win.webContents.capturePage()).toPNG()); };
  await sleep(3000);
  await js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/1/1/8?sort=1')).json();
    window.__p = openBuiltinPlayer({ release: { id: 1, title_ru: 'Котёнок Ти' }, episodes: r.episodes, index: 0, sort: 1 });
  })()`);
  await sleep(9000);
  const clickAt = (fx) => js(`(() => { const st = document.querySelector('.player-stage'); const r = st.getBoundingClientRect();
    const ev = (t) => st.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: r.left + r.width * ${fx}, clientY: r.top + r.height / 2 }));
    ev('click'); return true; })()`);
  // двойной тап справа, затем ещё один тап → «+20 секунд»
  await clickAt(0.85); await sleep(120); await clickAt(0.85); await sleep(150); await clickAt(0.85); await sleep(120);
  const right = await js(`({ shown: document.querySelector('.seek-ind.right').classList.contains('show'), text: document.querySelector('.seek-ind.right .seek-label').textContent })`);
  console.log('right seek:', JSON.stringify(right));
  await shot('player-seek-right');
  await sleep(1200);
  const hidden = await js(`!document.querySelector('.seek-ind.right').classList.contains('show')`);
  console.log('right seek hidden after 800ms:', hidden);
  // удержание при скорости 1.25 → 2,5x
  await js(`(() => { document.querySelector('.player-overlay video').playbackRate = 1.25;
    document.querySelector('.player-stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' })); })()`);
  await sleep(800);
  const speed = await js(`({ shown: document.querySelector('.speed-ind').classList.contains('show'), text: document.querySelector('.speed-ind .speed-text').textContent, rate: document.querySelector('.player-overlay video').playbackRate })`);
  console.log('hold speed:', JSON.stringify(speed));
  await shot('player-speed');
  await js(`document.querySelector('.player-stage').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }))`);
  await sleep(400);
  const after = await js(`({ shown: document.querySelector('.speed-ind').classList.contains('show'), rate: document.querySelector('.player-overlay video').playbackRate })`);
  console.log('after release:', JSON.stringify(after));
  srv.server.close();
  app.exit(0);
});
