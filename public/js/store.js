// Строки приложения (strings.json), настройки (localStorage)
// и локальная БД просмотра: отметки серий и последняя просмотренная серия.

import { has } from './platform.js';

let R = { strings: {}, plurals: {}, arrays: {} };
export async function loadStrings() {
  const r = await fetch('/strings.json');
  R = await r.json();
}

function format(s, args) {
  let i = 0;
  return s.replace(/%(?:(\d+)\$)?([sd]|\.\d+f)/g, (_, n, type) => {
    const v = n ? args[Number(n) - 1] : args[i++];
    if (type.endsWith('f')) return Number(v).toFixed(Number(type.slice(1, -1)));
    return v == null ? '' : String(v);
  }).replace(/%%/g, '%');
}

export function t(key, ...args) {
  const s = R.strings[key];
  if (s == null) return key;
  return args.length ? format(s, args) : s.replace(/%%/g, '%');
}

export function tp(key, n, ...args) {
  const p = R.plurals[key];
  if (!p) return String(n);
  const a = Math.abs(n) % 100; const b = a % 10;
  const q = a > 10 && a < 20 ? 'many' : b > 1 && b < 5 ? 'few' : b === 1 ? 'one' : 'many';
  const s = p[q] ?? p.other ?? p.many ?? Object.values(p)[0];
  return format(s, args.length ? args : [n]);
}

export function arr(name) { return R.arrays[name] || []; }

// ---------------- Prefs ----------------
const PREFIX = 'anixart.pref.';
const DEFAULTS = {
  SELECTED_PLAYER: 2, // 0 спрашивать перед каждой серией, 1 веб, 2 встроенный, 3 сторонний
  LAST_SELECTED_PLAYER: 2,
  SKIP_OPENING: null, // пропуск опенинга и эндинга во встроенном плеере: 'auto' | 'watch' | null (спрашивать)
  SKIP_ENDING: null,
  SKIP_FILLERS: false, // «следующая серия» перескакивает филлеры (плеер, «Смотреть N серию», «⏭»)
  UPSCALE_MODE: 'off', // улучшение картинки (апскейл нейросетью): 'off' | 'auto' | 'fast' | 'quality' | 'max'
  UPSCALE_TARGET: 'auto', // разрешение: 'auto' (под окно) | '1080' | '1440' | '2160'
  UPSCALE_LAST: 'auto', // режим, который включает клавиша U
  UPSCALE_GPU: null, // замер видеокарты: { key, tput } — умножений в секунду
  UPSCALE_TRT: true, // ускорение NVIDIA (TensorRT), когда его библиотеки установлены
  UPSCALE_SHARP: 'normal', // «Резкость»: 'soft' | 'normal' | 'sharp' — вариант той же модели (DN / Sharp1 / DS)
  UPSCALE_PICK: null, // пресет ручного уровня по классам исходника: { tier: { sd|hd|fhd: id } }
  UPSCALE_BENCH: null, // замеры бенчмарка (upscale/bench.js)
  // улучшение звука во встроенном плеере (audio.js): выравнивание громкости, чёткий голос, объёмный звук для наушников
  AUDIO_LEVEL: false,
  AUDIO_VOICE: false,
  AUDIO_SURROUND: false,
  DISCORD_PRESENCE: false, // статус «Смотрит …» в Discord (discord.js): включает сам пользователь в настройках
  SELECTED_PLAYER_SPEED: 3,
  PHONE_NOTIFY: true, // телефон: уведомления Anixart системными (push.js, NotifyJob.kt)
  PLAYER_REWIND_TIME: 85, // кнопка «перемотать опенинг», когда у серии нет меток (как в Anixart: рекомендуется 1:25)
  PLAYER_SHARPEN: 'off', // телефон: улучшение картинки (sharpen.js) — off | soft | strong; включает сам пользователь
  PLAYER_LANDSCAPE_ONLY: true, // телефон: плеер только горизонтально; выкл — поворачивается за телефоном
  WATCHED_TIME_FORMAT: 'days', // время просмотра в профиле: 'days' (~ 3 дня 4 часа) | 'hours' (~ 76 часов)
  COMPACT_NAV: false, // телефон: нижнее меню без подписей
  PLAYER_FIT: 'contain', // кадр во встроенном плеере на телефоне: 'contain' (вписать) | 'cover' (заполнить) | 'fill' (растянуть)
  AUTO_PLAY: false,
  SELECTED_VIDEO_QUALITY_V2: 0, // приоритет качества во встроенном плеере: 0 — максимально доступное
  IS_REMEMBERING_TYPE_SOURCE: true,
  // «Альтернативное соединение» / «Режим экономии ресурсов»
  FORCE_SHOULD_USE_MIRROR_URLS: false,
  SHOULD_USE_MIRROR_URLS: false,
  ECONOMY_MODE: false,
  // AI-помощник: модель и глубина рассуждений (effort)
  AI_MODEL: 'sonnet',
  AI_EFFORT: 'medium',
  WEB_PLAYER_AD_BLOCK_ENABLED: true,
  EXTENDED_MODE: true,
  // из config/toggles
  IFRAME_EMBED_URL: 'https://anixmirai.com/iframe?url=',
  SIBNET_RAND_USER_AGENT: false,
  SIBNET_USER_AGENT: '',
  THIRD_PARTY_PLAYER_PATH: '',
};

export const prefs = {
  get(key) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      if (v == null) return DEFAULTS[key];
      return JSON.parse(v);
    } catch { return DEFAULTS[key]; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  applyToggles(tg) {
    if (!tg) return;
    const map = {
      iframeEmbedUrl: 'IFRAME_EMBED_URL',
      sibnetRandUserAgent: 'SIBNET_RAND_USER_AGENT', sibnetUserAgent: 'SIBNET_USER_AGENT',
    };
    for (const [k, p] of Object.entries(map)) if (tg[k] !== undefined && tg[k] !== null && tg[k] !== '') this.set(p, tg[k]);
  },
  sibnetUA() {
    if (!this.get('SIBNET_RAND_USER_AGENT')) return '';
    return this.get('SIBNET_USER_AGENT') || '';
  },
};

// Плеер выбирается чипом над списком серий, а не диалогом перед каждой серией. В прежнем диалоге галочка
// «Спрашивать всегда» стояла по умолчанию — такой сохранённый выбор один раз меняем на последний плеер
// (спрашивать по-прежнему можно, выбрав это в настройках)
try {
  if (!localStorage.getItem(`${PREFIX}PLAYER_ASK_MIGRATED`)) {
    if (prefs.get('SELECTED_PLAYER') === 0) prefs.set('SELECTED_PLAYER', prefs.get('LAST_SELECTED_PLAYER') || 2);
    prefs.set('PLAYER_ASK_MIGRATED', true);
    for (const k of ['IS_REMEMBERING_SKIP_THIRD_PARTY_PLATFORM', 'IS_ASKED_SKIP_THIRD_PARTY_PLATFORM', 'SEARCH_VIDEO_TPP', 'COUNT_SKIP_STREAMING_PLATFORM']) localStorage.removeItem(PREFIX + k);
  }
} catch { /* storage недоступен */ }
// Стороннего плеера на Android нет (platform.js) — вместо него встроенный
if (!has.externalPlayer) for (const k of ['SELECTED_PLAYER', 'LAST_SELECTED_PLAYER']) if (prefs.get(k) === 3) prefs.set(k, 2);

// по умолчанию — тёмная; светлую или «как в системе» выбирают в настройках (выбор хранится в anixart.theme)
export const DEFAULT_THEME = 'dark';
export function theme() {
  try { return localStorage.getItem('anixart.theme') || DEFAULT_THEME; } catch { return DEFAULT_THEME; }
}
export function setTheme(v) {
  try { localStorage.setItem('anixart.theme', v); } catch { /* ignore */ }
  applyTheme();
}
export function applyTheme() {
  const v = theme();
  const dark = v === 'dark' || (v === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------------- Локальная БД ----------------
function load(key, def) { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? def; } catch { return def; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }

// Серия досмотрена, если до конца осталось меньше этого (когда источник не отметил эндинг)
const FINISH_LEFT_MS = 120000;

export const db = {
  // Episode(releaseId, sourceId, position, playbackPosition, isWatched, duration, endingStart, finished).
  // isWatched — отметка «просмотрено» (ставится при запуске, как на сервере); досмотрена ли — progress()
  episodeKey: (r, s, p) => `${r}:${s}:${p}`,
  episodes() { return load('anixart.db.episodes', {}); },
  getEpisode(r, s, p) { return this.episodes()[this.episodeKey(r, s, p)] || null; },
  putEpisode(r, s, p, patch) {
    const all = this.episodes();
    const k = this.episodeKey(r, s, p);
    all[k] = { releaseId: r, sourceId: s, position: p, playbackPosition: 0, isWatched: false, ...(all[k] || {}), ...patch };
    save('anixart.db.episodes', all);
    return all[k];
  },
  // Место в серии в любой озвучке: в этой озвучке серию не начинали, а в другой смотрели — продолжить с того же
  // места (номер серии один и тот же). Последнее по времени (savedAt), у старых записей — самое дальнее
  positionAnySource(r, p) {
    let best = null;
    for (const e of Object.values(this.episodes())) {
      if (e.releaseId !== r || e.position !== p || !(e.playbackPosition > 0)) continue;
      if (!best || (e.savedAt || 0) > (best.savedAt || 0) || ((e.savedAt || 0) === (best.savedAt || 0) && e.playbackPosition > best.playbackPosition)) best = e;
    }
    return best ? best.playbackPosition : 0;
  },
  watchedOf(r, s) {
    const out = {};
    for (const e of Object.values(this.episodes())) if (e.releaseId === r && e.sourceId === s && e.isWatched) out[e.position] = e.playbackPosition || 0;
    return out;
  },
  // Самая дальняя серия после pos, отмеченная просмотренной не здесь — пришла с сервера (смотрели на телефоне) или
  // отмечена вручную — и не раньше since (сек: время последней серии; отметку старше её — пересмотр с начала — не
  // берём). Серии, которые запускали здесь (startedAt, место, savedAt), не в счёт. Отметки без времени (до markedAt) —
  // только в источнике последней серии (sourceId): так приходят отметки с сервера, а свои в другой озвучке — нет
  markedAfter(r, pos, since, sourceId) {
    let best = 0;
    for (const e of Object.values(this.episodes())) {
      if (e.releaseId !== r || !e.isWatched || e.position <= pos || e.startedAt || e.savedAt || e.playbackPosition || e.finished) continue; // место или −1 («до конца») — смотрели здесь
      if (e.markedAt != null ? e.markedAt < since : e.sourceId !== sourceId) continue;
      if (e.position > best) best = e.position;
    }
    return best || null;
  },
  // Отметки всего аниме — в любой озвучке и источнике (номер серии один и тот же)
  watchedOfRelease(r) {
    const out = new Set();
    for (const e of Object.values(this.episodes())) if (e.releaseId === r && e.isWatched) out.add(e.position);
    return out;
  },
  setAllWatched(r, s, positions, watched) {
    const all = this.episodes();
    for (const p of positions) {
      const k = this.episodeKey(r, s, p);
      all[k] = { releaseId: r, sourceId: s, position: p, playbackPosition: 0, ...(all[k] || {}), isWatched: watched };
      if (!watched) Object.assign(all[k], { playbackPosition: 0, finished: false });
    }
    save('anixart.db.episodes', all);
  },
  // Снять отметку серии во всех источниках аниме; возвращает источники, где она стояла (снять и на сервере)
  unwatchEverywhere(r, p) {
    const all = this.episodes(); const sources = [];
    for (const e of Object.values(all)) {
      if (e.releaseId !== r || e.position !== p || !e.isWatched) continue;
      sources.push(e.sourceId);
      Object.assign(e, { isWatched: false, playbackPosition: 0, finished: false });
    }
    save('anixart.db.episodes', all);
    return sources;
  },
  // Сколько просмотрено и досмотрена ли: «⏭ следующая», конец файла (-1), начало эндинга в конце серии
  // или меньше FINISH_LEFT_MS до конца. Нет записи или позиции — null
  progress(r, s, p) {
    const e = this.getEpisode(r, s, p);
    if (!e) return null;
    const pos = e.playbackPosition > 0 ? e.playbackPosition : 0; const dur = e.duration > 0 ? e.duration : 0;
    const finished = !!e.finished || e.playbackPosition === -1
      || (dur > 0 && pos > 0 && ((e.endingStart > 0 && pos >= e.endingStart) || dur - pos <= FINISH_LEFT_MS));
    if (!finished && !pos) return null;
    return { pos, dur, finished, toEnd: e.playbackPosition === -1 };
  },
  // Прогресс серии в любом источнике аниме (отметки общие для всех озвучек): сначала — в этом источнике
  progressAny(r, p, preferSource) {
    const sources = [preferSource, ...Object.values(this.episodes()).filter((e) => e.releaseId === r && e.position === p && e.sourceId !== preferSource).map((e) => e.sourceId)];
    for (const s of sources) { const pr = this.progress(r, s, p); if (pr && (pr.pos || pr.toEnd)) return pr; }
    return null;
  },
  // Выбранные озвучка и источник аниме — запоминаются сразу при выборе (чипы), ещё до запуска серии
  choice(releaseId) { return load('anixart.db.choice', {})[releaseId] || null; },
  setChoice(releaseId, { typeId, sourceId, typeName, sourceName, typeIcon }) {
    const all = load('anixart.db.choice', {});
    all[releaseId] = { typeId, sourceId, typeName, sourceName, typeIcon };
    save('anixart.db.choice', all);
  },
  // Максимальное качество источника (по названию), узнанное при запуске серии
  sourceQuality(name) { return load('anixart.db.sourceQuality', {})[name] || null; },
  setSourceQuality(name, q) {
    if (!name || !q) return;
    const all = load('anixart.db.sourceQuality', {});
    if (all[name] === q) return;
    all[name] = q; save('anixart.db.sourceQuality', all);
  },
  // Последняя просмотренная серия: releaseId, typeId, sourceId, position, timestamp;
  // typeName/sourceName — для заголовка скелетона, пока экран серий открывает запомненный выбор
  addLastWatched(releaseId, typeId, sourceId, position, { typeName, sourceName, typeIcon } = {}) {
    const all = load('anixart.db.lastWatched', {});
    all[releaseId] = { releaseId, typeId, sourceId, position, typeName, sourceName, typeIcon, timestamp: Math.floor(Date.now() / 1000) };
    save('anixart.db.lastWatched', all);
    this.setChoice(releaseId, { typeId, sourceId, typeName, sourceName, typeIcon });
  },
  lastWatched(releaseId) { return load('anixart.db.lastWatched', {})[releaseId] || null; },
  // История поиска
  searchHistory() { return load('anixart.db.search', []); },
  addSearch(q) {
    q = q.trim(); if (!q) return;
    const l = this.searchHistory().filter((x) => x !== q);
    l.unshift(q); save('anixart.db.search', l.slice(0, 30));
  },
  removeSearch(q) { save('anixart.db.search', this.searchHistory().filter((x) => x !== q)); },
  clearSearch() { save('anixart.db.search', []); },
};
