// Клиент API Anixart. Все запросы идут через локальный прокси /api/*, который добавляет
// заголовки приложения (User-Agent, Sign, X-Media-Session, X-Codec-Profile).
// Токен передаётся query-параметром "token", как ожидает бекенд.

import { prefs } from './store.js';

const TOKEN_KEY = 'anixart.token';
const PROFILE_KEY = 'anixart.profile';

export const auth = {
  get token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  get profileId() { try { return Number(JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null')?.id || 0); } catch { return 0; } },
  get profile() { try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); } catch { return null; } },
  get loggedIn() { return !!this.token; },
  save(token, profile) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile ? { id: profile.id, login: profile.login, avatar: profile.avatar } : null));
    } catch { /* storage недоступен */ }
    window.dispatchEvent(new CustomEvent('auth-changed'));
  },
  clear() {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(PROFILE_KEY); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('auth-changed'));
  },
};

// Ссылки @id: повторно встречающийся объект бекенд присылает числом (@id).
// Восстанавливаем ссылки: число заменяется объектом, только если по этому ключу где-то в ответе
// уже лежал объект с тем же набором полей (иначе это обычное число).
export function resolveRefs(root) {
  const byId = new Map();
  const shapes = new Map(); // key -> Set(signature)
  const sig = (o) => Object.keys(o).filter((k) => k !== '@id').sort().join(',');
  (function collect(v, key) {
    if (Array.isArray(v)) { v.forEach((x) => collect(x, key)); return; }
    if (v && typeof v === 'object') {
      if (typeof v['@id'] === 'number') byId.set(v['@id'], v);
      if (key != null) {
        if (!shapes.has(key)) shapes.set(key, new Set());
        shapes.get(key).add(sig(v));
      }
      for (const k of Object.keys(v)) collect(v[k], k);
    }
  })(root, null);
  if (!byId.size) return root;
  const seen = new Set();
  (function fix(v) {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
    for (const [k, x] of entries) {
      const key = Array.isArray(v) ? v.__key : k;
      if (typeof x === 'number' && key && key !== '@id' && shapes.has(key) && byId.has(x)) {
        const target = byId.get(x);
        if (shapes.get(key).has(sig(target))) v[k] = target;
      } else if (Array.isArray(x)) {
        Object.defineProperty(x, '__key', { value: k, enumerable: false, configurable: true });
        fix(x);
      } else if (x && typeof x === 'object') fix(x);
    }
  })(root);
  return root;
}

function buildQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    q.append(k, String(v));
  }
  return q.toString();
}

// «Альтернативное соединение» (FORCE_SHOULD_USE_MIRROR_URLS):
// адреса статики переписываются на зеркала — s.anixmirai.com → mirror-s.anixmirai.com, anixmirai.com → mirror.anixmirai.com.
export function mirrorEnabled() { return !!(prefs.get('FORCE_SHOULD_USE_MIRROR_URLS') || prefs.get('SHOULD_USE_MIRROR_URLS')); }
export function toMirror(url, force = false) {
  try {
    const u = new URL(url);
    if (u.hostname.startsWith('mirror')) return url;
    const dom = prefs.get('STATIC_DOMAIN') || 'anixmirai.com';
    if (!force && !u.hostname.includes(dom) && !u.hostname.includes('static.anixart.tv')) return url;
    const p = u.hostname.split('.');
    u.hostname = p.length > 2 ? `mirror-${p[0]}.${p.slice(1).join('.')}` : `mirror.${u.hostname}`;
    return u.toString();
  } catch { return url; }
}
function mirrorDeep(root) {
  const seen = new WeakSet(); // после resolveRefs объекты могут повторяться
  const walk = (v) => {
    if (typeof v === 'string') return v.startsWith('http://') || v.startsWith('https://') ? toMirror(v) : v;
    if (!v || typeof v !== 'object' || seen.has(v)) return v;
    seen.add(v);
    for (const k of Object.keys(v)) v[k] = walk(v[k]);
    return v;
  };
  return walk(root);
}

export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

async function request(method, path, { query = {}, body, form, json, apiVersion, withToken = true } = {}) {
  const params = { ...query };
  if (withToken && auth.token && params.token === undefined) params.token = auth.token;
  const qs = buildQuery(params);
  const url = `/api/${path.replace(/^\//, '')}${qs ? `?${qs}` : ''}`;
  const headers = {};
  let payload;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = buildQuery(form);
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
    payload = JSON.stringify(json);
  } else if (body instanceof FormData) {
    payload = body;
  } else if (method === 'POST') {
    payload = '';
  }
  if (apiVersion) headers['X-Api-Version'] = apiVersion;
  const r = await fetch(url, { method, headers, body: payload });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status, data);
  const out = resolveRefs(data);
  return mirrorEnabled() ? mirrorDeep(out) : out;
}

export const api = {
  get: (path, query, opts = {}) => request('GET', path, { query, ...opts }),
  post: (path, json, query, opts = {}) => request('POST', path, { query, json, ...opts }),
  form: (path, form, query, opts = {}) => request('POST', path, { query, form, ...opts }),
  multipart: (path, formData, query) => request('POST', path, { query, body: formData }),
};

// Удобные обёртки над эндпоинтами бекенда
export const A = {
  // config
  toggles: () => api.get('config/toggles', { version_code: 26090418, is_beta: false, is_api_alt: mirrorEnabled() }).then((tg) => {
    if (tg.staticDomain) prefs.set('STATIC_DOMAIN', tg.staticDomain);
    if (typeof tg.shouldUseMirrorUrls === 'boolean') prefs.set('SHOULD_USE_MIRROR_URLS', tg.shouldUseMirrorUrls);
    // BASE_URL / EDITOR_URL / IFRAME-адреса тоже на зеркало
    if (mirrorEnabled()) for (const k of ['baseUrl', 'editorUrl', 'iframeEmbedUrl']) if (tg[k]) tg[k] = toMirror(tg[k], true);
    return tg;
  }),
  // auth
  signIn: (login, password) => api.form('auth/signIn', { login, password }, {}, { withToken: false }),
  signUp: (login, email, password) => api.form('auth/signUp', { login, email, password }, {}, { withToken: false }),
  verify: (f) => api.form('auth/verify', f, {}, { withToken: false }),
  resend: (f) => api.form('auth/resend', f, {}, { withToken: false }),
  restore: (data) => api.form('auth/restore', { data }, {}, { withToken: false }),
  restoreVerify: (f) => api.form('auth/restore/verify', f, {}, { withToken: false }),
  restoreResend: (f) => api.form('auth/restore/resend', f, {}, { withToken: false }),
  // соцвход — токен уже получен в окне Electron, передаётся в тело
  signInWithYandex: (token) => api.form('auth/yandex', { yandexAccessToken: token }, {}, { withToken: false }),
  signInWithVk: (token) => api.form('auth/vk', { vkAccessToken: token }, {}, { withToken: false }),
  signInWithTelegram: (token) => api.form('auth/telegram', { telegramIdToken: token }, {}, { withToken: false }),
  signInWithGoogle: (token) => api.form('auth/google', { googleIdToken: token }, {}, { withToken: false }),
  // discover
  interesting: () => api.post('discover/interesting'),
  discussing: () => api.post('discover/discussing'),
  watching: (page) => api.post(`discover/watching/${page}`),
  recommendations: (page, prev = -1) => api.post(`discover/recommendations/${page}`, undefined, { previous_page: prev }),
  commentsWeek: () => api.post('discover/comments'),
  // releases
  release: (id, extended = true) => api.get(`release/${id}`, { extended_mode: extended }),
  random: (extended = true) => api.get('release/random', { extended_mode: extended }),
  randomFavorite: (extended = true) => api.get('release/random/favorite', { extended_mode: extended }),
  randomProfileList: (pid, status, extended = true) => api.get(`release/random/profile/list/${pid}/${status}`, { extended_mode: extended }),
  randomCollection: (cid, extended = true) => api.get(`release/collection/${cid}/random`, { extended_mode: extended }),
  vote: (id, v) => api.get(`release/vote/add/${id}/${v}`),
  deleteVote: (id) => api.get(`release/vote/delete/${id}`),
  filter: (page, body, extended = true) => api.post(`filter/${page}`, body, { extended_mode: extended }),
  related: (relatedId, page) => api.get(`related/${relatedId}/${page}`, {}, { apiVersion: 'v2' }),
  schedule: () => api.get('schedule'),
  videoMain: (rid) => api.get(`video/release/${rid}`),
  videos: (rid, page) => api.get(`video/release/${rid}/${page}`),
  videoCategory: (rid, cid, page) => api.get(`video/release/${rid}/category/${cid}/${page}`),
  // episodes
  types: (rid) => api.get(`episode/${rid}`),
  sources: (rid, typeId) => api.get(`episode/${rid}/${typeId}`),
  episodes: (rid, typeId, sourceId, sort = 1) => api.get(`episode/${rid}/${typeId}/${sourceId}`, { sort }),
  episodeTarget: (rid, sid, pos) => api.get(`episode/target/${rid}/${sid}/${pos}`),
  episodeWatch: (rid, sid, pos) => api.post(pos == null ? `episode/watch/${rid}/${sid}` : `episode/watch/${rid}/${sid}/${pos}`),
  episodeUnwatch: (rid, sid, pos) => api.post(pos == null ? `episode/unwatch/${rid}/${sid}` : `episode/unwatch/${rid}/${sid}/${pos}`),
  episodeUpdates: (rid, page) => api.get(`episode/updates/${rid}/${page}`),
  historyAdd: (rid, sid, pos) => api.get(`history/add/${rid}/${sid}/${pos}`),
  historyDelete: (rid) => api.get(`history/delete/${rid}`),
  history: (page) => api.get(`history/${page}`),
  typePin: (rid, tid) => api.get(`type/pin/${rid}/${tid}`),
  typeUnpin: (rid, tid) => api.get(`type/unpin/${rid}/${tid}`),
  // lists & favorites
  listAdd: (status, rid) => api.get(`profile/list/add/${status}/${rid}`),
  listDelete: (status, rid) => api.get(`profile/list/delete/${status}/${rid}`),
  profileList: (status, page, sort, filterAnnounce) => api.get(`profile/list/all/${status}/${page}`, { sort, filter_announce: filterAnnounce }),
  profileListBy: (pid, status, page, sort, filterAnnounce) => api.get(`profile/list/all/${pid}/${status}/${page}`, { sort, filter_announce: filterAnnounce }),
  favAdd: (rid) => api.get(`favorite/add/${rid}`),
  favDelete: (rid) => api.get(`favorite/delete/${rid}`),
  favorites: (page, sort, filterAnnounce) => api.get(`favorite/all/${page}`, { sort, filter_announce: filterAnnounce }),
  // search
  searchReleases: (page, body) => api.post(`search/releases/${page}`, body, {}, { apiVersion: 'v2' }),
  searchProfiles: (page, body) => api.post(`search/profiles/${page}`, body),
  searchCollections: (page, body) => api.post(`search/collections/${page}`, body),
  searchFavoriteCollections: (page, body) => api.post(`search/favoriteCollections/${page}`, body),
  searchProfileCollections: (pid, page, body, rid) => api.post(`search/profileCollections/${pid}/${page}`, body, { release_id: rid }),
  searchFeed: (page, body) => api.post(`search/feed/${page}`, body),
  searchFavorites: (page, body) => api.post(`search/favorites/${page}`, body),
  searchHistory: (page, body) => api.post(`search/history/${page}`, body),
  searchProfileList: (status, page, body) => api.post(`search/profile/list/${status}/${page}`, body),
  searchArticles: (page, body) => api.post(`search/articles/${page}`, body),
  searchChannels: (page, body) => api.post(`search/channels/${page}`, body),
  // comments
  releaseComments: (rid, page, sort) => api.get(`release/comment/all/${rid}/${page}`, { sort }),
  releaseComment: (cid) => api.get(`release/comment/${cid}`),
  releaseCommentReplies: (cid, page, sort) => api.post(`release/comment/replies/${cid}/${page}`, undefined, { sort }),
  releaseCommentAdd: (rid, body) => api.post(`release/comment/add/${rid}`, body),
  releaseCommentEdit: (cid, body) => api.post(`release/comment/edit/${cid}`, body),
  releaseCommentDelete: (cid) => api.get(`release/comment/delete/${cid}`),
  releaseCommentVote: (cid, v) => api.get(`release/comment/vote/${cid}/${v}`),
  profileReleaseComments: (pid, page, sort) => api.get(`release/comment/all/profile/${pid}/${page}`, { sort }),
  collectionComments: (id, page, sort) => api.get(`collection/comment/all/${id}/${page}`, { sort }),
  collectionCommentReplies: (cid, page, sort) => api.post(`collection/comment/replies/${cid}/${page}`, undefined, { sort }),
  collectionCommentAdd: (id, body) => api.post(`collection/comment/add/${id}`, body),
  collectionCommentVote: (cid, v) => api.get(`collection/comment/vote/${cid}/${v}`),
  collectionCommentDelete: (cid) => api.get(`collection/comment/delete/${cid}`),
  articleComments: (id, page, sort) => api.get(`article/comment/all/${id}/${page}`, { sort }),
  articleCommentReplies: (cid, page, sort) => api.post(`article/comment/replies/${cid}/${page}`, undefined, { sort }),
  articleCommentAdd: (id, body) => api.post(`article/comment/add/${id}`, body),
  articleCommentVote: (cid, v) => api.get(`article/comment/vote/${cid}/${v}`),
  articleCommentDelete: (cid) => api.get(`article/comment/delete/${cid}`),
  // collections
  collection: (id) => api.get(`collection/${id}`),
  collections: (page, prev, where, sort) => api.get(`collection/all/${page}`, { previous_page: prev, where, sort }),
  collectionReleases: (id, page) => api.get(`collection/${id}/releases/${page}`),
  profileCollections: (pid, page) => api.get(`collection/all/profile/${pid}/${page}`),
  releaseCollections: (rid, page, sort) => api.get(`collection/all/release/${rid}/${page}`, { sort }),
  collectionFavAdd: (id) => api.get(`collectionFavorite/add/${id}`),
  collectionFavDelete: (id) => api.get(`collectionFavorite/delete/${id}`),
  collectionFavorites: (page) => api.get(`collectionFavorite/all/${page}`),
  collectionMyReleaseAdd: (cid, rid) => api.get(`collectionMy/release/add/${cid}`, { release_id: rid }),
  // CollectionMyApi: тело { title, description, is_private, releases: [id] }; edit заменяет состав целиком
  collectionCreate: (body) => api.post('collectionMy/create', body),
  collectionEdit: (cid, body) => api.post(`collectionMy/edit/${cid}`, body),
  collectionDelete: (cid) => api.get(`collectionMy/delete/${cid}`),
  collectionMyReleases: (cid) => api.get(`collectionMy/${cid}/releases`),
  // profile
  profile: (id) => api.get(`profile/${id}`),
  profileInfo: () => api.get('profile/info'),
  profileSocial: (id) => api.get(`profile/social/${id}`),
  friends: (id, page) => api.get(`profile/friend/all/${id}/${page}`),
  friendRequestSend: (id) => api.get(`profile/friend/request/send/${id}`),
  friendRequestRemove: (id) => api.get(`profile/friend/request/remove/${id}`),
  friendRequestsIn: (page) => api.get(`profile/friend/requests/in/${page}`),
  friendRequestsOut: (page) => api.get(`profile/friend/requests/out/${page}`),
  friendRequestHide: (id) => api.get(`profile/friend/request/hide/${id}`),
  blockAdd: (id) => api.get(`profile/blocklist/add/${id}`),
  blockRemove: (id) => api.get(`profile/blocklist/remove/${id}`),
  votedReleases: (pid, page, sort) => api.get(`profile/vote/release/voted/${pid}/${page}`, { sort }),
  unvotedReleases: (page) => api.get(`profile/vote/release/unvoted/${page}`),
  preferenceMy: () => api.get('profile/preference/my'),
  statusEdit: (status) => api.post('profile/preference/status/edit', { status }),
  changePassword: (current, next) => api.form('profile/preference/password/change', { current, new: next }),
  // notifications
  notifCount: () => api.get('notification/count'),
  notifAll: (page) => api.get(`notification/all/${page}`),
  notifRead: () => api.get('notification/read'),
  notifDeleteAll: () => api.get('notification/delete/all'),
  // feed / channels / articles
  feed: (page, channelId, date = 0) => api.get(`feed/all/${page}`, { channel_id: channelId, date }),
  latestArticles: (page) => api.get(`feed/latest/all/${page}`),
  article: (id) => api.get(`article/${id}`),
  articleVote: (id, v) => api.get(`article/vote/${id}/${v}`),
  channel: (id) => api.get(`channel/${id}`),
  blog: (pid) => api.get(`channel/blog/${pid}`),
  channelArticles: (cid, page) => api.post(`channel/${cid}/article/all/${page}`),
  channels: (page, body) => api.post(`channel/all/${page}`, body),
  channelRecommendations: (page, isBlog, excludeSubscribed) => api.get(`channel/recommendations/${page}`, { is_blog: isBlog, exclude_subscribed: excludeSubscribed }),
  channelSubscribe: (cid) => api.post(`channel/subscribe/${cid}`),
  channelUnsubscribe: (cid) => api.post(`channel/unsubscribe/${cid}`),
  subscriptions: (page, sort = 0) => api.get(`channel/subscription/all/${page}`, { sort }),
  // reports
  releaseReasons: () => api.get('report/release/reasons'),
  reportRelease: (body) => api.post('report/release', body),
  types_all: () => api.get('type/all'),
};

// Предзагрузка релиза при наведении на карточку (common.js → hoverPrefetch).
// Ограничения против спама: один запрос на id, не больше одного одновременно, не больше 15 в минуту;
// ответ живёт 30 с и отдаётся экрану релиза один раз.
const relPrefetch = new Map();
let prefetchTimes = [];
// { now } — нажатие (не наведение): не ждёт другой предзагрузки, но тоже в пределах лимита (30 в минуту)
export function prefetchRelease(id, { now: pressed = false } = {}) {
  if (!id || relPrefetch.has(id) || recentRelease(id)) return;
  const now = Date.now();
  prefetchTimes = prefetchTimes.filter((x) => now - x < 60000);
  if (prefetchTimes.length >= (pressed ? 30 : 15)) return;
  if (!pressed && [...relPrefetch.values()].some((x) => x.pending)) return;
  prefetchTimes.push(now);
  const e = { at: now, pending: true };
  e.p = A.release(id, true);
  e.p.then(() => { e.pending = false; }, () => { if (relPrefetch.get(id) === e) relPrefetch.delete(id); });
  relPrefetch.set(id, e);
  setTimeout(() => { if (relPrefetch.get(id) === e) relPrefetch.delete(id); }, 30000);
}
export function takePrefetchedRelease(id) {
  const e = relPrefetch.get(id);
  relPrefetch.delete(id);
  return e && Date.now() - e.at < 30000 ? e.p : null;
}
export function dropPrefetchedRelease(id) { relPrefetch.delete(id); }

// Недавно открытые релизы (5 минут, до 30 штук): повторный заход — сразу из памяти, без скелетона, а свежие
// данные приходят фоном к следующему разу. Раньше скелетон появлялся «через раз»: успеют ли данные за ожидание
// перехода, зависело от предзагрузки при наведении и скорости сети
const recent = new Map();
const RECENT_MS = 5 * 60000;
let cacheGen = 0;
export const releaseGen = () => cacheGen;
export function recentRelease(id) {
  const e = recent.get(id);
  if (!e || Date.now() - e.at > RECENT_MS) { recent.delete(id); return null; }
  return e.r;
}
// gen — поколение памяти на момент запроса (releaseGen()): ответ, запрошенный до смены аккаунта, не кладётся
export function rememberRelease(r, gen = cacheGen) {
  const id = r?.release?.id;
  if (!id || r.code !== 0 || gen !== cacheGen) return;
  recent.delete(id); recent.set(id, { r, at: Date.now() });
  if (recent.size > 30) recent.delete(recent.keys().next().value);
}
// статус, избранное и т. п. сменились (common.js releaseChanged) — и в памяти тоже
export function patchCachedRelease(id, fields) { const e = recent.get(id); if (e) Object.assign(e.r.release, fields); }
// Память недавно показанных экранов (профиль, коллекция и её релизы, «Популярное»): remembered(ключ, загрузка,
// onFresh) — повторный заход сразу из памяти (без скелетона), свежие данные фоном; изменились — onFresh(свежие),
// экран тихо обновляется. Первый заход — обычная загрузка. Те же правила, что у недавно открытых релизов
const reads = new Map();
// Предзагрузка первой страницы экрана с нажатия кнопки мыши (до отпускания и перехода ~100 мс — иначе ответ не
// успевал за ожидание перехода и мелькал скелетон: «Комментарии», уведомления). remembered() с тем же ключом
// подхватывает уже идущий запрос, а не шлёт второй
const inflight = new Map();
const INFLIGHT_MS = 15000;
export function prefetchRead(key, load) {
  const e = inflight.get(key);
  if (e && e.gen === cacheGen && Date.now() - e.at < INFLIGHT_MS) return e.p;
  const p = load(); p.catch(() => {});
  inflight.set(key, { p, at: Date.now(), gen: cacheGen });
  return p;
}
export function remembered(key, load, onFresh) {
  const gen = cacheGen; const e = reads.get(key);
  const pre = inflight.get(key); inflight.delete(key);
  const p = (pre && pre.gen === cacheGen && Date.now() - pre.at < INFLIGHT_MS ? pre.p : load()).then((d) => {
    if (gen === cacheGen) { reads.delete(key); reads.set(key, { d, at: Date.now(), json: JSON.stringify(d) }); if (reads.size > 40) reads.delete(reads.keys().next().value); }
    return d;
  });
  if (!e || Date.now() - e.at > RECENT_MS) return p;
  p.then((d) => { if (gen === cacheGen && onFresh && JSON.stringify(d) !== e.json) onFresh(d); }, () => {});
  return Promise.resolve(e.d);
}

// в памяти — и личные поля (статус, избранное, оценка): другой аккаунт их видеть не должен
window.addEventListener('auth-changed', () => { cacheGen += 1; recent.clear(); relPrefetch.clear(); reads.clear(); inflight.clear(); });

export default api;
