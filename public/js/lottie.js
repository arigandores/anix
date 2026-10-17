// Lottie-анимации интерфейса (lottie-web, рендер в SVG). Файлы — public/lottie/*.json: копии сцен плеера
// tools/lottie-studio (скилл text-to-lottie; правка сцены → node tools/lottie-studio/sync.mjs); отрезки для проигрывания — маркеры внутри файла (on/off, ring, pop, intro/loop…).
//
// lottieIcon(name, opts) — элемент на месте обычной иконки (.ic): пока библиотека и файл грузятся (или если
// не загрузились), виден статичный значок fallback, потом его сменяет анимация того же размера. Холст может
// быть больше иконки (брызги вокруг сердца) — pad: на сколько размеров иконки он выходит за каждый край.
// Цвет — currentColor элемента (классы слоёв в app.css, «Lottie»).
//
// Анимация живёт, пока элемент виден: вне экрана — пауза, вынули из DOM — уничтожается (обход раз в 4 с:
// IntersectionObserver о выемке из DOM не сообщает), а на её месте остаётся неподвижный снимок кадра покоя
// (копия SVG): вернули на экран — снимок виден сразу, без пустого места, и незаметно сменяется живой анимацией. Вставку в DOM
// ловит короткая CSS-анимация lt-attach (браузер запускает её при каждой вставке, app.css): только тогда
// элемент берётся под наблюдение, так что вынутые элементы ничем не удерживаются в памяти.
// В режиме экономии (html.economy) ничего не проигрывается: сразу кадр покоя.

let libP = null;
function loadLib() {
  libP ||= new Promise((resolve, reject) => {
    if (window.lottie) { resolve(window.lottie); return; }
    const s = document.createElement('script');
    s.src = '/vendor/lottie_light.min.js';
    s.onload = () => resolve(window.lottie);
    s.onerror = () => { libP = null; reject(new Error('lottie-web не загрузился')); };
    document.head.append(s);
  });
  return libP;
}

// текст файла: lottie-web дописывает в данные служебные поля, поэтому каждому экземпляру — свой разбор
const files = new Map();
function loadText(name) {
  if (!files.has(name)) {
    files.set(name, fetch(`/lottie/${name}.json`).then((r) => { if (!r.ok) throw new Error(`lottie ${name}: ${r.status}`); return r.text(); })
      .catch((e) => { files.delete(name); throw e; }));
  }
  return files.get(name);
}

const economy = () => document.documentElement.classList.contains('economy');

const io = new IntersectionObserver((entries) => {
  for (const e of entries) e.target.__lt?.visible(e.isIntersecting);
});
const watched = new Set();
let sweepTimer = 0;
function sweep() {
  for (const el of watched) if (!el.isConnected) { el.__lt.detach(); io.unobserve(el); watched.delete(el); }
  if (!watched.size) { clearInterval(sweepTimer); sweepTimer = 0; }
}
document.addEventListener('animationstart', (e) => {
  if (e.animationName !== 'lt-attach' || !e.target.__lt || watched.has(e.target)) return;
  watched.add(e.target); io.observe(e.target);
  sweepTimer ||= setInterval(sweep, 4000);
}, true);

// opts: fallback — статичная иконка; cls — классы размера (.sm, .big…); pad — выход холста за края;
// rest — кадр покоя: число или имя маркера (его последний кадр); auto — [вступление, петля?]: проиграть
// вступление при первом показе, дальше крутить петлю (если есть; при возврате на экран — сразу петля);
// muted — пока анимация не готова, запасная иконка приглушённого цвета (как её начальный кадр), а не currentColor;
// blank — пока не готова, пустое место (анимация сама начинается с пустоты: пустые экраны, галочка тоста) —
// иначе мелькала статичная иконка, а за ней появлялась анимация. Не загрузилась — тогда статичная иконка.
// el.ready — промис: анимация готова (true) или не загрузилась (false, остаётся запасная иконка)
export function lottieIcon(name, { fallback, cls = '', pad = 0, rest = 0, auto = null, muted = false, blank = false } = {}) {
  const el = document.createElement('span');
  el.className = `ic lt ${muted ? 'lt-muted' : ''} ${blank ? 'lt-blank' : ''} ${cls}`;
  let markReady;
  el.ready = new Promise((ok) => { markReady = ok; });
  el.setAttribute('aria-hidden', 'true');
  if (fallback) el.style.setProperty('--ic', `url(/icons/${fallback}.svg)`);
  if (pad) el.style.setProperty('--lt-pad', `${-pad * 100}%`);

  let anim = null; let markers = {}; let loading = false; let shown = false;
  let restAt = rest; // кадр (или маркер), где анимация стоит, когда не играет
  let pending = null; // play(), вызванный до готовности
  let looping = null; // имя крутящейся петли
  let introDone = false;

  const seg = (m) => markers[m];
  const restFrame = () => {
    if (typeof restAt === 'number') return restAt;
    const s = seg(restAt); return s ? s[1] - 1 : 0;
  };

  // встать в кадр покоя. В lottie-web goToAndStop считает кадры от начала последнего проигранного отрезка —
  // без resetSegments после отрезка «off» (36–52) или «play» (12–24) кадр покоя уезжал за конец анимации
  // (пустая иконка, пустой снимок при выемке из DOM)
  const stopAt = (f) => { anim.resetSegments(true); anim.goToAndStop(f, true); };
  function settle() {
    looping = null;
    if (anim) { anim.loop = false; anim.onComplete = null; stopAt(restFrame()); }
  }

  function start(marker, { loop = false, then = null } = {}) {
    const s = seg(marker); if (!s) return;
    if (economy()) { restAt = loop ? s[0] : marker; settle(); return; }
    looping = loop ? marker : null;
    restAt = loop ? s[0] : marker;
    anim.loop = loop;
    anim.onComplete = loop ? null : () => { anim.onComplete = null; if (then) start(then, { loop: true }); };
    anim.playSegments(s, true);
  }

  async function mount() {
    if (anim || loading) return;
    loading = true;
    try {
      const [lib, text] = await Promise.all([loadLib(), loadText(name)]);
      if (!shown || !el.isConnected) return;
      const data = JSON.parse(text);
      markers = Object.fromEntries((data.markers || []).map((m) => [m.cm, [m.tm, m.tm + m.dr]]));
      let host = el.querySelector('.lt-host');
      if (!host) { host = document.createElement('span'); host.className = 'lt-host'; el.append(host); }
      const snap = host.firstChild; // снимок с прошлого раза — убираем, когда живая анимация уже на месте
      anim = lib.loadAnimation({ container: host, renderer: 'svg', loop: false, autoplay: false, animationData: data,
        rendererSettings: { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: false } });
      anim.goToAndStop(restFrame(), true);
      if (snap && snap !== host.lastChild) snap.remove();
      el.classList.add('lt-on');
      markReady(true);
      if (pending) { const p = pending; pending = null; start(...p); } else if (auto) {
        if (!introDone) { introDone = true; start(auto[0], { then: auto[1] }); } else if (auto[1]) start(auto[1], { loop: true });
      }
    } catch { el.classList.add('lt-fail'); markReady(false); /* остаётся статичная иконка */ } finally { loading = false; }
  }

  // уничтожить анимацию; keep — оставить на её месте неподвижный снимок кадра покоя
  function unmount(keep) {
    if (!anim) return;
    const host = el.querySelector('.lt-host');
    anim.loop = false; anim.onComplete = null; stopAt(restFrame());
    const snap = keep && host?.querySelector('svg')?.cloneNode(true);
    anim.destroy(); anim = null;
    if (snap) host.replaceChildren(snap);
    else { host?.remove(); el.classList.remove('lt-on'); }
  }

  el.__lt = {
    visible(v) {
      shown = v;
      if (!v) { if (looping) anim?.pause(); else settle(); return; } // одноразовую — сразу в конец, петлю — на паузу
      if (!anim) mount();
      else if (looping && !economy()) anim.play();
    },
    detach() { shown = false; if (looping) restAt = seg(looping)[0]; looping = null; unmount(true); },
  };

  // play(маркер) — проиграть отрезок; потом стоять в его последнем кадре. { loop } — крутить; { then } —
  // после отрезка крутить петлю then. { ifIdle } — не перебивать то, что уже играет (наведение)
  el.play = (marker, opts = {}) => {
    if (opts.ifIdle && anim && !anim.isPaused) return;
    if (!anim) { pending = [marker, opts]; restAt = marker; return; }
    start(marker, opts);
  };
  // show(маркер | кадр) — встать в кадр без анимации
  el.show = (at) => { pending = null; restAt = at; settle(); };
  return el;
}

// Сердце «в избранное»: set(on, animate) — переключить; без animate — сразу в нужном состоянии.
// Вызывать set() до смены цвета кнопки: при снятии сердце берёт текущий («включённый») цвет на время сжатия
export function heartIcon(on, cls = 'sm') {
  const el = lottieIcon('heart', { fallback: on ? 'ic_favorite' : 'ic_favorite_border', cls, pad: 0.5, rest: on ? 'on' : 0 });
  el.on = on;
  el.set = (v, animate) => {
    if (v === el.on) return;
    const was = getComputedStyle(el).color;
    el.on = v;
    el.style.setProperty('--ic', `url(/icons/${v ? 'ic_favorite' : 'ic_favorite_border'}.svg)`);
    clearTimeout(el.colorTimer); el.style.color = '';
    // снятие: кнопка уже серая, а заливка ещё сжимается — пусть сжимается своим цветом (иначе мелькала тёмным);
    // в кадре подмены заливки контуром (41 из отрезка 36–52, ~85 мс) цвет возвращается к цвету кнопки
    if (animate && !v && !economy()) {
      el.style.color = was;
      el.colorTimer = setTimeout(() => { el.style.color = ''; }, 85);
    }
    if (animate) el.play(v ? 'on' : 'off'); else el.show(v ? 'on' : 0);
  };
  return el;
}

// Иконка навигации (залитая — у выбранного пункта): select() — жест «выбрано». Первый и последний кадр — иконка
// в покое, поэтому переключение вкладки мгновенное, жест — поверх
export function navIcon(tab, fallback, cls = '') {
  const el = lottieIcon(`nav-${tab}`, { fallback, cls, pad: 0.25, rest: 'select' });
  el.select = () => el.play('select');
  return el;
}

// Плей ⇄ пауза в плеере: set(playing) — иконка показывает, что сделает нажатие (идёт — пауза, стоит — плей)
export function playPauseIcon(playing = true) {
  const el = lottieIcon('play-pause', { fallback: playing ? 'ic_player_pause' : 'ic_player_play', rest: playing ? 'pause' : 'play' });
  el.playing = playing;
  el.set = (v) => {
    if (v === el.playing) return;
    el.playing = v;
    el.style.setProperty('--ic', `url(/icons/${v ? 'ic_player_pause' : 'ic_player_play'}.svg)`);
    el.play(v ? 'pause' : 'play');
  };
  return el;
}

// «Скопировать»: done() — значок превращается в галочку и через секунду обратно
export function copyIcon(cls = '') {
  const el = lottieIcon('copy-check', { fallback: 'ic_copy', cls, rest: 'back' });
  el.done = () => { clearTimeout(el.backTimer); el.play('done'); el.backTimer = setTimeout(() => el.play('back'), 1300); };
  return el;
}

// Колокольчик, который звенит при наведении на кнопку (и по ring())
export function bellIcon(cls = '') {
  const el = lottieIcon('bell', { fallback: 'ic_bell', cls, pad: 0.25 });
  el.ring = () => el.play('ring', { ifIdle: true });
  queueMicrotask(() => el.parentElement?.addEventListener('pointerenter', el.ring));
  return el;
}

// Глаз: set(off, animate) — перечёркнутый (спойлер включён, серия просмотрена) ⇄ открытый: перечёркивание
// прорисовывается, глаз под ним расступается. Свойство — off (hidden у элемента занято DOM)
export function eyeIcon(off = false, cls = '') {
  const el = lottieIcon('eye', { fallback: off ? 'ic_eye_off_outline' : 'ic_eye_outline', cls, rest: off ? 'hide' : 'show' });
  el.off = off;
  el.set = (v, animate = true) => {
    if (v === el.off) return;
    el.off = v;
    el.style.setProperty('--ic', `url(/icons/${v ? 'ic_eye_off_outline' : 'ic_eye_outline'}.svg)`);
    if (animate) el.play(v ? 'hide' : 'show'); else el.show(v ? 'hide' : 'show');
  };
  return el;
}

// Полный экран: set(on) — уголки разворачиваются внутрь («выйти из полноэкранного») и обратно
export function fullscreenIcon() {
  const el = lottieIcon('fullscreen', { fallback: 'ic_player_fill', rest: 'exit' });
  el.on = false;
  el.set = (v) => { if (v === el.on) return; el.on = v; el.play(v ? 'enter' : 'exit'); };
  return el;
}

// Наведение на кнопку действия — разовый жест иконки (шестерёнка проворачивается, ползунки разъезжаются…),
// как колокольчик. Покой — статичная иконка; hoverIcon(имя) → null, если для иконки жеста нет
const HOVER = { ic_settings: 'hover-settings', ic_tune: 'hover-tune', ic_sort: 'hover-sort', ic_shuffle: 'hover-shuffle', ic_history: 'hover-history', ic_trash_outline: 'hover-trash' };
const HOVER_HOST = 'button, .menu-item, .sheet-item, .chip, .tile, [role="button"]';
export function hoverIcon(name, cls = '') {
  const anim = HOVER[name];
  if (!anim) return null;
  const el = lottieIcon(anim, { fallback: name, cls });
  const go = () => el.play('hover', { ifIdle: true });
  queueMicrotask(() => (el.closest(HOVER_HOST) || el.parentElement)?.addEventListener('pointerenter', go));
  return el;
}

// Пустые экраны: иконка emptyView → анимация (у остальных иконок — статичная, как раньше)
const EMPTY = { ic_info_outline: 'empty-ghost', ic_search: 'empty-search', ic_bell: 'empty-bell', ic_comment_outline: 'empty-comment', ic_lock: 'empty-lock', ic_history: 'empty-history' };
export function emptyIcon(ic) {
  const name = EMPTY[ic];
  return name ? lottieIcon(name, { fallback: ic, cls: 'big', rest: 'intro', auto: ['intro', 'loop'], blank: true }) : null;
}
export function errorIcon() {
  return lottieIcon('empty-error', { fallback: 'ic_error', cls: 'big', rest: 'intro', auto: ['intro'], blank: true });
}

// Заранее, в простое после запуска: библиотека и файлы анимаций — первая анимация (пустой экран, тост, сердце)
// начинается сразу, без паузы на загрузку
export function preloadLottie() {
  const go = () => { loadLib().catch(() => {}); for (const n of ['heart', 'bell', 'star', 'check', ...Object.values(EMPTY), 'empty-error', 'copy-check', 'play-pause', 'eye', 'fullscreen', ...Object.values(HOVER), ...['home', 'discover', 'bookmarks', 'feed', 'profile', 'ai'].map((t) => `nav-${t}`)]) loadText(n).catch(() => {}); };
  if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 3000 }); else setTimeout(go, 1500);
}
