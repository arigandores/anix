'use strict';
// Ускорение апскейла на тензорных ядрах NVIDIA (TensorRT for RTX): главный процесс.
//
// Считает отдельная программа anix-trt.exe (trt/anix-trt.cu): кадр приходит из окна как RGBA (ipc), программа
// пишет результат в общую D3D11-текстуру из кольца, а сюда отдаёт её NT-хэндл. Здесь хэндлы импортируются
// (sharedTexture) и один раз на сеанс отправляются окну; дальше по каждому кадру окно получает только номер слота
// и берёт из своей копии VideoFrame — картинка до WebGPU идёт без копирования через память.
//
// Библиотеки TensorRT (93 МБ, лицензия NVIDIA) в установщик не входят: по согласию пользователя они скачиваются
// с PyPI (пакет NVIDIA tensorrt_rtx_cu13_libs) в папку данных приложения, хэш проверяется.
const { app, sharedTexture } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const TRT = {
  version: '1.7.1.116',
  url: 'https://files.pythonhosted.org/packages/92/84/858ba13bccd67f2bed699e976536a041270f9a0a14a447d3cd45fc4efae3/tensorrt_rtx_cu13_libs-1.7.1.116-py3-none-win_amd64.whl',
  sha256: '3f0bc38ffe0b755e9de672da7b9ed3c05ddfd2538160c36af2a1e0994508c940',
  size: 93129282,
  dlls: ['tensorrt_rtx_1_7.dll', 'tensorrt_onnxparser_rtx_1_7.dll'],
};
const MODELS_DIR = path.join(__dirname, '..', 'public', 'models', 'upscale-onnx');
const exePath = () => (app.isPackaged ? path.join(process.resourcesPath, 'anix-trt.exe') : path.join(__dirname, '..', 'trt', 'bin', 'anix-trt.exe'));
const baseDir = () => path.join(app.getPath('userData'), 'trt-rtx', TRT.version);
const dllDir = () => process.env.ANIX_TRT_DLLS || path.join(baseDir(), 'tensorrt_rtx_libs');
const cacheDir = () => process.env.ANIX_TRT_CACHE || path.join(app.getPath('userData'), 'trt-cache'); // кэш движков (тесты — общий)
const installed = () => TRT.dlls.every((f) => fs.existsSync(path.join(dllDir(), f)));

// ---------- программа anix-trt.exe: запросы по очереди, ответы — строки JSON ----------
let helper = null; // { proc, ready: Promise<info>, pending: [] }
let crashes = 0;
// без сеансов программа держит контекст CUDA (сотни МБ видеопамяти) — через 20 с простоя завершаем её
let idleTimer = null;
function idleLater() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (helper && !sessions.size) { try { helper.proc.stdin.end(); } catch { /* уже закрыт */ } helper = null; } }, 20000);
}
function startHelper() {
  clearTimeout(idleTimer);
  if (helper) return helper;
  fs.mkdirSync(cacheDir(), { recursive: true });
  const proc = spawn(exePath(), ['--parent', String(process.pid), '--dlls', dllDir(), '--cache', cacheDir()], { windowsHide: true });
  const h = { proc, pending: [], info: null };
  let buf = ''; let readyResolve; let readyReject;
  h.ready = new Promise((ok, fail) => { readyResolve = ok; readyReject = fail; });
  h.ready.catch(() => {});
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'ready') { h.info = msg; readyResolve(msg); continue; }
      if (msg.type === 'fatal') { readyReject(new Error(msg.error)); continue; }
      const w = h.pending.shift(); if (w) w.ok(msg);
    }
  });
  proc.stderr.on('data', (d) => console.warn('[anix-trt]', String(d).trim()));
  const die = (err) => {
    if (helper === h) helper = null;
    readyReject(err);
    for (const w of h.pending.splice(0)) w.fail(err);
    for (const s of sessions.values()) if (s.helper === h) s.dead = true;
  };
  proc.on('error', (e) => { crashes++; die(e); });
  proc.on('exit', (code) => { if (code) crashes++; die(new Error(`anix-trt завершилась (${code})`)); });
  helper = h;
  return h;
}
function request(h, type, json, bin) {
  return new Promise((ok, fail) => {
    const j = Buffer.from(JSON.stringify(json || {}));
    const hdr = Buffer.alloc(16);
    hdr.writeUInt32LE(0x54584E41, 0); hdr.writeUInt32LE(type, 4); hdr.writeUInt32LE(j.length, 8); hdr.writeUInt32LE(bin ? bin.length : 0, 12);
    h.pending.push({ ok, fail });
    h.proc.stdin.write(hdr); h.proc.stdin.write(j); if (bin) h.proc.stdin.write(bin);
  });
}

// ---------- состояние для окна ----------
let probe = null; // Promise<{ gpu, cc } | null>
const PROBE_MS = Number(process.env.ANIX_TRT_PROBE_MS) || 10000;
let install = null; // { received, total, error, promise }
// для тестов (test/upscale-fallback.js): ANIX_TRT_PROBE — ответ проверки видеокарты вместо запуска anix-trt
// (JSON: {"error": "..."} или {"gpu": "...", "cc": 6.1}; "hang" — не отвечает), ANIX_GPU_NVIDIA=0/1 — есть ли
// видеокарта NVIDIA, ANIX_TRT_PROBE_MS — сколько ждать ответа
async function hasNvidia() {
  if (process.env.ANIX_GPU_NVIDIA) return process.env.ANIX_GPU_NVIDIA === '1';
  try { const g = await app.getGPUInfo('basic'); return (g.gpuDevice || []).some((d) => d.vendorId === 0x10de); } catch { return false; }
}
async function status() {
  if (process.platform !== 'win32' || !fs.existsSync(exePath()) || !sharedTexture) return { supported: false, reason: 'platform' };
  if (!probe) {
    // проверка видеокарты — запуском anix-trt; не ответила за PROBE_MS (зависла на чужой видеокарте или драйвере) —
    // TensorRT считается недоступным, а улучшение работает на WebGPU, а не ждёт вечно
    const fake = process.env.ANIX_TRT_PROBE;
    const h = fake ? null : startHelper();
    const ready = fake === 'hang' ? new Promise(() => {}) : fake ? Promise.resolve(JSON.parse(fake)) : h.ready.then((i) => i, (e) => ({ error: String(e.message || e) }));
    let timer;
    const late = new Promise((ok) => { timer = setTimeout(() => ok({ error: `anix-trt не ответила за ${PROBE_MS / 1000} с` }), PROBE_MS); });
    probe = Promise.race([ready, late]).then((r) => {
      clearTimeout(timer);
      if (h && /не ответила/.test(r.error || '')) { try { h.proc.kill(); } catch { /* уже завершилась */ } if (helper === h) helper = null; }
      return r;
    });
    probe.then(() => idleLater());
  }
  const info = await probe;
  if (!info || info.error) {
    // видеокарта NVIDIA есть, но драйвер старый для CUDA 13 (нужна версия 580 или новее) — подсказать обновить;
    // без NVIDIA cudart отвечает той же ошибкой, поэтому смотрим, какая видеокарта стоит
    const err = String((info && info.error) || '');
    if (/insufficient|driver/i.test(err) && await hasNvidia()) return { supported: false, reason: 'driver', error: err };
    return { supported: false, reason: 'gpu', error: err };
  }
  // TensorRT for RTX: GeForce RTX 20 и новее (Turing, compute capability 7.5+)
  const supported = info.cc >= 7.5;
  return {
    supported, gpu: info.gpu, cc: info.cc, installed: installed(), size: TRT.size,
    installing: !!(install && !install.done), progress: install ? { received: install.received, total: install.total, error: install.error } : null,
  };
}

function download(url, file, onProgress) {
  return new Promise((ok, fail) => {
    const get = (u, left) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) { res.resume(); get(new URL(res.headers.location, u).href, left - 1); return; }
      if (res.statusCode !== 200) { res.resume(); fail(new Error(`HTTP ${res.statusCode}`)); return; }
      const total = Number(res.headers['content-length']) || TRT.size;
      const hash = crypto.createHash('sha256'); const out = fs.createWriteStream(file);
      let got = 0;
      res.on('data', (c) => { got += c.length; hash.update(c); onProgress(got, total); });
      res.pipe(out);
      out.on('finish', () => ok(hash.digest('hex')));
      res.on('error', fail); out.on('error', fail);
    }).on('error', fail);
    get(url, 5);
  });
}
function startInstall(onProgress) {
  if (install && !install.done) return install.promise;
  install = { received: 0, total: TRT.size, error: null, done: false };
  const st = install;
  st.promise = (async () => {
    const dir = baseDir(); fs.mkdirSync(dir, { recursive: true });
    const whl = path.join(dir, 'libs.whl');
    try {
      const sha = await download(TRT.url, whl, (r, t) => { st.received = r; st.total = t; onProgress(st); });
      if (sha !== TRT.sha256) throw new Error('файл повреждён (не совпал SHA-256)');
      // .whl — это zip; системный tar Windows 10+ (bsdtar) его распаковывает. Именно System32: tar из Git
      // (GNU) принимает «C:» за удалённый хост
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      await new Promise((ok, fail) => execFile(tar, ['-xf', whl, '-C', dir], { windowsHide: true }, (e) => (e ? fail(e) : ok())));
      if (!installed()) throw new Error('в пакете нет библиотек TensorRT');
      // программа уже запущена без библиотек — перезапустить, чтобы она их подхватила
      if (helper) { helper.proc.kill(); helper = null; }
      probe = null;
      return true;
    } catch (e) {
      st.error = String(e.message || e);
      throw e;
    } finally {
      fs.rmSync(whl, { force: true });
      st.done = true; onProgress(st);
    }
  })();
  st.promise.catch(() => {});
  return st.promise;
}

// ---------- сеансы: модель + размер кадра + кольцо текстур ----------
const sessions = new Map(); // id -> { helper, imported: [], dead }
let nextSession = 1;
// Открытия и закрытия — строго по очереди: новый сеанс закрывает старый вместе с его хэндлами, и если импорт
// текстур старого ещё идёт, он упал бы («Unable to duplicate handle»)
let chain = Promise.resolve();
function serial(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }
async function open(frame, { model, w, h }) {
  if (!/^[a-z0-9-]+$/.test(String(model))) throw new Error('неизвестная модель');
  const onnx = fs.readFileSync(path.join(MODELS_DIR, `${model}.onnx`));
  if (crashes > 3) throw new Error('ускорение отключено: программа TensorRT несколько раз завершилась с ошибкой');
  await closeAll();
  const hp = startHelper();
  await hp.ready;
  const r = await request(hp, 1, { model, w, h, ring: 3 }, onnx);
  if (!r.ok) throw new Error(r.error || 'не удалось открыть модель');
  const id = nextSession++;
  const s = { id, helper: hp, imported: [], dead: false, ow: r.ow, oh: r.oh };
  sessions.set(id, s);
  for (let slot = 0; slot < r.handles.length; slot++) {
    const nt = Buffer.alloc(8); nt.writeBigUInt64LE(BigInt(r.handles[slot]));
    const imp = sharedTexture.importSharedTexture({
      textureInfo: { pixelFormat: 'rgba', codedSize: { width: r.ow, height: r.oh }, visibleRect: { x: 0, y: 0, width: r.ow, height: r.oh }, handle: { ntHandle: nt } },
    });
    await sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imp }, { session: id, slot });
    imp.release(); // у окна — своя ссылка
  }
  return { ok: true, session: id, ow: r.ow, oh: r.oh, ring: r.handles.length, built: r.built, ms: r.ms };
}
async function closeAll() {
  const list = [...sessions.values()]; sessions.clear();
  for (const s of list) if (!s.dead && helper === s.helper) await request(s.helper, 3, {}).catch(() => {});
  idleLater();
}

function register(ipcMain) {
  ipcMain.handle('trt-status', () => status());
  ipcMain.handle('trt-install', (e) => startInstall((st) => {
    if (!e.sender.isDestroyed()) e.sender.send('trt-progress', { received: st.received, total: st.total, error: st.error, done: st.done });
  }).then(() => ({ ok: true }), (err) => ({ ok: false, error: String(err.message || err) })));
  ipcMain.handle('trt-open', (e, o) => serial(() => open(e.senderFrame, o)).catch((err) => ({ ok: false, error: String(err.message || err) })));
  ipcMain.handle('trt-frame', async (_e, o) => {
    const s = sessions.get(o.session);
    if (!s || s.dead) return { ok: false, error: 'сеанс закрыт' };
    const data = Buffer.from(o.data.buffer, o.data.byteOffset, o.data.byteLength);
    const meta = { slot: o.slot, w: o.w, h: o.h, fmt: String(o.fmt), matrix: String(o.matrix), full: o.full ? 1 : 0 };
    for (const k of ['o0', 's0', 'o1', 's1', 'o2', 's2']) meta[k] = Number(o[k]) || 0;
    const r = await request(s.helper, 2, meta, data).catch((err) => ({ ok: false, error: String(err.message || err) }));
    return r.ok === false ? r : { ok: true, slot: r.slot, ms: r.ms };
  });
  // закрыть сеанс session, если он ещё текущий (у окна их может быть несколько в полёте: плеер, бенчмарк)
  ipcMain.handle('trt-close', (_e, o) => serial(() => (o && o.session && !sessions.has(o.session) ? null : closeAll())).then(() => true));
  app.on('before-quit', () => { if (helper) { try { helper.proc.stdin.end(); } catch { /* уже закрыт */ } } });
}

module.exports = { register };
