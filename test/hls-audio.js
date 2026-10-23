'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Звук HLS-потока через hls.js: AAC LC 48 кГц стерео в .ts, плейлист без CODECS — как у Kodik. hls.js 1.5 в Chrome
// всегда объявлял такой звук как HE-AAC (mp4a.40.5), и в колонках озвучка хрипела и звучала глухо. В заглушённом окне
// теста хрипа не слышно (захваченный звук у обеих версий одинаковый), поэтому проверяется причина — объявленный кодек.
// Фикстура — тон 1 кГц (test/fixtures/hls-aac-lc): заодно проверяется, что звук вообще идёт и на своей частоте.
//   electron test/hls-audio.js
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');

const FIXTURE = path.join(__dirname, 'fixtures', 'hls-aac-lc');
const TONE = 1000;

app.whenReady().then(async () => {
  const srv = await start(0);
  // плейлист и сегменты — со своего сервера, как поток с другого адреса
  const media = http.createServer((req, res) => {
    const file = path.join(FIXTURE, path.basename(req.url.split('?')[0]));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => media.listen(0, '127.0.0.1', r));
  const src = `http://127.0.0.1:${media.address().port}/index.m3u8`;

  const win = new BrowserWindow({ width: 640, height: 400, show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setAudioMuted(true); // в колонки ничего не идёт
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  let bad = 0;
  const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };

  const r = await js(`(async () => {
    const video = document.createElement('video'); document.body.append(video);
    const hls = new Hls({ enableWorker: true });
    let codec = '';
    hls.on(Hls.Events.BUFFER_CODECS, (_e, d) => { codec = d.audio?.codec || d.audiovideo?.codec || ''; });
    let fatal = '';
    hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) fatal = d.details; });
    hls.loadSource(${JSON.stringify(src)}); hls.attachMedia(video);
    await new Promise((ok, no) => { video.addEventListener('canplay', ok, { once: true }); setTimeout(() => no(new Error('поток не загрузился: ' + fatal)), 10000); });
    // слышимый звук — то, что выходит из <video> после декодера
    const ctx = new AudioContext();
    const stream = video.captureStream();
    await video.play();
    const t = stream.getAudioTracks()[0] || await new Promise((ok) => stream.addEventListener('addtrack', (e) => ok(e.track), { once: true }));
    const an = new AnalyserNode(ctx, { fftSize: 8192 });
    new MediaStreamAudioSourceNode(ctx, { mediaStream: new MediaStream([t]) }).connect(an);
    const bins = new Float32Array(an.frequencyBinCount); const peaks = [];
    for (let k = 0; k < 8; k++) {
      await new Promise((ok) => setTimeout(ok, 250));
      an.getFloatFrequencyData(bins);
      let mi = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[mi]) mi = i;
      if (bins[mi] > -70) peaks.push(Math.round(mi * ctx.sampleRate / an.fftSize));
    }
    const res = { codec, peaks, played: +video.currentTime.toFixed(2), hls: Hls.version };
    hls.destroy(); ctx.close();
    return res;
  })()`);

  console.log(`hls.js ${r.hls}: объявленный кодек ${r.codec || '—'}, пики спектра ${r.peaks.join(', ') || 'нет'} Гц, проиграно ${r.played} с`);
  check(r.peaks.length >= 4, `звук есть (${r.peaks.length} замеров из 8)`);
  check(r.peaks.length && r.peaks.every((f) => Math.abs(f - TONE) < 30), `тон ${TONE} Гц слышен на своей частоте`);
  check(r.codec === 'mp4a.40.2', `AAC LC объявлен как AAC LC (mp4a.40.2), а не HE-AAC (${r.codec})`);

  media.close(); srv.server?.close?.();
  console.log(bad ? `FAIL: ${bad}` : 'PASS');
  app.exit(bad ? 1 : 0);
});
