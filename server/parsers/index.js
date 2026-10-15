'use strict';
// Парсеры видеоисточников (11 штук).
// Результат: { playback: {quality: url}, download: {quality: url}, referer, cookie }
// playback — для плеера, download — для скачивания (отличается только у Kodik).
const crypto = require('crypto');
const config = require('../config');
const { parseKodikSkipButton, skipFromLibriaEpisode } = require('./skip-marks');

// Источник с ключом, которого нет в конфиге (server/config.js)
function needKey(name, value) {
  if (!value) throw new Error(`Источник ${name} недоступен в этой сборке: нет ключа в config.local.json`);
  return value;
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/86.0.4240.198 Safari/537.36';
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9';

const KODIK = ['kodik.cc', 'kodik.info', 'aniqit.com', 'kodikplayer.com'];
const STUDIOMIR = ['studiomir.club', 'api.studiomir.club'];
const MYVI = ['www.myvi.top', 'myvi.top'];
const ALLVIDEO = ['secvideo1.online', 'csst.online', 'sstrge.online'];
const ANILIBRIA = ['anilibria.tv', 'new.anilib.one', 'anixart.libria.fun', 'anilibria.top'];
const VKVIDEO = ['vkvideo.ru', 'vk.com'];
const RUTUBE = ['rutube.ru'];
const OKRU = ['ok.ru', 'm.ok.ru'];

// Запрос: новый клиент, таймаут 20 с, UA по умолчанию, тело возвращается при любом статусе.
async function request(url, { follow = true, headers = {}, form = null, ua = '' } = {}) {
  const h = { 'User-Agent': ua || DEFAULT_UA, Accept: ACCEPT, ...headers };
  const opts = { headers: h, redirect: follow ? 'follow' : 'manual', signal: AbortSignal.timeout(20000) };
  if (form && Object.keys(form).length) {
    opts.method = 'POST';
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  return fetch(url, opts);
}
async function getText(url, opts) { try { const r = await request(url, opts); return await r.text(); } catch { return ''; } }
async function getLocation(url, headers = {}, ua = '') {
  try { const r = await request(url, { follow: false, headers, ua }); return r.headers.get('location'); } catch { return null; }
}

// skip — таймкоды опенинга/эндинга { opening, ending } (skip-marks.js), если источник их отдаёт
class Result {
  constructor(input) { this.input = input; this.playback = {}; this.download = {}; this.cookie = ''; this.referer = ''; this.skip = null; }
  put(k, v) { this.playback[k] = v; this.download[k] = v; }
  toJSON() {
    return { playback: this.playback, download: this.download, cookie: this.cookie, referer: this.referer || this.input, skip: this.skip };
  }
}

function replaceAll(s, a, b) { return s.split(a).join(b); }

// ---------------- Kodik ----------------
// Основной путь без токена (как в anixapp): type/id/hash из ссылки плеера → kodikplayer.com/ftor.
// Ссылки в ответе зашифрованы: буквы сдвинуты на 18 по кругу, затем base64.
// Запасной путь — API kodikres.com, если в конфиге есть kodik.token.
const KODIK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function decryptKodikSrc(src) {
  const shifted = src.replace(/[a-zA-Z]/g, (ch) => {
    const c = ch.charCodeAt(0) + 18;
    return String.fromCharCode((ch <= 'Z' ? 90 : 122) >= c ? c : c - 26);
  });
  return Buffer.from(shifted, 'base64').toString('utf8');
}

async function kodikFtor(r, page, htmlP) {
  const m = /\/(seria|video|movie|anime)\/(\d+)\/([0-9a-f]+)/i.exec(new URL(page).pathname);
  let info = m && { type: m[1], id: m[2], hash: m[3] };
  if (!info) {
    const html = await htmlP;
    const v = (k) => (new RegExp(`\\w+\\.${k}\\s=\\s'([^']+)';`).exec(html) || [])[1];
    info = { type: v('type'), id: v('id'), hash: v('hash') };
    if (!info.type || !info.id || !info.hash) return;
  }
  const resp = await request(`https://kodikplayer.com/ftor?${new URLSearchParams(info)}`, {
    ua: KODIK_UA, headers: { Referer: page, Accept: 'application/json' },
  });
  if (!resp.ok) return;
  const links = (await resp.json()).links || {};
  for (const q of ['360', '480', '720', '1080']) {
    let s = links[q] && links[q][0] && links[q][0].src;
    if (!s) continue;
    if (!/^(https?:)?\/\//.test(s)) s = decryptKodikSrc(s);
    if (s.startsWith('//')) s = `https:${s}`;
    // прямой MP4 с CDN Kodik часто уводит на недоступный edge — берём его HLS-вариант
    if (/\.mp4$/i.test(new URL(s).pathname)) s += ':hls:manifest.m3u8';
    r.put(`${q}p`, replaceAll(s, ':hls:hls.m3u8', ':hls:manifest.m3u8'));
  }
}

async function kodik(r) {
  const page = `https://kodikplayer.com${new URL(r.input).pathname}`;
  // страница плеера — параллельно: в ней таймкоды опенинга и эндинга (parseSkipButton)
  const htmlP = getText(page, { ua: KODIK_UA, headers: { Referer: 'https://kodikplayer.com/' } });
  try { await kodikFtor(r, page, htmlP); } catch { /* запасной путь ниже */ }
  if (!Object.keys(r.playback).length && config.get('kodik.token')) await kodikApi(r);
  r.skip = parseKodikSkipButton(await htmlP);
}

async function kodikApi(r) {
  const parts = r.input.split('d=');
  if (parts.length < 2) throw new Error('Kodik: нет параметра d= (нужна ссылка из episode/target)');
  const link = replaceAll(parts[0].slice(0, -1), 'https://', '//');
  const token = needKey('Kodik', config.get('kodik.token'));
  const body = await getText(`https://kodikres.com/api/video-links?p=${token}&link=${link}&d=${parts[1]}`);
  for (const q of ['360', '480', '720', '1080']) {
    const m = new RegExp(`"${q}":\\{"[sS]rc":"(.*?)"`).exec(body);
    if (!m) continue;
    let s = m[1];
    if (!/(https:\/\/|http:\/\/)/.test(s)) s = `https:${s}`;
    r.playback[`${q}p`] = replaceAll(s, ':hls:hls.m3u8', ':hls:manifest.m3u8');
    r.download[`${q}p`] = replaceAll(replaceAll(s, ':hls:manifest.m3u8', ''), ':hls:hls.m3u8', '');
  }
}

// ---------------- Sibnet ----------------
async function sibnet(r, ctx) {
  const ua = ctx.sibnetUserAgent;
  const html = await getText(r.input, { ua });
  const m = /src: "(.*?)"/.exec(html);
  if (!m) return;
  let u = `https://video.sibnet.ru${m[1]}`;
  const loc = await getLocation(u, { Referer: r.input }, ua);
  if (loc) {
    const loc2 = await getLocation(`https:${loc}`, {}, ua);
    u = loc2 ? replaceAll(loc2, ':443', '') : `https:${loc}`;
  }
  r.put('Default', u);
}

// ---------------- SovetRomantica ----------------
async function sovetRomantica(r, ctx) {
  const html = await getText(r.input);
  const fm = /"file":"(.*?)"/.exec(html);
  if (!fm) return;
  const f = fm[1];
  const bm = /(.*\/).*.m3u8/.exec(f);
  const base = bm ? bm[1] : '';
  const m3u = await getText(f, { ua: ctx.sibnetUserAgent });
  const re = /RESOLUTION=.*x(.*)\n(.*)/g;
  let m;
  while ((m = re.exec(m3u))) {
    if (['360', '480', '720', '1080'].includes(m[1])) r.put(`${m[1]}p`, base + m[2]);
  }
}

// ---------------- Mail.ru ----------------
async function mailru(r) {
  const id = /embed\/([0-9]*)/.exec(r.input)[1];
  const resp = await request(`https://my.mail.ru/+/video/meta/${id}`);
  const cookies = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [];
  r.cookie = cookies.length ? cookies[cookies.length - 1] : (resp.headers.get('set-cookie') || '');
  const j = await resp.json();
  for (const v of j.videos || []) {
    const key = String(v.key || '');
    const q = key.includes('1080') ? '1080p' : key.includes('720') ? '720p' : key.includes('480') ? '480p' : '360p';
    r.put(q, `https:${v.url}`);
  }
}

// ---------------- Myvi ----------------
async function myvi(r, ctx) {
  const html = await getText(r.input, { ua: ctx.sibnetUserAgent });
  const m = /CreatePlayer\("v=(.*?)\\u0026/.exec(html);
  if (m) r.put('Default', decodeURIComponent(m[1].replace(/\+/g, ' ')));
}

// ---------------- Allvideo ----------------
function splitQualities(r, f, unescape = false) {
  const items = [...f.matchAll(/\[([0-9]*p)](.*?)(,|$)/g)];
  if (!items.length) return false;
  for (const it of items) {
    if (['360p', '480p', '720p', '1080p'].includes(it[1])) r.put(it[1], unescape ? replaceAll(it[2], '\\/', '/') : it[2]);
  }
  return true;
}
async function allvideo(r, ctx) {
  const html = await getText(r.input, { ua: ctx.sibnetUserAgent });
  const m = /file:"(.*?)"/.exec(html);
  if (!m) return;
  if (!splitQualities(r, m[1])) r.put('Default', m[1]);
}

// ---------------- AniLibria ----------------
async function anilibria(r, ctx) {
  const m = /id=(\d+)&ep=(\d+)/.exec(r.input);
  if (!m) return;
  const [, id, ep] = m;
  try {
    const j = JSON.parse(await getText(`https://anilibria.top/api/v1/anime/releases/${id}`));
    const e = (j.episodes || []).find((o) => String(o.ordinal) === String(ep));
    if (e) {
      r.skip = skipFromLibriaEpisode(e);
      if (e.hls_1080 && e.hls_1080.trim()) r.put('1080p', e.hls_1080);
      if (e.hls_720 && e.hls_720.trim()) r.put('720p', e.hls_720);
      if (e.hls_480 && e.hls_480.trim()) r.put('480p', e.hls_480);
    }
  } catch { /* fallback ниже */ }
  if (Object.keys(r.playback).length) return;
  const html = await getText(r.input, { ua: ctx.sibnetUserAgent });
  const fm = new RegExp(`"s${ep}".*?"file":"(.*?)"`).exec(html);
  if (fm && !splitQualities(r, fm[1], true)) r.put('Default', fm[1]);
}

// ---------------- StudioMir ----------------
async function studiomir(r, ctx) {
  const apiKey = needKey('StudioMir', config.get('studiomir.apiKey'));
  try {
    const ani = /[?&]ani=(\d+)/.exec(r.input)[1];
    const ep = /[&?]ep=(\d+)/.exec(r.input)[1];
    const arr = JSON.parse(await getText(`https://api.studiomir.club/api?ani=${ani}&apikey=${apiKey}`, { ua: ctx.sibnetUserAgent }));
    const list = ((arr[0] && arr[0].players && arr[0].players.tsm) || []).filter((t) => String(t.episode) === String(ep));
    const t = list.find((x) => x.type === 'TV') || list.find((x) => x.type !== 'TR') || list[0];
    if (!t) return;
    const hls = t.hls || {};
    for (const q of ['2160p', '1080p', '720p']) if (hls[q] && String(hls[q]).trim()) r.put(q, hls[q]);
    if (!Object.keys(r.playback).length && t.url && String(t.url).trim()) r.put('Default', t.url);
  } catch { /* ошибки источника проглатываются */ }
}

// ---------------- VK Video ----------------
async function vkvideo(r) {
  const clientId = needKey('VK Видео', config.get('vkVideo.clientId'));
  const clientSecret = needKey('VK Видео', config.get('vkVideo.clientSecret'));
  const s = decodeURIComponent(r.input);
  let owner; let id; let key;
  if (s.includes('video_ext.php')) {
    owner = (/[?&]oid=(-?\d+)/.exec(s) || [])[1];
    id = (/[?&]id=(\d+)/.exec(s) || [])[1];
    key = (/[?&]hash=([a-f0-9]+)/.exec(s) || [])[1];
  } else {
    let m = /(?:video|clip)(-?\d+)_(\d+)(?:_([a-f0-9]+))?/.exec(s);
    if (!m) { const z = /[?&]z=([^&]+)/.exec(s); if (z) m = /(?:video|clip)(-?\d+)_(\d+)(?:_([a-f0-9]+))?/.exec(z[1]); }
    if (m) [, owner, id, key] = m;
  }
  if (!owner || !id) return;
  const dev = crypto.randomUUID().toUpperCase();
  const ua = 'com.vk.vkvideo.prod/822 (iPhone, iOS 16.7.7, iPhone10,4, Scale/2.0) SAK/1.119';
  const tok = JSON.parse(await getText(`https://oauth.vk.com/oauth/get_anonym_token?client_id=${clientId}&client_secret=${clientSecret}&device_id=${dev}`, { ua }));
  if (!tok.token || !tok.expired_at) return;
  const resp = await request('https://api.vk.com/method/video.get', {
    ua, form: { anonymous_token: tok.token, device_id: dev, lang: 'en', v: '5.244', videos: `${owner}_${id}${key ? `_${key}` : ''}` },
  });
  const j = await resp.json();
  if (j.error) return;
  const it = j.response && j.response.items && j.response.items[0];
  if (!it || it.restriction) return;
  for (const q of [2160, 1440, 1080, 720, 480, 360]) {
    const f = it.files && it.files[`mp4_${q}`];
    if (f) r.put(`${q}p`, f);
  }
}

// ---------------- RuTube ----------------
async function rutube(r, ctx) {
  let id; let p;
  const pm = /rutube\.ru\/video\/private\/([a-f0-9]{32})(?:\?p=([^&]+))?/.exec(r.input);
  if (pm) { [, id, p] = pm; } else {
    const m = /rutube\.ru\/video\/([a-f0-9]{32})/.exec(r.input) || /rutube\.ru\/play\/embed\/([a-f0-9]{32})/.exec(r.input) || /rutube\.ru\/shorts\/([a-f0-9]{32})/.exec(r.input);
    if (m) id = m[1];
  }
  if (!id) return;
  r.referer = 'https://rutube.ru/';
  const headers = { Referer: 'https://rutube.ru/' };
  const j = JSON.parse(await getText(`https://rutube.ru/api/play/options/${id}/?no_404=true&referer&pver=v2${p ? `&p=${p}` : ''}`, { headers, ua: ctx.sibnetUserAgent }));
  if (j.detail || !j.video_balancer || (j.live_streams && j.live_streams.hls && j.live_streams.hls.length)) return;
  const m3u = await getText(j.video_balancer.m3u8, { headers, ua: ctx.sibnetUserAgent });
  const lines = m3u.split('\n');
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    const next = (lines[i + 1] || '').trim();
    if (res && next && !next.startsWith('#')) variants.push({ max: Math.max(+res[1], +res[2]), url: next });
  }
  variants.sort((a, b) => b.max - a.max);
  for (const v of variants) {
    const label = v.max >= 3840 ? '2160p' : v.max >= 2560 ? '1440p' : v.max >= 1920 ? '1080p' : v.max >= 1280 ? '720p' : v.max >= 854 ? '480p' : v.max >= 640 ? '360p' : null;
    if (label) r.put(label, v.url);
  }
}

// ---------------- OK.ru ----------------
async function okru(r, ctx) {
  const html = await getText(r.input, { ua: ctx.sibnetUserAgent });
  const m = /data-options="(.*?)"/.exec(html);
  if (!m) return;
  const d = m[1].split('&quot;').join('"').split('\\"').join('"').split('\\\\').join('\\');
  if (!d.includes('"provider":"UPLOADED_ODKL"') || d.includes('"is_live":true')) return;
  const map = { hd: '720p', sd: '480p', low: '360p', full: '1080p', quad: '1440p', ultra: '2160p' };
  for (const x of d.matchAll(/"name":"(\w+)".*?"url":"(.*?)"/g)) {
    const u = replaceAll(x[2], '\\u0026', '&');
    if (u.startsWith('http') && !u.includes('disallowed') && map[x[1]]) r.put(map[x[1]], u);
  }
}

function pickParser(url) {
  const host = new URL(url).host;
  if (KODIK.includes(host)) return kodik;
  if (host === 'video.sibnet.ru') return sibnet;
  if (host === 'sovetromantica.com') return sovetRomantica;
  if (host === 'my.mail.ru') return mailru;
  if (MYVI.includes(host)) return myvi;
  if (ALLVIDEO.includes(host)) return allvideo;
  if (ANILIBRIA.includes(host)) return anilibria;
  if (STUDIOMIR.includes(host)) return studiomir;
  if (VKVIDEO.includes(host)) return vkvideo;
  if (RUTUBE.includes(host)) return rutube;
  if (OKRU.includes(host)) return okru;
  throw new Error('Invalid url');
}

async function parse(url, ctx = {}) {
  const fn = pickParser(url);
  const r = new Result(url);
  await fn(r, { sibnetUserAgent: ctx.sibnetUserAgent || '' });
  return r.toJSON();
}

function isKodik(url) { try { return KODIK.includes(new URL(url).host); } catch { return false; } }

module.exports = { parse, isKodik, DEFAULT_UA };
