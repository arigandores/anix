'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Улучшение звука (public/js/audio.js): все 8 сочетаний переключателей на синтетической «серии» в OfflineAudioContext —
// громкость относительно «всё выключено», задержка, перегруз; что делает каждый переключатель; затем живой <video>.
//   electron test/audio.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setAudioMuted(true); // в колонки ничего не идёт
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  let bad = 0;
  const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };

  const r = await js(`(async () => {
    const { buildChain } = await import('/js/audio.js');
    const SR = 48000; const SEC = 6; const N = SR * SEC;
    let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const lp = (x, a) => { let y = 0; return x.map((v) => (y += a * (v - y))); };
    // голос: шум 300–3500 Гц слогами по 4 Гц, по центру; фон: широкий стерео-шум (музыка и эффекты)
    const voice = new Float32Array(N); const musL = new Float32Array(N); const musR = new Float32Array(N);
    { let a = 0; let b = 0; for (let i = 0; i < N; i++) { const n = rnd(); a += 0.35 * (n - a); b += 0.04 * (n - b); voice[i] = (a - b) * 2.2 * (0.25 + 0.75 * Math.max(0, Math.sin(2 * Math.PI * 4 * i / SR))); } }
    { let a = 0; let c = 0; for (let i = 0; i < N; i++) { a += 0.2 * (rnd() - a); c += 0.2 * (rnd() - c); musL[i] = a * 0.9; musR[i] = c * 0.9; } }
    // первая половина тихая (−24 дБ), вторая громкая
    const env = (i) => (i < N / 2 ? 0.063 : 0.5);
    const mix = (v, m) => [0, 1].map((ch) => { const out = new Float32Array(N); for (let i = 0; i < N; i++) out[i] = env(i) * (v * voice[i] + m * (ch ? musR[i] : musL[i])); return out; });
    async function render(o, chans) {
      const ctx = new OfflineAudioContext(2, N, SR);
      const buf = ctx.createBuffer(2, N, SR); buf.copyToChannel(chans[0], 0); buf.copyToChannel(chans[1], 1);
      const s = new AudioBufferSourceNode(ctx, { buffer: buf });
      const c = await buildChain(ctx); c.apply(o, true);
      s.connect(c.input); c.output.connect(ctx.destination); s.start();
      const out = await ctx.startRendering();
      return [out.getChannelData(0), out.getChannelData(1)];
    }
    const rms = (ch, a, b) => { let s = 0; for (const x of ch) for (let i = a; i < b; i++) s += x[i] * x[i]; return 10 * Math.log10(s / (ch.length * (b - a)) + 1e-20); };
    const peak = (ch) => Math.max(...ch.map((x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
    // задержка: щелчок → первый заметный отклик
    async function latency(o) {
      const ctx = new OfflineAudioContext(2, SR / 4, SR);
      const buf = ctx.createBuffer(2, SR / 4, SR); buf.getChannelData(0)[100] = 0.5; buf.getChannelData(1)[100] = 0.5;
      const s = new AudioBufferSourceNode(ctx, { buffer: buf }); const c = await buildChain(ctx); c.apply(o, true);
      s.connect(c.input); c.output.connect(ctx.destination); s.start();
      const out = await ctx.startRendering(); const L = out.getChannelData(0); const R = out.getChannelData(1);
      let mx = 0; for (let i = 0; i < L.length; i++) mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i]));
      for (let i = 0; i < L.length; i++) if (Math.abs(L[i]) > mx * 0.25 || Math.abs(R[i]) > mx * 0.25) return ((i - 100) / SR) * 1000;
      return null;
    }
    const full = mix(1, 0.6); const res = {};
    const base = await render({}, full);
    const lvl = (x) => ({ all: rms(x, 0, N), quiet: rms(x, SR, N / 2), loud: rms(x, N / 2 + SR, N) });
    const b = lvl(base);
    for (let k = 0; k < 8; k++) {
      const o = { level: !!(k & 1), voice: !!(k & 2), surround: !!(k & 4) };
      const out = await render(o, full); const l = lvl(out);
      res[['level', 'voice', 'surround'].filter((x) => o[x]).join('+') || 'off'] = {
        all: +(l.all - b.all).toFixed(1), quiet: +(l.quiet - b.quiet).toFixed(1), loud: +(l.loud - b.loud).toFixed(1),
        range: +((l.loud - l.quiet) - (b.loud - b.quiet)).toFixed(1), peak: +peak(out).toFixed(3), ms: await latency(o),
      };
    }
    // «Чёткий голос»: насколько голос поднялся относительно фона (без выравнивания — цепь линейна)
    const vOn = await render({ voice: true }, mix(1, 0)); const vOff = await render({}, mix(1, 0));
    const mOn = await render({ voice: true }, mix(0, 0.6)); const mOff = await render({}, mix(0, 0.6));
    const voiceGain = (rms(vOn, 0, N) - rms(vOff, 0, N)) - (rms(mOn, 0, N) - rms(mOff, 0, N));
    // «Объёмный звук» в наушниках: моно по центру должно оставаться по центру, а широкий фон — расходиться по ушам
    const sOn = await render({ surround: true }, mix(0, 0.6));
    const corr = (x) => { let s = 0, a = 0, c = 0; for (let i = 0; i < N; i++) { s += x[0][i] * x[1][i]; a += x[0][i] ** 2; c += x[1][i] ** 2; } return s / Math.sqrt(a * c); };
    return { res, baseAbs: [+b.quiet.toFixed(1), +b.loud.toFixed(1)], voiceGain: +voiceGain.toFixed(1), corrOff: +corr(mOff).toFixed(2), corrOn: +corr(sOn).toFixed(2), baseRange: +(b.loud - b.quiet).toFixed(1) };
  })()`);

  console.log('сочетание: дБ относительно «выкл» — тихая часть · громкая часть · пик · задержка мс');
  for (const [k, v] of Object.entries(r.res)) console.log(`  ${k.padEnd(20)} ${String(v.quiet).padStart(5)} · ${String(v.loud).padStart(5)} · ${v.peak} · ${v.ms?.toFixed(1)}`);
  console.log(`голос над фоном: +${r.voiceGain} дБ; корреляция L/R фона: ${r.corrOff} → ${r.corrOn} (объёмный); исходно тихое / громкое: ${r.baseAbs[0]} / ${r.baseAbs[1]} дБFS`);
  for (const [k, v] of Object.entries(r.res)) {
    if (k.includes('level')) {
      // выравнивание: громкое не громче и чуть тише, тихое заметно громче
      check(v.loud <= 1 && v.loud >= -5, `${k}: громкая часть от −5 до +1 дБ к «выкл» (${v.loud})`);
      check(v.quiet >= 6, `${k}: тихая часть громче хотя бы на 6 дБ (+${v.quiet})`);
    } else check(Math.abs(v.all) <= 2, `${k}: громкость в пределах ±2 дБ от «выкл» (${v.all})`);
    check(v.peak <= 1.0001, `${k}: без перегруза (пик ${v.peak})`);
    check(v.ms != null && v.ms <= 1, `${k}: задержка обработки ${v.ms?.toFixed(1)} мс`);
  }
  check(r.voiceGain >= 3, `чёткий голос: голос над фоном +${r.voiceGain} дБ (нужно ≥ 3)`);
  check(r.corrOn !== r.corrOff, 'объёмный звук меняет картину в ушах');

  // Живой <video> через createAudioFx: обработка звучит, элемент молчит; синхронизация с картинкой; громкость и mute;
  // смена источника (как при смене качества); «всё выкл» — элемент снова звучит сам, Web Audio спит
  const live = await js(`(async () => {
    const { createAudioFx } = await import('/js/audio.js');
    // тон 440 Гц и щелчок на 1,000 с
    const SR = 48000; const N = SR * 3; const data = new Int16Array(N * 2);
    for (let i = 0; i < N; i++) { const v = i >= SR && i < SR + 48 ? 31000 : Math.round(Math.sin(2 * Math.PI * 440 * i / SR) * 0.3 * 32767); data[i * 2] = v; data[i * 2 + 1] = v; }
    const hdr = new DataView(new ArrayBuffer(44)); const w = (o, s) => [...s].forEach((c, i) => hdr.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); hdr.setUint32(4, 36 + data.byteLength, true); w(8, 'WAVEfmt '); hdr.setUint32(16, 16, true); hdr.setUint16(20, 1, true);
    hdr.setUint16(22, 2, true); hdr.setUint32(24, SR, true); hdr.setUint32(28, SR * 4, true); hdr.setUint16(32, 4, true); hdr.setUint16(34, 16, true);
    w(36, 'data'); hdr.setUint32(40, data.byteLength, true);
    const wav = () => URL.createObjectURL(new Blob([hdr, data], { type: 'audio/wav' }));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const video = document.createElement('video'); video.loop = true; video.src = wav(); document.body.append(video);
    await new Promise((r) => video.addEventListener('canplaythrough', r, { once: true }));
    for (const k of ['AUDIO_LEVEL', 'AUDIO_VOICE', 'AUDIO_SURROUND']) localStorage.removeItem('anixart.pref.' + k);
    const fx = createAudioFx({ video });
    const o = { untouched: fx.debug().ctx === null }; // всё выключено — Web Audio не создаётся
    await fx.set('voice', true); await fx.set('surround', true);
    await video.play(); await sleep(500);
    const d = fx.debug();
    const meter = async (node) => { const an = new AnalyserNode(d.ctx, { fftSize: 4096 }); node.connect(an); await sleep(250); const b = new Float32Array(an.fftSize); an.getFloatTimeDomainData(b); node.disconnect(an); return Math.sqrt(b.reduce((s, v) => s + v * v, 0) / b.length); };
    o.fx = { routed: d.routed, state: d.ctx.state, elementMuted: video.muted, level: await meter(d.out) };
    fx.setVolume(0.5); const half = await meter(d.out); o.elementVolume = video.volume;
    fx.setMuted(true); const mute = await meter(d.out); fx.setMuted(false); fx.setVolume(1);
    o.vol = { full: o.fx.level, half, mute };
    // синхронизация: щелчок на входе цепочки (у цепочки задержки нет) → момент вывода против момента, когда часы <video> прошли 1,000 с
    const det = 'registerProcessor("det", class extends AudioWorkletProcessor { constructor() { super(); this.port.onmessage = () => { this.done = false; }; } process([i]) { const x = i && i[0]; if (x && !this.done) for (let k = 0; k < x.length; k++) if (Math.abs(x[k]) > 0.6) { this.done = true; this.port.postMessage(currentTime + k / sampleRate); break; } return true; } });';
    await d.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([det], { type: 'text/javascript' })));
    const dn = new AudioWorkletNode(d.ctx, 'det'); const sink = new GainNode(d.ctx, { gain: 0 }); dn.connect(sink).connect(d.ctx.destination);
    d.chain.input.connect(dn);
    o.sync = [];
    for (let k = 0; k < 3; k++) {
      video.pause(); video.currentTime = 0; await sleep(300); dn.port.postMessage('reset');
      const heard = new Promise((res) => { dn.port.onmessage = (e) => { const ts = d.ctx.getOutputTimestamp(); res(ts.performanceTime + (e.data - ts.contextTime) * 1000); }; });
      await video.play(); let cross = 0;
      await new Promise((res) => { const tick = () => { const ct = video.currentTime; if (ct >= 1) { cross = performance.now() - (ct - 1) * 1000; res(); } else setTimeout(tick, 0); }; tick(); });
      const h = await Promise.race([heard, sleep(2000).then(() => null)]);
      o.sync.push(h == null ? null : +(h - cross).toFixed(1));
    }
    d.chain.input.disconnect(dn);
    // смена источника — новая дорожка захвата
    video.src = wav(); await new Promise((r) => video.addEventListener('canplaythrough', r, { once: true })); await video.play(); await sleep(400);
    o.afterSrc = await meter(d.out);
    await fx.set('voice', false); await fx.set('surround', false); await sleep(200);
    o.off = { routed: fx.debug().routed, elementMuted: video.muted, elementVolume: video.volume, state: d.ctx.state, track: !!fx.debug().track };
    o.saved = [localStorage.getItem('anixart.pref.AUDIO_VOICE'), localStorage.getItem('anixart.pref.AUDIO_SURROUND')];
    await fx.set('level', true); await sleep(500);
    o.again = { level: await meter(d.out), elementMuted: video.muted };
    o.latency = (d.ctx.baseLatency + d.ctx.outputLatency) * 1000;
    fx.destroy(); video.pause();
    return o;
  })()`);
  console.log('живой <video>:', JSON.stringify(live));
  check(live.untouched, 'всё выключено — звук не трогаем, AudioContext не создаётся');
  check(live.fx.state === 'running' && live.fx.routed === 'fx' && live.fx.level > 0.05, `обработка звучит (уровень ${live.fx.level?.toFixed(3)})`);
  check(live.fx.elementMuted && live.elementVolume === 1, 'пока звучит обработка, сам <video> молчит (без двойного звука)');
  check(Math.abs(live.vol.half / live.vol.full - 0.5) < 0.08 && live.vol.mute < 0.001, 'громкость и mute плеера работают и с обработкой');
  check(live.sync.every((x) => x != null && Math.abs(x) <= 30), `звук совпадает с картинкой в пределах ±30 мс (${live.sync.join(', ')} мс)`);
  check(live.afterSrc > 0.05, `после смены источника обработка звучит (${live.afterSrc?.toFixed(3)})`);
  check(live.off.routed === 'off' && !live.off.elementMuted && live.off.elementVolume === 1 && !live.off.track && live.off.state === 'suspended',
    'всё выключили — <video> снова звучит сам (родная синхронизация), захват остановлен, Web Audio спит');
  check(live.saved[0] === 'false' && live.saved[1] === 'false', 'переключатели запоминаются');
  check(live.again.level > 0.05 && live.again.elementMuted, 'повторное включение работает');
  console.log(`задержка вывода AudioContext: ${live.latency.toFixed(1)} мс — компенсируется: захват приходит раньше картинки`);

  console.log(bad ? `AUDIO FAIL: ${bad}` : 'AUDIO OK');
  srv.server.close();
  app.exit(bad ? 1 : 0);
});
