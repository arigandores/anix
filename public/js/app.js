import { h, icon } from './ui.js';
import { A, auth } from './api.js';
import { loadStrings, t, prefs, applyTheme } from './store.js';
import { initRouter, switchTab, TABS, resetAllTabs } from './router.js';
import './screens/index.js';
import { initDragScroll } from './dragscroll.js';

const NAV = [
  { tab: 'home', title: 'home', icon: 'ic_home', iconOn: 'ic_home_filled' },
  { tab: 'discover', title: 'discover', icon: 'ic_discover', iconOn: 'ic_discover_filled' },
  { tab: 'bookmarks', title: 'bookmarks', icon: 'ic_bookmarks', iconOn: 'ic_bookmarks_filled' },
  { tab: 'feed', title: 'feed', icon: 'ic_feed', iconOn: 'ic_feed_filled' },
  { tab: 'profile', title: 'profile', icon: 'ic_profile', iconOn: 'ic_profile_filled' },
  { tab: 'ai', label: 'AI', icon: 'ic_ai', iconOn: 'ic_ai_filled' },
];

function buildNav(container, withLogo) {
  container.replaceChildren();
  if (withLogo) container.append(h('div', { class: 'logo' }, icon('logo', 'logo')));
  for (const n of NAV) {
    const btn = h('button', { class: 'nav-item', dataset: { tab: n.tab }, onclick: () => switchTab(n.tab) },
      h('span', { class: 'pill' }, icon(n.icon, 'off'), icon(n.iconOn, 'on')),
      h('span', null, n.label || t(n.title)));
    container.append(btn);
  }
}

function onTabChange(tab) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const on = b.dataset.tab === tab;
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
    if ((e.animationName === 'content-in' || e.animationName === 'screen-fade') && !e.target.classList.contains('screen')) e.target.classList.add('appeared');
  }, true);
  await loadStrings();
  buildNav(document.getElementById('rail'), true);
  buildNav(document.getElementById('bottomnav'), false);
  initRouter(document.getElementById('viewport'), onTabChange);
  // config/toggles при старте
  A.toggles().then((tg) => { prefs.applyToggles(tg); window.__toggles = tg; }).catch(() => {});
  switchTab(TABS[0]);
  refreshNotifBadge();
  setInterval(refreshNotifBadge, 120000);
  window.addEventListener('auth-changed', () => { resetAllTabs(); refreshNotifBadge(); });
  window.addEventListener('notifications-read', refreshNotifBadge);
}

main();
