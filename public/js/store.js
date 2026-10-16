// Строки приложения (strings.json), настройки (localStorage)
// и локальная БД просмотра: отметки серий и последняя просмотренная серия.

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
  SELECTED_PLAYER: 0, // 0 спрашивать, 1 веб, 2 встроенный, 3 сторонний
  LAST_SELECTED_PLAYER: 2,
  SKIP_OPENING: null, // пропуск опенинга и эндинга во встроенном плеере: 'auto' | 'watch' | null (спрашивать)
  SKIP_ENDING: null,
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
  AUTO_PLAY: false,
  SELECTED_VIDEO_QUALITY_V2: 0, // приоритет качества во встроенном плеере: 0 — максимально доступное
  SELECTED_THIRD_PARTY_VIDEO_QUALITY_V2: 0,
  ON_EPISODE_DISCLAIMER: false,
  IS_REMEMBERING_TYPE_SOURCE: true,
  // «Непроверенные источники»: запомнить переход к вариантам из непроверенных источников
  IS_REMEMBERING_SKIP_THIRD_PARTY_PLATFORM: false,
  IS_ASKED_SKIP_THIRD_PARTY_PLATFORM: false,
  SEARCH_VIDEO_TPP: false,
  COUNT_SKIP_STREAMING_PLATFORM: 0,
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

export function theme() {
  try { return localStorage.getItem('anixart.theme') || 'system'; } catch { return 'system'; }
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

export const db = {
  // Episode(releaseId, sourceId, position, playbackPosition, isWatched)
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
  watchedOf(r, s) {
    const out = {};
    for (const e of Object.values(this.episodes())) if (e.releaseId === r && e.sourceId === s && e.isWatched) out[e.position] = e.playbackPosition || 0;
    return out;
  },
  setAllWatched(r, s, positions, watched) {
    const all = this.episodes();
    for (const p of positions) {
      const k = this.episodeKey(r, s, p);
      all[k] = { releaseId: r, sourceId: s, position: p, playbackPosition: 0, ...(all[k] || {}), isWatched: watched };
      if (!watched) all[k].playbackPosition = 0;
    }
    save('anixart.db.episodes', all);
  },
  // Последняя просмотренная серия: releaseId, typeId, sourceId, position, timestamp;
  // typeName/sourceName — для заголовка скелетона, пока экран серий открывает запомненный выбор
  addLastWatched(releaseId, typeId, sourceId, position, { typeName, sourceName } = {}) {
    const all = load('anixart.db.lastWatched', {});
    all[releaseId] = { releaseId, typeId, sourceId, position, typeName, sourceName, timestamp: Math.floor(Date.now() / 1000) };
    save('anixart.db.lastWatched', all);
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
