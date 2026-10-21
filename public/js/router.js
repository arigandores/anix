// Навигация как в мобильном приложении: у каждой вкладки нижнего меню свой стек экранов,
// предыдущие экраны сохраняются вместе с прокруткой. Кнопка «Назад» браузера/мыши = pop.
import { h, screenSkeleton, errorView, skeletonSettled, skRevealDelay, markAppeared, enterScreen, joinEnter } from './ui.js';
import { forgetRecent } from './api.js';

const screens = new Map();
export const TABS = ['home', 'discover', 'bookmarks', 'feed', 'profile', 'ai'];

const state = {
  current: '',
  stacks: Object.fromEntries(TABS.map((t) => [t, []])),
  // вкладки в порядке посещения, без повторов: «Назад» на корне вкладки — на прошлую (как в приложении Anixart)
  visited: [],
};

let viewport; let onTabChange = () => {};

// skeleton(params) → [панель, ...содержимое]: заглушка, повторяющая раскладку экрана, пока его фабрика
// грузит данные. Панель (с «Назад») остаётся рабочей, содержимое — неактивное (.sk-root).
export function registerScreen(name, factory, skeleton) { screens.set(name, { factory, skeleton }); }

function placeholder(name, params) {
  const s = screens.get(name);
  if (!s.skeleton) return screenSkeleton('rows', { back: !name.startsWith('tab:') });
  const [bar, ...body] = s.skeleton(params || {});
  return h('div', null, bar, h('div', { class: 'skeleton sk-root', 'aria-busy': 'true', style: { '--sk-delay': `${Math.round(skRevealDelay())}ms` } }, body));
}

export function initRouter(el, tabChangeCb) {
  viewport = el;
  onTabChange = tabChangeCb || onTabChange;
  window.addEventListener('popstate', () => {
    const st = state.stacks[state.current];
    if (st.length > 1) popInternal();
    else history.pushState({ anix: true }, '');
  });
  history.replaceState({ anix: true }, '');
}

function makeEntry(name, params) {
  if (!screens.has(name)) throw new Error(`Unknown screen ${name}`);
  const { factory } = screens.get(name);
  const wrap = h('div', { class: 'screen', 'data-screen': name });
  const entry = { name, params, node: wrap, scroll: 0, dispose: null, onShow: null };
  const ctx = {
    params,
    back: () => back(),
    setDispose: (fn) => { entry.dispose = fn; },
    setOnShow: (fn) => { entry.onShow = fn; },
    entry,
  };
  let ph = placeholder(name, params);
  wrap.append(ph);
  // Скелетон собирается заново к показу экрана: к этому времени экран может знать о себе больше
  // (например, «Воспроизвести»: озвучки уже пришли — понятно, будут серии или список озвучек)
  entry.refreshPlaceholder = () => { if (wrap.firstChild === ph) { ph = placeholder(name, params); wrap.replaceChildren(ph); } };
  // Контент, готовый до показа экрана, появляется вместе с ним (въезд экрана), без своей анимации появления
  // Контент, сменивший видимый скелетон, — тоже сразу, без проявления (skeletonSettled в ui.js)
  // контент сменил заготовку: пока экран въезжает — подхватывает въезд с того же места (одна анимация), после —
  // встаёт сразу; без своего проявления (оно было второй анимацией)
  const put = (node, instant) => {
    if (instant || !wrap.isConnected) markAppeared(node).classList.add('appeared');
    wrap.replaceChildren(node);
    if (joinEnter(node)) markAppeared(node).classList.add('appeared');
  };
  entry.ready = Promise.resolve().then(() => factory(params || {}, ctx)).then(async (node) => {
    put(node, await skeletonSettled(wrap));
  }).catch(async (e) => {
    console.error(e);
    entry.failed = true;
    const instant = await skeletonSettled(wrap);
    put(errorView(e, () => {
      const fresh = makeEntry(name, params);
      Object.assign(entry, { node: fresh.node });
      render();
    }), instant);
  });
  return entry;
}

// Переход с коротким ожиданием: пока новый экран грузится, на месте остаётся прежний, и если данные
// успели за NAV_WAIT, новый въезжает уже с контентом — без пустого экрана и скелетона. Ждём недолго:
// отклик до ~0,1 с воспринимается мгновенным, дольше — уже как задержка нажатия. Не успели — экран
// въезжает сразу со скелетоном (без задержки появления) и сменяется контентом, как только тот придёт.
// Готов — фабрика вернула экран и внутри не осталось скелетонов (экран может догружать данные сам).
// Пока экран ждёт показа, прежний не принимает нажатия: повторный клик не откроет экран второй раз.
const NAV_WAIT = 100;
let pending = null;
function showWhenReady(entry, direction) {
  let done = false;
  pending = entry;
  viewport.inert = true;
  const show = (timedOut) => {
    if (done) return;
    done = true;
    if (pending === entry) { pending = null; viewport.inert = false; }
    if (topEntry() !== entry) return; // ушли назад или на другую вкладку, пока грузилось
    // не успели — скелетон въезжает вместе с экраном (−600 мс: проявление и минимальный показ «уже прошли»):
    // без голого экрана. Пришедший контент подхватывает въезд экрана (ui.js joinEnter) — одна анимация.
    // (Скелетон с обычной задержкой 250 мс давал пустой экран на 100–250 мс, а потом — весь контент разом.)
    if (timedOut) {
      entry.refreshPlaceholder();
      entry.node.querySelectorAll('.sk-root, .sk, .spinner-wrap, .load-reveal').forEach((el) => el.style.setProperty('--sk-delay', '-600ms'));
    }
    else markAppeared(entry.node); // контент въезжает вместе с экраном, без отдельного проявления строк
    render(direction);
  };
  const loading = () => !!entry.node.querySelector('.sk-root, .sk, .spinner-wrap, .load-reveal');
  entry.ready.then(() => {
    const check = () => { if (done) return; if (!loading()) show(false); else requestAnimationFrame(check); };
    check();
  });
  setTimeout(() => show(true), NAV_WAIT);
}

function topEntry() { const st = state.stacks[state.current]; return st ? st[st.length - 1] : undefined; }

function saveScroll() { const e = topEntry(); if (e) e.scroll = viewport.scrollTop; }

// direction: 'forward' (новый экран), 'back' (возврат), 'fade' (смена вкладки)
function render(direction = 'fade') {
  const e = topEntry();
  if (!e) return;
  viewport.replaceChildren(e.node);
  enterScreen(e.node, direction); // одна анимация въезда — контент под шапкой (ui.js)
  viewport.scrollTop = e.scroll || 0;
  requestAnimationFrame(() => { viewport.scrollTop = e.scroll || 0; });
  // onShow({returning}) — экран показан повторно (вернулись назад или на вкладку): можно обновить данные
  const returning = !!e.shown;
  e.shown = true;
  e.onShow && e.onShow({ returning });
  document.body.dataset.depth = String(state.stacks[state.current].length);
  document.body.dataset.screen = e.name; // какой экран показан (android.css: экраны без нижнего меню)
  window.dispatchEvent(new CustomEvent('screen-shown'));
}

export function navigate(name, params = {}) {
  if (pending && topEntry() === pending) return; // переход уже идёт — повторное нажатие не открывает второй экран
  saveScroll();
  const entry = makeEntry(name, params);
  state.stacks[state.current].push(entry);
  history.pushState({ anix: true }, '');
  showWhenReady(entry, 'forward');
}

export function replace(name, params = {}) {
  const st = state.stacks[state.current];
  const old = st.pop();
  old && old.dispose && old.dispose();
  const entry = makeEntry(name, params);
  st.push(entry);
  showWhenReady(entry, 'fade');
}

function popInternal() {
  const st = state.stacks[state.current];
  if (st.length <= 1) return false;
  const old = st.pop();
  old.dispose && old.dispose();
  // экран ещё не успел показаться — на месте и так прежний
  if (old.shown) render('back');
  else { document.body.dataset.depth = String(st.length); document.body.dataset.screen = st[st.length - 1].name; }
  return true;
}

export function back() {
  const st = state.stacks[state.current];
  if (st.length > 1) history.back();
}

export function switchTab(tab, { reset = false } = {}) {
  if (tab === state.current && !reset) {
    // Повторное нажатие на вкладку — вернуться к корню (как в приложении)
    const st = state.stacks[tab];
    if (st.length > 1) {
      while (st.length > 1) { const o = st.pop(); o.dispose && o.dispose(); }
      st[0].scroll = 0;
      render('back');
    } else {
      viewport.scrollTo({ top: 0, behavior: 'smooth' });
    }
    return;
  }
  saveScroll();
  state.current = tab;
  state.visited = [...state.visited.filter((t) => t !== tab), tab];
  const st = state.stacks[tab];
  if (reset) { st.forEach((e) => e.dispose && e.dispose()); st.length = 0; }
  onTabChange(tab);
  if (!st.length) { const entry = makeEntry(`tab:${tab}`, {}); st.push(entry); showWhenReady(entry, 'fade'); return; }
  render();
}

export function resetAllTabs() {
  for (const t of TABS) { state.stacks[t].forEach((e) => e.dispose && e.dispose()); state.stacks[t] = []; }
  const cur = state.current;
  state.current = '';
  switchTab(cur);
}

export function currentTab() { return state.current; }
// дождаться, пока закончится идущий переход (новый navigate() во время него не открывает экран)
export async function settled() { while (pending) await new Promise((ok) => setTimeout(ok, 50)); }

// Обновить экран (свайп вниз на телефоне, pull.js). Видимые списки — тихо, на месте (pagedList refresh); экран без
// списков строится заново со свежими данными: прежний виден, пока новый не готов, и подменяется без въезда.
// Не с сервера (память недавних экранов, api.js) — ни то, ни другое. Ввод, вход, настройки — не обновляются
const NO_REFRESH = /^(auth|signup|verify|restore|restore-verify|social-register|search|feed-search|filter|settings|notification-settings|collection-editor|profile-settings|profile-blocklist|tab:ai)$/;
export const canRefresh = () => { const e = topEntry(); return !!e && e.shown && !pending && !NO_REFRESH.test(e.name); };
export async function refreshCurrent() {
  const old = topEntry();
  if (!canRefresh()) return true;
  forgetRecent();
  const lists = [...old.node.querySelectorAll('.paged')].filter((p) => p.refresh && p.offsetParent);
  if (lists.length) { await Promise.all(lists.map((p) => p.refresh())); return true; }
  const entry = makeEntry(old.name, old.params);
  await entry.ready;
  for (const t0 = Date.now(); entry.node.querySelector('.sk-root, .sk, .spinner-wrap, .load-reveal') && Date.now() - t0 < 10000;) await new Promise((ok) => setTimeout(ok, 100));
  const st = state.stacks[state.current];
  if (entry.failed || topEntry() !== old) { entry.dispose && entry.dispose(); return !entry.failed; } // не загрузилось — прежний вид
  st[st.length - 1] = entry;
  old.dispose && old.dispose();
  viewport.replaceChildren(markAppeared(entry.node));
  viewport.scrollTop = 0;
  entry.shown = true;
  entry.onShow && entry.onShow({ returning: false });
  return true;
}

// «Назад» на корне вкладки (системная кнопка на телефоне): на прошлую посещённую; false — вкладок позади нет
export function backTab() {
  const prev = state.visited.at(-2);
  if (!prev) return false;
  state.visited.pop();
  switchTab(prev);
  return true;
}
