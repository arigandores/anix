// Android: то, что на ПК делает server/index.js, — здесь, в WebView, до запуска фронтенда.
// Фронтенд не меняется: он, как и на ПК, ходит на /api/*, /parse, /probe, /__info, /__features, а window.fetch
// отвечает на них сам — подписью (server/sign.js) и парсерами (server/parsers) из того же кода, что на ПК.
// Запросы наружу с нужными заголовками — через /__relay локального сервера (LocalServer.kt): у WebView
// нет ни своих User-Agent/Referer/Cookie, ни обхода CORS. Видео (/stream) отдаёт сам LocalServer.
// Перед этим файлом sync-web.mjs кладёт модули server/ (__anixRequire) и APP_VERSION.
(function () {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  const { apiHeaders, setCodecProfile, VERSION_CODE } = __anixRequire('/server/sign.js');
  const { parse } = __anixRequire('/server/parsers/index.js');
  const config = __anixRequire('/server/config.js');
  const social = __anixRequire('/server/social.js');

  const DEFAULT_API = 'https://api-s.anixsekai.com/';
  const URLS_JSON = 'https://anixhelper.github.io/pages/urls.json';
  const PLAYER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Safari/537.36';

  // ---------- fetch через /__relay ----------
  const utf8 = new TextEncoder();
  const b64 = (s) => { let bin = ''; for (const b of utf8.encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
  const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

  class RelayHeaders {
    constructor(list) { this.list = list; } // [[имя в нижнем регистре, значение], …]
    get(name) {
      const n = name.toLowerCase();
      const v = this.list.filter(([k]) => k === n).map(([, x]) => x);
      return v.length ? v.join(', ') : null;
    }
    has(name) { return this.get(name) != null; }
    getSetCookie() { return this.list.filter(([k]) => k === 'set-cookie').map(([, v]) => v); }
    forEach(fn) { for (const [k, v] of this.list) fn(v, k, this); }
    *entries() { yield* this.list; }
    [Symbol.iterator]() { return this.entries(); }
  }

  // ключ /__relay (LocalServer.relayKey): без него сервер отвечает 403 — другие приложения телефона им не воспользуются
  let key = null;
  // окно приложения — anixAndroid, фоновая проверка уведомлений (NotifyJob.kt) — anixBackground
  const relayKey = () => key || (key = (window.anixAndroid || window.anixBackground)?.relayKey() || '');

  // Как fetch, но без CORS и с любыми заголовками. Ответ — похожий на Response (Set-Cookie в настоящий не положить)
  async function relayFetch(url, opts = {}) {
    const headers = {};
    new Headers(opts.headers || {}).forEach((v, k) => { headers[k] = v; });
    const method = (opts.method || 'GET').toUpperCase();
    let body;
    if (method !== 'GET' && method !== 'HEAD' && opts.body != null) {
      const tmp = new Request('http://x/', { method: 'POST', body: opts.body, headers: opts.headers });
      if (!headers['content-type'] && tmp.headers.get('content-type')) headers['content-type'] = tmp.headers.get('content-type');
      body = await tmp.arrayBuffer();
    }
    const meta = { url: String(url), method, headers, follow: opts.redirect !== 'manual' };
    const r = await nativeFetch('/__relay', { method: 'POST', headers: { 'X-Relay': b64(JSON.stringify(meta)), 'X-Relay-Key': relayKey() }, body, signal: opts.signal });
    if (r.status === 599) {
      const e = await r.json().catch(() => ({}));
      throw new TypeError('fetch failed', { cause: { code: e.code, message: e.error } });
    }
    const status = Number(r.headers.get('X-Relay-Status'));
    const finalUrl = r.headers.get('X-Relay-Url') || String(url);
    const list = JSON.parse(unb64(r.headers.get('X-Relay-Headers') || 'W10='));
    const buf = await r.arrayBuffer();
    return {
      status, ok: status >= 200 && status < 300, statusText: '', url: finalUrl, redirected: finalUrl !== String(url),
      headers: new RelayHeaders(list),
      body: { cancel: async () => {} },
      arrayBuffer: async () => buf,
      text: async () => new TextDecoder().decode(buf),
      json: async () => JSON.parse(new TextDecoder().decode(buf)),
    };
  }
  __anixSetFetch(relayFetch); // fetch внутри модулей server/
  window.__anixRelay = relayFetch; // для android/test/server.mjs

  // ---------- адрес бекенда (как resolveApiBase в server/index.js) ----------
  let apiBase = DEFAULT_API;
  async function resolveApiBase() {
    const candidates = [];
    try {
      const j = await (await relayFetch(URLS_JSON, { signal: AbortSignal.timeout(8000) })).json();
      const entry = j.default || Object.values(j)[0];
      if (entry && entry.api_url) candidates.push(entry.api_url);
    } catch (_) { /* сеть/GitHub недоступен */ }
    candidates.push(DEFAULT_API);
    for (const c of candidates) {
      try {
        const u = new URL(`config/urls?version_code=${VERSION_CODE}&is_beta=false`, c);
        const r = await relayFetch(u, { headers: apiHeaders(), signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          apiBase = c.endsWith('/') ? c : c + '/';
          try {
            const list = (await r.json()).api_urls;
            if (Array.isArray(list) && list.length && typeof list[0] === 'string') apiBase = list[0];
          } catch (_) { /* формат ответа не критичен */ }
          return;
        }
      } catch (_) { /* пробуем следующий */ }
    }
  }
  // Без сети адрес не ищем (каждая попытка ждала бы таймаута, а экран — скелетоном) — найдём, когда сеть вернётся
  let resolved = navigator.onLine;
  let apiReady = resolved ? resolveApiBase() : Promise.resolve();
  addEventListener('online', () => { if (!resolved) { resolved = true; apiReady = resolveApiBase(); } });
  const NO_NET = 'Нет подключения к интернету';

  // ---------- маршруты ----------
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const NULL_BODY = new Set([101, 204, 205, 304]);

  // Повторы при кратковременных сбоях — как fetchUpstream в server/index.js
  const RETRY_DELAYS = [300, 900];
  const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);
  // Вход через соцсеть (токен → профиль) повторять можно: ничего не записывает, повтор вернёт тот же профиль. Бекенд
  // временами отвечает на него 502 — вход через Google проходил «через раз»
  const REPEATABLE_POST = /\/auth\/(google|vk|telegram|yandex)$/;
  async function fetchUpstream(target, opts) {
    const idempotent = opts.method === 'GET' || opts.method === 'HEAD' || REPEATABLE_POST.test(new URL(String(target)).pathname);
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= RETRY_DELAYS.length;
      try {
        const r = await relayFetch(target, { ...opts, signal: AbortSignal.timeout(idempotent ? 15000 : 30000) });
        if (!(idempotent && !last && [502, 503, 504].includes(r.status))) return r;
      } catch (e) {
        const code = (e && e.cause && e.cause.code) || (e && e.name) || '';
        if (last || !(idempotent || CONNECT_ERRORS.has(code))) throw e;
      }
      await new Promise((ok) => setTimeout(ok, RETRY_DELAYS[attempt]));
    }
  }

  async function api(url, req) {
    if (!navigator.onLine) return json({ code: -1, error: NO_NET }, 502); // сразу ошибка с «Повторить», а не ожидание таймаутов
    await apiReady;
    const target = new URL(url.pathname.replace(/^\/api\//, '') + url.search, apiBase);
    const headers = apiHeaders();
    const ct = req.headers.get('content-type');
    if (ct) headers['Content-Type'] = ct;
    if (req.headers.get('x-api-version')) headers['API-Version'] = req.headers.get('x-api-version');
    const opts = { method: req.method, headers };
    // Мобильный клиент всегда шлёт тело POST, даже пустое
    if (req.method !== 'GET' && req.method !== 'HEAD') opts.body = await req.arrayBuffer();
    let r;
    try { r = await fetchUpstream(target, opts); } catch (e) { return json({ code: -1, error: String(e && e.message || e) }, 502); }
    const buf = await r.arrayBuffer();
    if (target.pathname.endsWith('/config/toggles')) {
      try { setCodecProfile(JSON.parse(new TextDecoder().decode(buf)).codecProfile); } catch (_) { /* ignore */ }
    }
    return new Response(NULL_BODY.has(r.status) ? null : buf, {
      status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8' },
    });
  }

  async function probe(url) {
    const target = url.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(target)) return json({ error: 'url required' }, 400);
    try {
      const r = await relayFetch(target, { headers: { 'User-Agent': PLAYER_UA, Range: 'bytes=0-0' }, signal: AbortSignal.timeout(8000) });
      return json({ status: r.status, host: new URL(r.url || target).host });
    } catch (e) { return json({ status: 0, error: String(e.message || e) }); }
  }

  async function parseRoute(url) {
    const target = url.searchParams.get('url');
    if (!target) return json({ error: 'url required' }, 400);
    if (!navigator.onLine) return json({ error: NO_NET, playback: {}, download: {} });
    try {
      return json(await parse(target, { sibnetUserAgent: url.searchParams.get('sibnet_ua') || '' }));
    } catch (e) {
      return json({ error: String(e && e.message || e), playback: {}, download: {} });
    }
  }

  // Вход через соцсети: параметры окна и обмен кода — server/social.js здесь; Google (системный браузер) — у LocalServer
  async function socialRoute(url, req) {
    const provider = url.searchParams.get('provider');
    try {
      if (url.pathname === '/social/request') return json(social.authRequest(provider));
      if (url.pathname === '/social/exchange' && req.method === 'POST') return json(await social.exchange(provider, await req.json()));
      return json({ error: 'not found' }, 404);
    } catch (e) { return json({ error: String(e && e.message || e) }); }
  }
  const features = () => ({ ...config.features(), discord: false });

  const ROUTES = [
    [(p) => p.startsWith('/api/'), api],
    [(p) => p === '/parse', parseRoute],
    [(p) => p === '/probe', probe],
    [(p) => p === '/__info', async () => { await apiReady; return json({ apiBase, versionCode: VERSION_CODE, appVersion: APP_VERSION, platform: 'android' }); }],
    [(p) => p === '/__features', async () => json(features())],
    [(p) => p === '/external', async () => json({ ok: false, error: 'Сторонний плеер на телефоне не поддерживается' })],
    [(p) => p === '/social/google/start' && !features().social.google, async () => json({ error: 'Вход через Google недоступен в этой сборке' })],
    [(p) => p === '/social/request' || p === '/social/exchange', socialRoute],
    [(p) => p.startsWith('/discord/') || p.startsWith('/ai/') || p.startsWith('/mcp/'), async () => json({ ok: false }, 404)],
  ];

  window.fetch = function (input, init) {
    const href = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(href, location.href);
    if (url.origin === location.origin) {
      const route = ROUTES.find(([match]) => match(url.pathname));
      if (route) return route[1](url, new Request(input, init));
    }
    return nativeFetch(input, init);
  };

  // Системная «Назад» (MainActivity.back): true — обработали здесь, false — позади ни экранов, ни вкладок, приложение
  // сворачивается. На корне другой вкладки — на прошлую посещённую (router.js backTab).
  // history.length не годится: на корне router.js снова кладёт запись в history, и WebView всегда «может назад».
  // Окна, меню, плеер закрываются по Escape (как на ПК); закрылось ли что-то — видно по изменениям DOM сразу после него
  window.__anixBack = function () {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return true; }
    const mo = new MutationObserver(() => {});
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    const closed = mo.takeRecords().length > 0;
    mo.disconnect();
    if (closed) return true;
    if (Number(document.body.dataset.depth || 1) > 1) { history.back(); return true; }
    return !!(window.__anixTabBack && window.__anixTabBack());
  };

  const bridge = window.anixAndroid;
  // при запуске — в журнал телефона (AnixWeb): есть ли WebGPU и какая видеокарта (улучшение картинки выбирает по ним)
  const nlog = (m) => { try { bridge.log(String(m)); } catch (_) { /* старая сборка без log */ } };
  window.__anixLog = nlog;
  // Есть ли видеокарта для WebGPU (navigator.gpu бывает и без неё — эмулятор): ответ запоминается (anix.webgpu),
  // по нему platform.js выбирает улучшение картинки — нейросеть (upscale/) или резкость (sharpen.js); до первого ответа —
  // резкость
  const remember = (on) => { try { localStorage.setItem('anix.webgpu', on ? '1' : '0'); } catch (_) { /* ignore */ } };
  if (!navigator.gpu) { remember(false); nlog('webgpu: нет navigator.gpu'); }
  else navigator.gpu.requestAdapter().then((a) => { remember(!!a); nlog(a ? `webgpu: ${a.info?.vendor || ''} ${a.info?.architecture || ''} ${a.info?.description || ''} f16=${a.features.has('shader-f16')}` : 'webgpu: нет адаптера'); })
    .catch((e) => { remember(false); nlog(`webgpu: ошибка ${e && e.message}`); });
  setTimeout(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    nlog(`webgl2: ${gl ? (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'нет'}`);
  }, 3000);
  if (!bridge) return; // страница открыта не в приложении (например, в браузере для отладки)
  document.documentElement.classList.add('android');
  try { bridge.setGoogleConfig(JSON.stringify(social.googleWebConfig())); } catch (_) { /* без ключей Google */ }

  // То, что на ПК даёт electron/preload.js (window.anixartNative), — тем, что есть на телефоне
  const socialWaits = new Map();
  let socialSeq = 0;
  window.__anixSocialDone = (id, r) => { const done = socialWaits.get(id); socialWaits.delete(id); if (done) done(r); };
  const linkListeners = [];
  window.__anixDeepLink = (u) => linkListeners.forEach((cb) => cb(u));
  window.anixartNative = {
    openExternal: (u) => bridge.openExternal(String(u)),
    clearWebCache: async () => Number(bridge.clearWebCache()),
    socialAuth: (req) => new Promise((resolve) => { const id = ++socialSeq; socialWaits.set(id, resolve); bridge.socialAuth(JSON.stringify(req), id); }),
    cancelSocialAuth: () => bridge.cancelSocialAuth(),
    pendingDeepLink: async () => bridge.pendingDeepLink() || null,
    onDeepLink: (cb) => { linkListeners.push(cb); },
    focusWindow: () => bridge.focusWindow(),
    openLinkSettings: () => bridge.openLinkSettings(),
    lockOrientation: (on) => bridge.lockOrientation(!!on), // блокировка плеера — ориентация текущая
    haptic: (kind) => bridge.haptic(String(kind || 'tap')),
    // сохранить файл (экспорт закладок): системный «Сохранить как»; true — сохранили
    saveFile: (name, mime, text) => new Promise((ok) => { savedWait = ok; bridge.saveFile(String(name), String(mime), String(text)); }),
    appIcon: { get: () => bridge.icon(), set: (name) => bridge.setIcon(String(name)) }, // значок на рабочем столе
    // ярлык на рабочем столе (аниме, коллекция): система спрашивает, куда положить
    pinShortcut: (id, label, link, image) => bridge.pinShortcut(String(id), String(label), String(link), String(image || '')), // ok | unsupported | blocked
    openShortcutSettings: () => bridge.openShortcutSettings(),
    // голосовой поиск (search.js): распознавание речи Android; null — отменили или не расслышали
    voice: {
      available: () => bridge.voiceAvailable(),
      listen: () => new Promise((ok) => { voiceWait = ok; bridge.voiceListen(); }),
    },
    // уведомления на телефоне (push.js, NotifyJob.kt)
    notify: {
      permission: () => bridge.notifyPermission(),
      request: () => new Promise((ok) => { notifyWait = ok; bridge.requestNotifyPermission(); }),
      set: (on) => bridge.setNotify(!!on),
      openSettings: () => bridge.openNotifySettings(),
    },
  };
  let notifyWait = null; let voiceWait = null; let savedWait = null;
  window.__anixSaved = (ok) => { const f = savedWait; savedWait = null; if (f) f(!!ok); };
  window.__anixToast = (text) => import('/js/ui.js').then(({ toast }) => toast(text)); // сообщение от MainActivity
  window.__anixVoice = (text) => { const f = voiceWait; voiceWait = null; if (f) f(text || null); };
  window.__anixNotifyPermission = (granted) => { const f = notifyWait; notifyWait = null; if (f) f(granted); };
  // Обновление (update.js — то же окно «Вышла новая версия», что на ПК): последний релиз GitHub с Anix-<версия>.apk,
  // скачивание и установка — Updater.kt. Адрес релизов в тестах подменяется (anix.test.updateFeed)
  const FEED = 'https://api.github.com/repos/arigandores/anix-desktop/releases';
  const feed = () => { try { return localStorage.getItem('anix.test.updateFeed') || FEED; } catch { return FEED; } };
  const newer = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  const gh = async (path) => { const r = await relayFetch(`${feed()}${path}`, { headers: { 'User-Agent': 'AnixAndroid', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`); return r.json(); };
  let apkUrl = null; let progressCb = null; let downloadDone = null; let installDone = null;
  window.__anixUpdateProgress = (p) => progressCb && progressCb(p);
  window.__anixUpdateDone = (r) => { const f = downloadDone; downloadDone = null; if (f) f(r); };
  window.__anixUpdateInstalled = (r) => { const f = installDone; installDone = null; if (f) f(r); };
  const update = {
    async check() {
      const current = APP_VERSION;
      // последний релиз, в котором есть APK, — не просто последний: релиз только для Windows (без APK) телефону не
      // обновление, но и не должен прятать более ранний релиз для Android (build/RELEASE.md → «Платформы»)
      const list = await gh('?per_page=20');
      const apkOf = (r) => (r.assets || []).find((a) => /^Anix-[\d.]+\.apk$/.test(a.name));
      const rel = (Array.isArray(list) ? list : []).find((r) => !r.draft && !r.prerelease && apkOf(r)) || {};
      const version = String(rel.tag_name || '').replace(/^v/, '');
      const apk = apkOf(rel);
      if (!version || !apk || !newer(version, current)) return { supported: true, current };
      apkUrl = apk.browser_download_url;
      return { supported: true, current, version, notes: rel.body || '' };
    },
    async notes(version) { try { return (await gh(`/tags/v${version || APP_VERSION}`)).body || ''; } catch { return ''; } },
    download: () => new Promise((ok) => { if (!apkUrl) { ok({ ok: false, error: 'нет файла обновления' }); return; } downloadDone = ok; bridge.updateDownload(apkUrl); }),
    cancel: () => bridge.updateCancel(),
    // ошибки установщика Android — понятным текстом
    install: () => new Promise((ok) => {
      installDone = (r) => ok(r.ok ? r : { ok: false, error: /ABORTED|rejected/i.test(r.error) ? 'установку отменили'
        : /SIGNATURE|CONFLICT|UPDATE_INCOMPATIBLE/i.test(r.error) ? 'новая версия подписана другим ключом — удалите приложение и установите её заново'
          : /STORAGE|space/i.test(r.error) ? 'не хватает места на телефоне' : r.error });
      bridge.updateInstall();
    }),
    onProgress: (cb) => { progressCb = cb; return () => { if (progressCb === cb) progressCb = null; }; },
  };
  window.anixartNative.update = update;

  // «Поделиться» — системное меню Android (в WebView нет navigator.share)
  navigator.share = async (d = {}) => bridge.share([d.title, d.text, d.url].filter(Boolean).join('\n'));

  // Встроенный плеер: открыт (не мини-плеер) — горизонталь без системных полос; идёт серия — экран не гаснет,
  // а при сворачивании — «картинка в картинке» (MainActivity)
  let lastOpen = null; let lastPlaying = null;
  const playerVideo = () => document.querySelector('.player-overlay video');
  const syncPlayer = () => {
    const ov = document.querySelector('.player-overlay');
    const open = !!ov && !ov.classList.contains('mini');
    const v = playerVideo();
    const playing = !!v && !v.paused && !v.ended;
    if (open !== lastOpen) {
      lastOpen = open;
      // «Только горизонтально» (настройки → Воспроизведение): выключено — плеер поворачивается за телефоном
      if (open) { let only = true; try { only = localStorage.getItem('anixart.pref.PLAYER_LANDSCAPE_ONLY') !== 'false'; } catch { /* по умолчанию */ } bridge.setPlayerRotate(!only); }
      bridge.setPlayer(open);
    }
    if (playing !== lastPlaying) { lastPlaying = playing; bridge.setPlaying(playing); }
  };
  new MutationObserver(syncPlayer).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied']) document.addEventListener(ev, syncPlayer, true);
  window.__anixPip = (on) => { document.documentElement.classList.toggle('android-pip', !!on); };
  // приложение скрыто (ушли без PiP, закрыли окно PiP, погас экран — MainActivity.onStop): вход в PiP onStop не вызывает
  window.__anixPause = () => { const v = playerVideo(); if (v && !v.paused) v.pause(); };
  // Кнопки окна PiP, гарнитуры и Bluetooth (MainActivity.media): пауза — у видео, ∓10 с и серии — обработчики
  // navigator.mediaSession, которые ставит плеер (player.js). В WebView Media Session API нет — здесь его замена,
  // которая только запоминает обработчики (медиасессия Android — в MainActivity)
  const mediaActions = new Map();
  if (!navigator.mediaSession) {
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: {
      metadata: null, playbackState: 'none', setPositionState() {},
      setActionHandler: (a, f) => { if (f) mediaActions.set(a, f); else mediaActions.delete(a); },
    } });
  }
  const MEDIA = { rew: 'seekbackward', fwd: 'seekforward', next: 'nexttrack', prev: 'previoustrack' };
  window.__anixMedia = (cmd) => {
    const v = playerVideo();
    if (!v) return;
    if (cmd === 'play') v.play().catch(() => {});
    else if (cmd === 'pause') v.pause();
    else mediaActions.get(MEDIA[cmd])?.({ action: MEDIA[cmd] });
  };
  window.anixartNative.enterPip = () => bridge.enterPip();
  // Вырез камеры в плеере (MainActivity: видео под ним) — кнопки плеера отодвигаются от него (android.css)
  window.__anixInsets = () => {
    const c = JSON.parse(bridge.cutout());
    for (const [k, v] of Object.entries(c)) document.documentElement.style.setProperty(`--cut-${k}`, `${v}px`);
  };
  window.__anixInsets();
  // Клавиатура открылась / закрылась (MainActivity) — без нижнего меню над ней (android.css .kb-open)
  window.__anixIme = (on) => document.documentElement.classList.toggle('kb-open', !!on);

  // Цвет системных полос — по теме приложения (index.html и store.js ставят data-theme)
  const theme = () => bridge.setTheme(document.documentElement.dataset.theme !== 'light');
  new MutationObserver(theme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  theme();
})();
