'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Плеер переживает сбои узлов CDN. Kodik раздаёт сегменты с разных узлов (p12/p13.solodcdn.com…), и узел временами
// отваливается. Раньше: одна попытка восстановления на всю серию — второй сбой в любом месте серии давал
// «Невозможно воспроизвести видео…», хотя Anixart (ExoPlayer) переподключался и играл дальше.
// 1) прокси /stream: обрыв посреди сегмента — ошибка соединения, а не «целый» укороченный сегмент (hls.js принимал
//    его, в буфере появлялась дыра); 503 от узла — повтор на стороне прокси;
// 2) встроенный плеер, поток через /stream: в одной серии падают по очереди два узла (свежая ссылка после сбоя ведёт
//    на рабочий узел) — серия доигрывает без ошибки; сбой буфера (MEDIA_ERROR) чинится без новой ссылки.
// Фикстура — test/fixtures/hls-video (20 с, сегменты по 2 с).
//   electron test/stream-recover.js
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');

const FIXTURE = path.join(__dirname, 'fixtures', 'hls-video');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (js, cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(cond)) return true; await sleep(150); } return false; };

app.whenReady().then(async () => {
  const srv = await start(0);
  let bad = 0;
  const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };

  // Узел CDN. gen — «поколение» ссылки (каждый /parse выдаёт новое): при gen=0 лежит узел с seg3, при gen≤1 — с seg6
  const hits = { parse: 0, drop: 0, flaky: 0 };
  const media = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const gen = Number(u.searchParams.get('gen') || 0);
    const name = path.basename(u.pathname);
    if (name === 'drop') { // половина ответа без длины (chunked) — и обрыв
      hits.drop++;
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.write(Buffer.alloc(188 * 50, 0x47));
      setTimeout(() => res.socket.destroy(), 50);
      return;
    }
    if (name === 'flaky') { // первый раз узел отвечает 503
      hits.flaky++;
      if (hits.flaky === 1) { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' }); res.end(Buffer.alloc(188, 0x47));
      return;
    }
    if ((name === 'seg3.ts' && gen === 0) || (name === 'seg6.ts' && gen <= 1)) { req.socket.destroy(); return; }
    const file = path.join(FIXTURE, name);
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    if (name.endsWith('.m3u8')) {
      const text = fs.readFileSync(file, 'utf8').replace(/^(seg\d+\.ts)$/gm, `$1?gen=${gen}`);
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end(text);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => media.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${media.address().port}`;
  const viaProxy = (u) => `${srv.url}stream?url=${encodeURIComponent(u)}`;

  // 1) прокси
  const dropped = await fetch(viaProxy(`${base}/drop`)).then((r) => r.arrayBuffer()).then((b) => `целый ответ ${b.byteLength} байт`, (e) => `ошибка: ${e.cause?.code || e.message}`);
  check(/^ошибка/.test(dropped), `обрыв посреди сегмента — ошибка соединения, а не укороченный «целый» сегмент (${dropped})`);
  const flaky = await fetch(viaProxy(`${base}/flaky`));
  check(flaky.status === 200 && hits.flaky === 2, `узел ответил 503 — прокси повторил запрос (статус ${flaky.status}, запросов ${hits.flaky})`);

  // 2) плеер
  const win = new BrowserWindow({ width: 960, height: 600, show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setAudioMuted(true);
  win.webContents.on('console-message', (e) => { if (/\[recover\]/.test(e.message)) console.log('   ', e.message); });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`localStorage.clear(); localStorage.setItem('anixart.pref.ON_EPISODE_DISCLAIMER','true'); 1`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await until(js, '!!document.querySelector("#rail .nav-item")', 8000);
  // Ссылку серии отдаёт «парсер» (каждый раз новое поколение); hls.js — с быстрыми повторами, чтобы сбой узла
  // стал фатальным за доли секунды (по умолчанию — 6 повторов с паузами до 8 с), экземпляр — в window.__hls
  await js(`(() => {
    let gen = 0;
    const real = window.fetch;
    window.__parses = 0;
    window.fetch = (u, o) => {
      const s = String(u);
      if (s.startsWith('/api/episode/target/')) return Promise.resolve(new Response(JSON.stringify({ code: 0, episode: { url: 'test' } }), { headers: { 'Content-Type': 'application/json' } }));
      if (s.startsWith('/parse?')) { window.__parses++; gen++; console.log('[recover] /parse → gen ' + gen); return Promise.resolve(new Response(JSON.stringify({ playback: { '720p': '${base}/index.m3u8?gen=' + gen } }))); }
      return real(u, o);
    };
    const H = window.Hls;
    const fast = { default: { maxTimeToFirstByteMs: 3000, maxLoadTimeMs: 5000, timeoutRetry: { maxNumRetry: 0, retryDelayMs: 0, maxRetryDelayMs: 0 }, errorRetry: { maxNumRetry: 1, retryDelayMs: 100, maxRetryDelayMs: 100 } } };
    window.Hls = class extends H { constructor(c) { super({ ...c, fragLoadPolicy: fast }); window.__hls = this;
      this.on(H.Events.ERROR, (_e, d) => { if (d.fatal) console.log('[recover] fatal ' + d.type + ' ' + d.details + ' @' + document.querySelector('.player-overlay video')?.currentTime.toFixed(1)); }); } };
  })(); 1`);
  await js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const ep = { position: 1, releaseId: 990001, sourceId: 990001, name: '1 серия', source: { id: 990001, name: 'Kodik' } };
    openBuiltinPlayer({ release: { id: 990001, title_ru: 'Тест сбоев CDN' }, episodes: [ep], index: 0, startAt: 0,
      resolved: { qualities: { '720p': '${base}/index.m3u8?gen=0' }, referer: '', cookie: '' } });
  })(); 1`);
  const ok = await until(js, `(() => { const v = document.querySelector('.player-overlay video'); if (v && v.paused && v.readyState >= 2) { v.muted = true; v.play().catch(() => {}); } return !!v && v.currentTime > 0.3; })()`, 10000);
  check(ok, 'серия пошла');
  const msg = () => js(`(document.querySelector('.player-msg')?.innerText || '').trim()`);
  // ждём конца серии или надписи об ошибке
  await until(js, `(() => { const v = document.querySelector('.player-overlay video'); return v.ended || v.currentTime > 19 || /Невозможно/.test(document.querySelector('.player-msg')?.innerText || ''); })()`, 40000);
  let r = await js(`({ t: +document.querySelector('.player-overlay video').currentTime.toFixed(1), parses: window.__parses })`);
  let m = await msg();
  check(!/Невозможно/.test(m) && r.t > 19, `два узла упали по очереди в одной серии — доиграла до конца (позиция ${r.t} с, новых ссылок ${r.parses}${m ? `, надпись «${m}»` : ''})`);
  check(r.parses === 2, `на каждый сбой узла — одна новая ссылка (${r.parses})`);

  // сбой буфера: hls.js восстанавливает медиа сам, новая ссылка не нужна
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.currentTime = 4; v.play().catch(() => {}); })(); 1`);
  await until(js, `document.querySelector('.player-overlay video').currentTime > 4.5`, 8000);
  const from = await js(`document.querySelector('.player-overlay video').currentTime`); // до сбоя: при восстановлении позиция на миг 0
  await js(`window.__hls.trigger(Hls.Events.ERROR, { type: Hls.ErrorTypes.MEDIA_ERROR, details: Hls.ErrorDetails.BUFFER_STALLED_ERROR, fatal: true }); 1`);
  const moved = await until(js, `(() => { const v = document.querySelector('.player-overlay video'); if (v.paused) v.play().catch(() => {}); return v.currentTime > ${from} + 1.5; })()`, 10000);
  r = await js(`({ t: +document.querySelector('.player-overlay video').currentTime.toFixed(1), parses: window.__parses })`);
  m = await msg();
  check(moved && !/Невозможно/.test(m) && r.parses === 2, `сбой буфера (MEDIA_ERROR) — серия идёт дальше без новой ссылки (позиция ${r.t} с, ссылок ${r.parses}${m ? `, надпись «${m}»` : ''})`);

  media.close(); srv.server.close();
  console.log(bad ? `FAIL: ${bad}` : 'PASS');
  app.exit(bad ? 1 : 0);
});
