// Навигация как в мобильном приложении: у каждой вкладки нижнего меню свой стек экранов,
// предыдущие экраны сохраняются вместе с прокруткой. Кнопка «Назад» браузера/мыши = pop.
import { h, screenSkeleton, errorView, skeletonSettled, skRevealDelay, markAppeared } from './ui.js';

const screens = new Map();
export const TABS = ['home', 'discover', 'bookmarks', 'feed', 'profile', 'ai'];

const state = {
  current: '',
  stacks: Object.fromEntries(TABS.map((t) => [t, []])),
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
  const put = (node, instant) => { if (instant || !wrap.isConnected) markAppeared(node).classList.add('appeared'); wrap.replaceChildren(node); };
  entry.ready = Promise.resolve().then(() => factory(params || {}, ctx)).then(async (node) => {
    put(node, await skeletonSettled(wrap));
  }).catch(async (e) => {
    console.error(e);
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
    // −600 мс: проявление и минимальный показ скелетона уже «прошли» — он въезжает вместе с экраном
    // и уступает контенту сразу, как тот придёт (skeletonSettled не ждёт)
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
  e.node.classList.remove('enter-forward', 'enter-back', 'enter-fade');
  void e.node.offsetWidth; // перезапуск анимации
  e.node.classList.add(`enter-${direction}`);
  viewport.replaceChildren(e.node);
  viewport.scrollTop = e.scroll || 0;
  requestAnimationFrame(() => { viewport.scrollTop = e.scroll || 0; });
  // onShow({returning}) — экран показан повторно (вернулись назад или на вкладку): можно обновить данные
  const returning = !!e.shown;
  e.shown = true;
  e.onShow && e.onShow({ returning });
  document.body.dataset.depth = String(state.stacks[state.current].length);
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
  else document.body.dataset.depth = String(st.length);
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
