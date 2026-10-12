// Навигация как в мобильном приложении: у каждой вкладки нижнего меню свой стек экранов,
// предыдущие экраны сохраняются вместе с прокруткой. Кнопка «Назад» браузера/мыши = pop.
import { h, screenSkeleton, errorView } from './ui.js';

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
  return h('div', null, bar, h('div', { class: 'skeleton sk-root', 'aria-busy': 'true' }, body));
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
  wrap.append(placeholder(name, params));
  Promise.resolve().then(() => factory(params || {}, ctx)).then((node) => {
    wrap.replaceChildren(node);
  }).catch((e) => {
    console.error(e);
    wrap.replaceChildren(errorView(e, () => {
      const fresh = makeEntry(name, params);
      Object.assign(entry, { node: fresh.node });
      render();
    }));
  });
  return entry;
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
  saveScroll();
  state.stacks[state.current].push(makeEntry(name, params));
  history.pushState({ anix: true }, '');
  render('forward');
}

export function replace(name, params = {}) {
  const st = state.stacks[state.current];
  const old = st.pop();
  old && old.dispose && old.dispose();
  st.push(makeEntry(name, params));
  render('fade');
}

function popInternal() {
  const st = state.stacks[state.current];
  if (st.length <= 1) return false;
  const old = st.pop();
  old.dispose && old.dispose();
  render('back');
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
  if (!st.length) st.push(makeEntry(`tab:${tab}`, {}));
  onTabChange(tab);
  render();
}

export function resetAllTabs() {
  for (const t of TABS) { state.stacks[t].forEach((e) => e.dispose && e.dispose()); state.stacks[t] = []; }
  const cur = state.current;
  state.current = '';
  switchTab(cur);
}

export function currentTab() { return state.current; }
