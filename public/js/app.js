import { h, icon, centerEmpties } from './ui.js';
import { A, auth } from './api.js';
import { loadStrings, t, prefs, applyTheme } from './store.js';
import { initRouter, switchTab, TABS, resetAllTabs } from './router.js';
import './screens/index.js';
import { initDragScroll } from './dragscroll.js';
import { preloadLottie, navIcon } from './lottie.js';
import { startupUpdateCheck } from './update.js';
import { initTitlebar } from './titlebar.js';
import { has } from './platform.js';

const NAV = [
  { tab: 'home', title: 'home', icon: 'ic_home', iconOn: 'ic_home_filled' },
  { tab: 'discover', title: 'discover', icon: 'ic_discover', iconOn: 'ic_discover_filled' },
  { tab: 'bookmarks', title: 'bookmarks', icon: 'ic_bookmarks', iconOn: 'ic_bookmarks_filled' },
  { tab: 'feed', title: 'feed', icon: 'ic_feed', iconOn: 'ic_feed_filled' },
  { tab: 'profile', title: 'profile', icon: 'ic_profile', iconOn: 'ic_profile_filled' },
  { tab: 'ai', label: 'AI', icon: 'ic_ai', iconOn: 'ic_ai_filled' },
].filter((n) => n.tab !== 'ai' || has.ai);

function buildNav(container, withLogo) {
  container.replaceChildren();
  if (withLogo) container.append(h('div', { class: 'logo' }, icon('logo', 'logo')));
  for (const n of NAV) {
    const btn = h('button', { class: 'nav-item', dataset: { tab: n.tab }, onclick: () => switchTab(n.tab) },
      h('span', { class: 'pill' }, icon(n.icon, 'off'), navIcon(n.tab, n.iconOn, 'on')), // залитая — с жестом «выбрано» (lottie.js)
      h('span', null, n.label || t(n.title)));
    container.append(btn);
  }
}

function onTabChange(tab) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const on = b.dataset.tab === tab;
    // жест «выбрано» — только при переходе на вкладку (не при запуске и не при повторном выборе той же)
    if (on && !b.classList.contains('active') && b.dataset.seen) b.querySelector('.lt.on')?.select();
    b.dataset.seen = '1';
    b.classList.toggle('active', on); // иконки переключает CSS (.nav-item.active .ic.on)
  });
}

async function refreshNotifBadge() {
  const dots = document.querySelectorAll('.nav-item[data-tab="profile"] .dot');
  dots.forEach((d) => d.remove());
  if (!auth.loggedIn) return;
  try {
    const r = await A.notifCount();
    const n = r.count || 0;
    if (n > 0) {
      document.querySelectorAll('.nav-item[data-tab="profile"]').forEach((b) => b.append(h('span', { class: 'dot' }, n > 99 ? '99+' : String(n))));
    }
  } catch { /* ignore */ }
}

async function main() {
  applyTheme();
  initTitlebar(); // шапка окна в приложении для Windows: полоса и кнопки окна в цвет экрана
  if (prefs.get('ECONOMY_MODE')) document.documentElement.classList.add('economy'); // режим экономии: без анимаций
  initDragScroll(); // ЛКМ + движение = прокрутка, как пальцем в мобильном приложении
  // Двойной клик = одно нажатие: второй клик серии (detail > 1) до кнопок не доходит — иначе он повторяет
  // действие или попадает в только что открытый экран. Плеер ловит двойное нажатие сам (pointerdown),
  // поля ввода выделяют слово двойным кликом — их не трогаем.
  document.addEventListener('click', (e) => {
    if (e.detail > 1 && !e.target.closest('.player-overlay, input, textarea, select, [contenteditable]')) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  // Анимация появления — один раз на элемент (см. .appeared в app.css). Сам .screen не трогаем:
  // его затухание при смене вкладки задаёт роутер.
  document.addEventListener('animationend', (e) => {
    // и въезд экрана (screen-forward/back — у контента под шапкой): после него класс въезда снимается (router.js)
    if (/^(content-in|screen-fade|screen-forward|screen-back)$/.test(e.animationName) && !e.target.classList.contains('screen')) e.target.classList.add('appeared');
  }, true);
  await loadStrings();
  buildNav(document.getElementById('rail'), true);
  buildNav(document.getElementById('bottomnav'), false);
  initRouter(document.getElementById('viewport'), onTabChange);
  centerEmpties(document.getElementById('viewport')); // пустые экраны — по центру окна (ui.js)
  // config/toggles при старте
  A.toggles().then((tg) => { prefs.applyToggles(tg); window.__toggles = tg; }).catch(() => {});
  switchTab(TABS[0]);
  refreshNotifBadge();
  preloadLottie(); // анимации интерфейса — заранее, в простое
  preloadIcons(); // иконки страницы аниме и шапок — заранее: иначе маска подгружалась при первом показе и иконка появлялась на кадр позже текста
  setTimeout(startupUpdateCheck, 2000); // вышла ли новая версия — когда первый экран загрузился (update.js)
  setInterval(refreshNotifBadge, 120000);
  window.addEventListener('auth-changed', () => { resetAllTabs(); refreshNotifBadge(); });
  window.addEventListener('notifications-read', refreshNotifBadge);
}

// Иконки, которые видны при первом открытии страницы аниме и в шапках: в кэш заранее (картинки держим, чтобы не выгрузились)
const PRELOAD_ICONS = ['ic_back', 'ic_bell', 'ic_more', 'ic_shuffle', 'ic_group', 'ic_arrow_drop_down', 'ic_favorite', 'ic_favorite_border',
  'ic_comment_outline', 'ic_play', 'ic_player_next', 'ic_info_outline', 'ic_flag_japan', 'ic_flag_chinese', 'ic_flag_unknown', 'ic_episodes',
  'ic_schedule', 'ic_studio', 'ic_source', 'ic_tune_variant', 'ic_voice', 'ic_calendar', 'ic_collection', 'ic_collection_add', 'ic_star_rate',
  'ic_chevron_end', 'ic_arrow_downward', 'ic_arrow_upward', 'ic_eye_off_outline', 'ic_send', 'ic_copy', 'ic_check'];
const preloaded = [];
function preloadIcons() {
  const go = () => { for (const n of PRELOAD_ICONS) { const im = new Image(); im.src = `/icons/${n}.svg`; preloaded.push(im); } };
  if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 2000 }); else setTimeout(go, 1000);
}

main();
