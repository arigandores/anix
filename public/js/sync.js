// Синхронизация истории просмотра между устройствами одного аккаунта Anixart (ПК и телефон): последняя серия аниме
// (номер, озвучка, источник), место в сериях и отметки. Сервер — cloud/sync (Cloudflare Worker + D1), слияние —
// sync-merge.js: по каждой серии побеждает более свежая запись.
// Отправка: изменившиеся аниме копятся в очереди (localStorage — переживает закрытие приложения и сбой сети) и
// уходят во время просмотра не чаще раза в 30 с, а сразу — на паузе, при закрытии плеера, уходе из приложения
// (свернули, телефон заблокирован) и закрытии окна. Не ушло — уйдёт при следующем запуске.
// Получение: при запуске и входе, возврате в приложение, открытии страницы аниме и раз в 2 мин, пока окно на виду.
// Без входа в аккаунт или с выключенной настройкой — ни одного запроса; накопленное без входа уйдёт после входа.
// Аккаунты: история устройства принадлежит первому вошедшему — она уходит в его аккаунт. Вход в другой аккаунт
// чужую историю ему не отправляет, только новое.
import { auth } from './api.js';
import { db, prefs, onWatchChange, setSyncClock } from './store.js';
import { lastAt, epAt } from './sync-merge.js';

const SERVER = 'https://anix-sync.seva-lazuka.workers.dev';
const base = () => localStorage.getItem('anixart.sync.url') || SERVER; // тесты — свой сервер
// pushPip — в «картинке в картинке» на телефоне: приложение уже свёрнуто, его могут смахнуть в любой момент
const TIMING = { push: 30000, pushPip: 10000, quick: 1500, pullGap: 10000, pullEvery: 120000, timeout: 15000, retry: 30000, retryMax: 300000, leave: 2500 };
const T = (k) => window.__anixSyncTiming?.[k] ?? TIMING[k]; // тесты подменяют короткими
// Запросы маленькие: у части провайдеров соединения с зарубежными хостингами «замерзают» после ~16 КБ — зависший
// запрос обрывается по таймауту и повторяется позже, а отправленное до него уже на сервере
const BATCH = 8 * 1024; // байт в одной отправке
const KEEPALIVE = 60 * 1024; // запросы при закрытии страницы (keepalive) — не больше 64 КБ на все

const K = { dirty: 'anixart.sync.dirty', state: 'anixart.sync.state', known: 'anixart.sync.known' };
function load(key, def) { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? def; } catch { return def; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }
// owner — чья история на устройстве; cursors — до какого места получено (по аккаунтам); skew — поправка часов
const state = () => load(K.state, { owner: null, cursors: {}, skew: 0 });
const setState = (patch) => save(K.state, { ...state(), ...patch });

// --- Что уже есть на сервере: время изменения его записей { rid: { ключ: at } } (аккаунта pid) — из полученного и
// отправленного. Уходит только то, что у устройства новее: телефон после ПК сначала получает историю и отправляет
// лишь своё новое, а не всё подряд. Сервер и сам не перезапишет запись не новее — это экономит запросы
const knownOf = (pid) => { const k = load(K.known, null); return k?.pid === pid ? k.map : {}; };
function remember(pid, releases) {
  const map = knownOf(pid);
  for (const [rid, rel] of Object.entries(releases || {})) {
    const m = (map[rid] ||= {});
    if (rel?.last) m.last = Math.max(m.last || 0, lastAt(rel.last));
    for (const [k, e] of Object.entries(rel?.eps || {})) m[k] = Math.max(m[k] || 0, epAt(e));
  }
  save(K.known, { pid, map });
}
// Отметка «просмотрено» из самого Anixart (без своего просмотра) — у Anixart она и так есть и придёт на любое
// устройство тем же путём (mergeServerMarks): не отправляем
const markOnly = (e) => e.isWatched && e.markedAt != null && !e.manual && !e.startedAt && !e.savedAt && !e.playbackPosition && !e.finished;

let blocked = null; // токен, который сервер не принял (403): не стучимся, пока не сменится вход
const enabled = () => !!(prefs.get('SYNC_HISTORY') && auth.loggedIn && auth.profileId && blocked !== auth.token);

// --- Очередь: аниме → { n — счётчик изменений, keys — изменившиеся записи (sync-merge.js) или all — всё аниме }.
// Отправленное снимается, только если за время отправки аниме не менялось
function markDirty(r, keys = null) {
  const d = load(K.dirty, {});
  const cur = d[r] || { n: 0, keys: [] };
  cur.n++;
  if (!keys) cur.all = true; else if (!cur.all) cur.keys = [...new Set([...cur.keys, ...keys])];
  d[r] = cur;
  save(K.dirty, d);
}

async function request(method, path, body, keepalive = false) {
  const t0 = Date.now();
  const r = await fetch(base() + path, {
    method, keepalive,
    headers: { 'X-Anix-Token': auth.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(T('timeout')), // ничего не висит: соединение замерло — обрыв и повтор позже
  });
  if (r.status === 403) { blocked = auth.token; throw new Error('sync: токен не принят'); }
  if (!r.ok) throw new Error(`sync: ${r.status}`);
  const j = await r.json();
  // часы сервера — посередине запроса: поправка для времени изменения записей (store.js)
  if (j.now) { const skew = Math.round(j.now - (t0 + Date.now()) / 2); setSyncClock(skew); setState({ skew }); }
  return j;
}

// --- Отправка ---
let timer = null; let timerAt = 0; let lastPush = 0; let fails = 0;
// отправить через ms (если уже назначено раньше — оставить)
function schedule(ms) {
  if (!enabled()) return;
  const at = Date.now() + ms;
  if (timer && timerAt <= at) return;
  clearTimeout(timer); timerAt = at;
  timer = setTimeout(() => { timer = null; flush(); }, ms);
}
let pushing = null; let again = false;
export function flush(opts) {
  if (pushing) { again = true; return pushing; }
  pushing = push(opts).then(() => { fails = 0; }, () => {
    if (!enabled()) return;
    fails++; schedule(Math.min(T('retryMax'), T('retry') * 2 ** (fails - 1))); // сеть или сервер — позже, реже и реже
  }).finally(() => { pushing = null; if (again) { again = false; schedule(T('quick')); } });
  return pushing;
}
async function push({ keepalive = false } = {}) {
  if (!enabled()) return;
  const pid = auth.profileId;
  const dirty = load(K.dirty, {});
  const rids = Object.keys(dirty);
  if (!rids.length) return;
  lastPush = Date.now();
  const known = knownOf(pid);
  const done = (list) => { // снять с очереди, если за время отправки аниме не менялось
    const d = load(K.dirty, {});
    for (const r of list) if (d[r]?.n === dirty[r].n) delete d[r];
    save(K.dirty, d);
  };
  // части: { r, rec, final } — длинное аниме режется по сериям (сервер сливает каждую запись отдельно). Только то,
  // что новее известного на сервере; отметки из Anixart — нет. Нечего отправлять — аниме просто снимается с очереди
  const parts = []; const nothing = [];
  for (const r of rids) {
    const entry = dirty[r]; const kn = known[r] || {};
    const rec = db.syncRecord(Number(r), entry.all ? null : entry.keys);
    const last = rec.last && lastAt(rec.last) > (kn.last || 0) ? rec.last : null;
    let part = { last, eps: {} }; let size = last ? JSON.stringify(last).length : 0; let any = !!last;
    for (const [k, e] of Object.entries(rec.eps)) {
      if (markOnly(e) || epAt(e) <= (kn[k] || 0)) continue;
      const s = JSON.stringify(e).length + k.length + 4;
      if (size && size + s > BATCH) { parts.push({ r, rec: part, size, final: false }); part = { last: null, eps: {} }; size = 0; }
      part.eps[k] = e; size += s; any = true;
    }
    if (any) parts.push({ r, rec: part, size, final: true }); else nothing.push(r);
  }
  done(nothing);
  let batch = []; let size = 0; let total = 0;
  const send = async () => {
    if (!batch.length) return;
    const releases = {};
    for (const p of batch) releases[p.r] = p.rec;
    await request('POST', '/v1/push', { pid, releases }, keepalive);
    remember(pid, releases);
    done(batch.filter((p) => p.final).map((p) => p.r));
    batch = []; size = 0;
  };
  for (const p of parts) {
    if (keepalive && total + p.size > KEEPALIVE) break; // остальное — при следующем запуске
    if (batch.length && (size + p.size > BATCH || batch.some((b) => b.r === p.r))) await send();
    batch.push(p); size += p.size; total += p.size;
  }
  await send();
}

// --- Получение ---
let pulling = null; let lastPull = 0;
export function syncPull({ force = false } = {}) {
  if (!enabled()) return Promise.resolve();
  if (pulling) return pulling;
  if (!force && Date.now() - lastPull < T('pullGap')) return Promise.resolve();
  lastPull = Date.now();
  pulling = pull().catch(() => {}).finally(() => { pulling = null; });
  return pulling;
}
async function pull() {
  const pid = auth.profileId;
  let cursor = state().cursors?.[pid] || '0:0:';
  for (let page = 0; page < 400; page++) {
    const j = await request('GET', `/v1/pull?pid=${pid}&cursor=${encodeURIComponent(cursor)}`);
    if (auth.profileId !== pid) return; // сменили аккаунт, пока шёл запрос
    remember(pid, j.releases);
    for (const r of db.applySync(j.releases)) window.dispatchEvent(new CustomEvent('watch-synced', { detail: { releaseId: r } }));
    cursor = j.cursor;
    setState({ cursors: { ...state().cursors, [pid]: cursor } });
    if (!j.more) return;
  }
}

// --- Уходим: плеер сохраняет место (app-leaving), очередь — на сервер ---
function leave() {
  window.dispatchEvent(new Event('app-leaving'));
  return flush({ keepalive: true });
}

// Вход, выход, смена аккаунта: чья история на устройстве и что отправлять
function onAuth() {
  blocked = null;
  if (!auth.loggedIn || !auth.profileId) return;
  const pid = auth.profileId; const st = state();
  if (st.owner !== pid) {
    if (st.owner == null) for (const r of db.ownReleases()) markDirty(r); // первый вход: своя история — в аккаунт
    else save(K.dirty, {}); // другой аккаунт: накопленное — не его
    setState({ owner: pid });
  }
  syncPull({ force: true }).then(() => flush());
}

// Настройка «Синхронизация истории» включена снова — догнать
export function syncSettingChanged() { if (enabled()) syncPull({ force: true }).then(() => flush()); }

export function initSync() {
  setSyncClock(state().skew || 0);
  onWatchChange((r, keys) => {
    markDirty(r, keys);
    const every = document.documentElement.classList.contains('android-pip') ? T('pushPip') : T('push');
    schedule(Math.max(T('quick'), lastPush + every - Date.now()));
  });
  window.addEventListener('auth-changed', onAuth);
  // пауза и закрытие плеера — сразу, не дожидаясь 30 с (пауза: событие видео ловим на document при погружении)
  document.addEventListener('pause', (e) => { if (e.target instanceof HTMLVideoElement) schedule(T('quick')); }, true);
  window.addEventListener('player-closed', () => schedule(T('quick')));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave(); else syncPull(); });
  window.addEventListener('pagehide', leave);
  window.addEventListener('focus', () => syncPull());
  window.addEventListener('online', () => { syncPull({ force: true }); schedule(T('quick')); });
  setInterval(() => { if (document.visibilityState === 'visible') syncPull(); }, T('pullEvery'));
  // закрытие окна на ПК (electron/main.js) и уход из приложения на телефоне (MainActivity: потеря фокуса, onPause, onStop)
  window.__anixLeave = () => Promise.race([leave(), new Promise((ok) => setTimeout(ok, T('leave')))]).then(() => true);
  onAuth();
}
