'use strict';
// Локальный сервер Anix Desktop.
//  /api/*     — прокси к бекенду Anixart с заголовками мобильного клиента
//  /parse     — серверные парсеры видео
//  /stream    — прокси медиа (Range, Referer/UA, перезапись m3u8) для источников без CORS
//  остальное  — статический фронтенд из public/
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { apiHeaders, setCodecProfile, VERSION_CODE } = require('./sign');
const { parse } = require('./parsers');
const social = require('./social');
const config = require('./config');
const ai = require('./ai');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEFAULT_API = 'https://api-s.anixsekai.com/'; // адрес бекенда по умолчанию
const URLS_JSON = 'https://anixhelper.github.io/pages/urls.json'; // актуальные адреса бекенда

let apiBase = DEFAULT_API;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

async function resolveApiBase() {
  // Адрес бекенда: config/urls или GitHub Pages urls.json. Мобильный источник адресов на ПК недоступен,
  // поэтому берём urls.json (ключ страны "default" — у ПК нет SIM) и проверяем доступность.
  if (process.env.ANIXART_API_BASE) return (apiBase = process.env.ANIXART_API_BASE); // для тестов
  const candidates = [];
  try {
    const r = await fetch(URLS_JSON, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const entry = j.default || Object.values(j)[0];
    if (entry && entry.api_url) candidates.push(entry.api_url);
  } catch (_) { /* сеть/GitHub недоступен */ }
  candidates.push(DEFAULT_API);
  for (const c of candidates) {
    try {
      const u = new URL(`config/urls?version_code=${VERSION_CODE}&is_beta=false`, c);
      const r = await fetch(u, { headers: apiHeaders(), signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        apiBase = c.endsWith('/') ? c : c + '/';
        try {
          const j = await r.json();
          const list = j && j.api_urls; // первый — основной
          if (Array.isArray(list) && list.length && typeof list[0] === 'string') apiBase = list[0];
        } catch (_) { /* формат ответа не критичен */ }
        return apiBase;
      }
    } catch (_) { /* пробуем следующий */ }
  }
  return apiBase;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

// Последние ошибки прокси (для диагностики: GET /__errors)
const errorLog = [];
function logError(entry) {
  const e = { at: new Date().toISOString(), ...entry };
  errorLog.push(e);
  if (errorLog.length > 200) errorLog.shift();
  console.error('[proxy]', JSON.stringify(e));
}

// Запрос к бекенду с повторами при кратковременных сбоях:
// GET — при сетевой ошибке, таймауте или 502/503/504; POST (могут быть записи: голос, комментарий) —
// только если соединение не установилось, т.е. запрос точно не дошёл до сервера.
const RETRY_DELAYS = [300, 900];
const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);
async function fetchUpstream(target, opts) {
  const idempotent = opts.method === 'GET' || opts.method === 'HEAD';
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= RETRY_DELAYS.length;
    try {
      const r = await fetch(target, { ...opts, signal: AbortSignal.timeout(idempotent ? 15000 : 30000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (idempotent && !last && [502, 503, 504].includes(r.status)) {
        logError({ path: target.pathname, status: r.status, retry: attempt + 1 });
      } else return { r, buf };
    } catch (e) {
      const code = (e && e.cause && e.cause.code) || (e && e.name) || '';
      if (last || !(idempotent || CONNECT_ERRORS.has(code))) throw e;
      logError({ path: target.pathname, error: String(e && e.message || e), cause: code, retry: attempt + 1 });
    }
    await new Promise((ok) => setTimeout(ok, RETRY_DELAYS[attempt]));
  }
}

async function handleApi(req, res, url) {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    if (res.statusCode >= 400 || ms > 3000) logError({ path: url.pathname, status: res.statusCode, ms });
  });
  const target = new URL(url.pathname.replace(/^\/api\//, '') + url.search, apiBase);
  const headers = apiHeaders();
  const ct = req.headers['content-type'];
  if (ct) headers['Content-Type'] = ct;
  if (req.headers['x-api-version']) headers['API-Version'] = req.headers['x-api-version'];
  const opts = { method: req.method, headers, redirect: 'follow' };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await readBody(req);
    // Мобильный клиент всегда шлёт тело POST, даже пустое
    opts.body = body;
  }
  const { r, buf } = await fetchUpstream(target, opts);
  if (target.pathname.endsWith('/config/toggles')) {
    try { setCodecProfile(JSON.parse(buf.toString('utf8')).codecProfile); } catch (_) { /* ignore */ }
  }
  send(res, r.status, buf, { 'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8' });
}

async function handleParse(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return sendJson(res, 400, { error: 'url required' });
  try {
    const result = await parse(target, { sibnetUserAgent: url.searchParams.get('sibnet_ua') || '' });
    sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 200, { error: String(e && e.message || e), playback: {}, download: {} });
  }
}

// Встроенный плеер: User-Agent Chrome/96 + Referer + Cookie (если есть)
const PLAYER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Safari/537.36';

function streamUrl(u, p) {
  let s = `/stream?url=${encodeURIComponent(u)}`;
  if (p.referer) s += `&referer=${encodeURIComponent(p.referer)}`;
  if (p.ua) s += `&ua=${encodeURIComponent(p.ua)}`;
  if (p.cookie) s += `&cookie=${encodeURIComponent(p.cookie)}`;
  return s;
}

function rewritePlaylist(text, base, p) {
  const abs = (u) => new URL(u, base).toString();
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${streamUrl(abs(u), p)}"`);
    }
    return streamUrl(abs(t), p);
  }).join('\n');
}

async function handleStream(req, res, url) {
  const target = url.searchParams.get('url');
  if (!target) return send(res, 400, 'url required');
  const p = {
    referer: url.searchParams.get('referer') || '',
    ua: url.searchParams.get('ua') || '',
    cookie: url.searchParams.get('cookie') || '',
  };
  const headers = { 'User-Agent': p.ua || PLAYER_UA };
  if (p.referer) headers.Referer = p.referer;
  if (p.cookie) headers.Cookie = p.cookie;
  if (req.headers.range) headers.Range = req.headers.range;
  headers['Accept-Encoding'] = 'identity'; // fetch иначе распакует gzip и content-length разойдётся с телом
  const r = await fetch(target, { headers, redirect: 'follow' });
  const ctype = r.headers.get('content-type') || '';
  const finalUrl = r.url || target;
  // Kodik отдаёт «…:hls:manifest.m3u8» с Content-Type video/MP2T, поэтому смотрим и на путь
  if (/mpegurl/i.test(ctype) || /\.m3u8(\?|$)/i.test(new URL(finalUrl).pathname + new URL(finalUrl).search)) {
    const text = await r.text();
    if (text.startsWith('#EXTM3U')) {
      return send(res, r.status, rewritePlaylist(text, finalUrl, p), {
        'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*',
      });
    }
    return send(res, r.status, text, { 'Content-Type': ctype || 'text/plain' });
  }
  const out = { 'Access-Control-Allow-Origin': '*' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = r.headers.get(h);
    if (v) out[h] = v;
  }
  if (r.headers.get('content-encoding')) delete out['content-length'];
  res.writeHead(r.status, out);
  if (!r.body) return res.end();
  const reader = r.body.getReader();
  req.on('close', () => reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise((ok) => res.once('drain', ok));
    }
  } catch (_) { /* клиент закрыл соединение */ }
  res.end();
}

// Сторонний плеер (mpv/VLC) с теми же Referer и Cookie, заголовок окна — название серии.
// На ПК запускаем mpv или VLC с теми же заголовками.
function findPlayer(custom) {
  const { execFileSync } = require('child_process');
  const candidates = [];
  if (custom) candidates.push(custom);
  for (const name of ['mpv', 'vlc']) {
    try {
      const out = execFileSync('where', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      candidates.push(...out.split(/\r?\n/).filter(Boolean));
    } catch (_) { /* нет в PATH */ }
  }
  candidates.push(
    'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
    'C:\\Program Files\\mpv\\mpv.exe',
  );
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }) || null;
}

async function handleExternal(req, res) {
  const { url, referer, cookie, title, player } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  if (!url) return sendJson(res, 400, { ok: false, error: 'url required' });
  const exe = findPlayer(player);
  if (!exe) return sendJson(res, 200, { ok: false, error: 'Сторонний плеер не найден (установите mpv или VLC)' });
  const ua = PLAYER_UA;
  const isVlc = /vlc/i.test(path.basename(exe));
  const args = isVlc
    ? [url, `--http-referrer=${referer || ''}`, `--http-user-agent=${ua}`, `--meta-title=${title || ''}`]
    : [url, `--referrer=${referer || ''}`, `--user-agent=${ua}`, `--force-media-title=${title || ''}`,
      ...(cookie ? [`--http-header-fields=Cookie: ${cookie}`] : [])];
  const { spawn } = require('child_process');
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  sendJson(res, 200, { ok: true, player: exe });
}

// Соцвход: /social/request?provider= → параметры окна; /social/exchange (POST) → токен для auth/<provider>
async function handleSocial(req, res, url) {
  const provider = url.searchParams.get('provider');
  try {
    // Google — в системном браузере (см. social.startBrowserLogin)
    if (url.pathname === '/social/google/start') {
      const n = social.startBrowserLogin();
      // localhost, а не 127.0.0.1: в разрешённых доменах Firebase-проекта есть только localhost
      const port = String(req.headers.host || '').split(':').pop();
      return sendJson(res, 200, { n, url: `http://localhost:${port}/google-auth.html?n=${n}` });
    }
    if (url.pathname === '/social/google/config') return sendJson(res, 200, social.googleWebConfig());
    if (url.pathname === '/social/google/result' && req.method === 'POST') {
      const { n, idToken, email } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return sendJson(res, 200, { ok: social.finishBrowserLogin(n, { idToken, email }) });
    }
    if (url.pathname === '/social/google/wait') {
      const r = await social.waitBrowserLogin(url.searchParams.get('n'));
      return sendJson(res, 200, r || { pending: true });
    }
    if (url.pathname === '/social/request') {
      return sendJson(res, 200, social.authRequest(provider));
    }
    if (url.pathname === '/social/exchange' && req.method === 'POST') {
      const params = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const result = await social.exchange(provider, params);
      return sendJson(res, 200, result);
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 200, { error: String(e && e.message || e) });
  }
}

function handleStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || !path.extname(p)) p = '/index.html'; // SPA history fallback
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname === '/parse') return await handleParse(req, res, url);
      if (url.pathname === '/stream') return await handleStream(req, res, url);
      if (url.pathname === '/external' && req.method === 'POST') return await handleExternal(req, res);
      if (url.pathname.startsWith('/social/')) return await handleSocial(req, res, url);
      if (url.pathname.startsWith('/ai/')) return await ai.handleAi(req, res, url);
      if (url.pathname.startsWith('/mcp/')) return await ai.handleMcp(req, res, url);
      if (url.pathname === '/__info') return sendJson(res, 200, { apiBase, versionCode: VERSION_CODE, appVersion: require('../package.json').version });
      if (url.pathname === '/__features') return sendJson(res, 200, config.features());
      if (url.pathname === '/__errors') return sendJson(res, 200, errorLog);
      return handleStatic(req, res, url);
    } catch (e) {
      logError({ path: url.pathname, error: String(e && e.message || e), cause: String(e && e.cause && (e.cause.code || e.cause.message) || '') });
      if (!res.headersSent) sendJson(res, 502, { code: -1, error: String(e && e.message || e) });
      else res.end();
    }
  });
}

async function start(port = Number(process.env.PORT) || 8371, host = '127.0.0.1') {
  await resolveApiBase();
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, ok);
  });
  const actual = server.address().port;
  ai.setPort(actual);
  server.on('close', () => ai.shutdown());
  return { server, port: actual, url: `http://${host}:${actual}/`, apiBase };
}

module.exports = { start };

if (require.main === module) {
  start().then(({ url, apiBase: b }) => {
    console.log(`Anix Desktop: ${url}  (API: ${b})`);
    if (process.argv.includes('--open')) {
      require('child_process').exec(`start "" "${url}"`);
    }
  }).catch((e) => { console.error(e); process.exit(1); });
}
