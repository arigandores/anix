'use strict';
// Discord Rich Presence: «Смотрит <тайтл>» в профиле Discord. Живёт в локальном сервере, поэтому работает и в
// приложении, и в браузерном режиме. Привязывать Discord не нужно: статус уходит в Discord, запущенный на этом же
// компьютере, от имени приложения Discord из конфига (discord.clientId — один на всех пользователей сборки; в
// репозитории его нет, как и других ключей). Без него статус недоступен. Discord не запущен — статус ждёт.
// Локальный протокол Discord (IPC): именованный канал discord-ipc-N, кадр = op (int32 LE) + длина (int32 LE) + JSON.
// Нужны только рукопожатие и SET_ACTIVITY, поэтому без библиотек (@xhayper/discord-rpc тянет REST-клиент discord.js).
// Discord позволяет 5 обновлений за 20 с — частые обновления склеиваются.
const net = require('net');
const path = require('path');
const config = require('./config');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const RETRY_MS = 15000;
const MIN_GAP_MS = 4000; // не чаще одного обновления в 4 с
const TTL_MS = 3 * 60 * 1000; // окно подтверждает статус раз в минуту; пропало (закрыли вкладку) — статус убираем

function pipePath(i) {
  if (process.env.ANIX_DISCORD_PIPE) return `${process.env.ANIX_DISCORD_PIPE}-${i}`; // для тестов (test/discord.js)
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  return path.join(dir.replace(/\/$/, ''), `discord-ipc-${i}`);
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0); head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

function connectPipe(i = 0) {
  return new Promise((resolve, reject) => {
    if (i > 9) { reject(new Error('Discord не запущен')); return; }
    const s = net.createConnection(pipePath(i));
    s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
    s.once('error', () => { s.destroy(); connectPipe(i + 1).then(resolve, reject); });
  });
}

function createPresence(clientId) {
  let sock = null; let ready = false; let connecting = null;
  let want = null; // activity, которую надо показать (null — убрать статус)
  let sentKey = 'null'; let lastSent = 0; let timer = null; let retry = null;

  function onData(sockRef) {
    let buf = Buffer.alloc(0);
    return (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0); const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        let msg = null; try { msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8')); } catch { /* битый кадр */ }
        buf = buf.subarray(8 + len);
        if (op === OP.PING) sockRef.write(encode(OP.PONG, msg));
        else if (op === OP.CLOSE) sockRef.destroy();
        else if (op === OP.FRAME && msg && msg.evt === 'READY') { ready = true; sentKey = ''; schedule(0); }
      }
    };
  }

  function connect() {
    if (sock || connecting) return connecting;
    connecting = connectPipe().then((s) => {
      sock = s; ready = false;
      s.on('data', onData(s));
      s.on('close', () => { if (sock === s) { sock = null; ready = false; sentKey = 'null'; if (want) retryLater(); } });
      s.on('error', () => s.destroy());
      s.write(encode(OP.HANDSHAKE, { v: 1, client_id: clientId }));
    }).catch(() => { if (want) retryLater(); }).finally(() => { connecting = null; });
    return connecting;
  }
  function retryLater() {
    if (retry) return;
    retry = setTimeout(() => { retry = null; if (want) connect(); }, RETRY_MS);
  }

  function send() {
    timer = null;
    const key = JSON.stringify(want);
    if (key === sentKey) return;
    if (!want && !sock) { sentKey = key; return; }
    if (!sock || !ready) { connect(); return; } // отправится по READY
    sentKey = key; lastSent = Date.now();
    sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: want }, nonce: `${Date.now()}-${Math.random()}` }));
  }
  function schedule(delay) {
    if (timer) return;
    timer = setTimeout(send, Math.max(delay, lastSent + MIN_GAP_MS - Date.now(), 0));
  }

  return {
    // 'connected' — Discord получает статус, 'waiting' — есть что показать, но Discord не запущен, 'idle' — нечего
    state: () => (sock && ready ? 'connected' : want ? 'waiting' : 'idle'),
    // activity — объект Discord (type, details, state, timestamps, assets, buttons) или null
    set(activity) {
      want = activity || null;
      if (want && !sock) connect();
      schedule(300); // склеиваем пачку событий плеера (пауза + перемотка)
    },
    destroy() {
      want = null; clearTimeout(timer); clearTimeout(retry);
      if (sock && ready) sock.write(encode(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: 'bye' }));
      if (sock) sock.end();
      sock = null;
    },
  };
}

// Статус приходит из окна — пропускаем только известные поля в пределах лимитов Discord
function cleanActivity(a) {
  if (!a || typeof a !== 'object') return null;
  const str = (v, max = 128) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const url = (v) => (typeof v === 'string' && /^https:\/\//.test(v) && v.length <= 256 ? v : undefined);
  const num = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
  const out = {
    type: [0, 2, 3, 5].includes(a.type) ? a.type : 3,
    status_display_type: [0, 1, 2].includes(a.status_display_type) ? a.status_display_type : undefined,
    details: str(a.details), state: str(a.state), instance: false,
  };
  if (out.details && out.details.length < 2) out.details += ' '; // Discord требует от 2 символов
  if (out.state && out.state.length < 2) out.state += ' ';
  const ts = a.timestamps || {};
  if (num(ts.start)) out.timestamps = { start: num(ts.start), end: num(ts.end) };
  const as = a.assets || {};
  const assets = { large_image: url(as.large_image), large_text: str(as.large_text), small_image: url(as.small_image), small_text: str(as.small_text) };
  if (Object.values(assets).some(Boolean)) out.assets = assets;
  const buttons = (Array.isArray(a.buttons) ? a.buttons : []).map((b) => ({ label: str(b && b.label, 32), url: url(b && b.url) })).filter((b) => b.label && b.url).slice(0, 2);
  if (buttons.length) out.buttons = buttons;
  return JSON.parse(JSON.stringify(out)); // без undefined
}

// Запущен ли Discord: подключаемся к его каналу и сразу закрываем
function probe() {
  return connectPipe().then((s) => { s.destroy(); return true; }, () => false);
}

const clientId = () => process.env.ANIX_DISCORD_CLIENT_ID || config.get('discord.clientId'); // переменная — для тестов
let presence = null; let ttl = null;
const configured = () => !!clientId();

// Чужая страница в браузере тоже может слать запросы на localhost — статус меняет только само приложение
function sameOrigin(req) {
  const o = req.headers.origin; const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  if (o) { try { return new URL(o).host === req.headers.host; } catch { return false; } }
  return true;
}

//  POST /discord/presence  activity | null — показать / убрать статус
//  GET  /discord/status    { configured, running, state } — для настроек
async function handleDiscord(req, res, url, { readBody, sendJson }) {
  if (url.pathname === '/discord/status') {
    return sendJson(res, 200, { configured: configured(), running: configured() && await probe(), state: presence ? presence.state() : 'idle' });
  }
  if (url.pathname === '/discord/presence' && req.method === 'POST') {
    if (!sameOrigin(req) || !/json/.test(req.headers['content-type'] || '')) return sendJson(res, 403, { ok: false });
    if (!configured()) return sendJson(res, 200, { ok: false, state: 'off' });
    let activity = null;
    try { activity = cleanActivity(JSON.parse((await readBody(req)).toString('utf8') || 'null')); } catch { return sendJson(res, 400, { ok: false }); }
    if (!presence) presence = createPresence(clientId());
    presence.set(activity);
    clearTimeout(ttl);
    if (activity) ttl = setTimeout(() => presence && presence.set(null), TTL_MS);
    return sendJson(res, 200, { ok: true, state: presence.state() });
  }
  return sendJson(res, 404, { ok: false });
}

function shutdown() { clearTimeout(ttl); if (presence) presence.destroy(); presence = null; }

module.exports = { handleDiscord, shutdown, configured, clientId, cleanActivity, createPresence };
