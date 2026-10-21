// Ссылки на Anixart — в приложении, как в приложении Anixart: anixart.tv/release/123 (и другие его домены и зеркала),
// anixart://release?id=123 — аниме, коллекция, профиль, канал, статья. Приходят снаружи (Android: MainActivity и
// shim.js onDeepLink — ссылку открыли в браузере или мессенджере) и изнутри: ссылки в комментариях, описаниях,
// баннерах (<a>, window.open) — не уходят в браузер
import { navigate, settled } from './router.js';
import { launchLink } from './platform.js';

const HOSTS = ['anixart.tv', 'anixart.app', 'anixartapp.com', 'anixart-app.com'];
const SCREENS = ['release', 'collection', 'profile', 'channel', 'article'];

const ourHost = (host) => {
  const base = (() => { try { return new URL(window.__toggles?.baseUrl || '').hostname; } catch { return ''; } })();
  return [...HOSTS, base].filter(Boolean).some((d) => host === d || host === `mirror.${d}` || host === `beta.${d}`);
};

// { screen, id } или null — не ссылка на экран Anixart
export function appLink(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  let screen; let id;
  if (u.protocol === 'anixart:') { screen = u.hostname || u.pathname.replace(/^\/+/, ''); id = u.searchParams.get('id'); }
  else if (/^https?:$/.test(u.protocol) && ourHost(u.hostname)) [, screen, id] = /^\/([a-z]+)\/(\d+)/.exec(u.pathname) || [];
  if (u.protocol === 'anixart:' && screen === 'notifications') return { screen }; // из уведомления телефона (NotifyJob.kt)
  return SCREENS.includes(screen) && /^\d+$/.test(id || '') ? { screen, id: Number(id) } : null;
}

export function openAppLink(url) {
  const l = appLink(url);
  if (l) settled().then(() => navigate(l.screen, l.id ? { id: l.id } : {})); // запуск по ссылке — ещё грузится первая вкладка
  return !!l;
}

export function initLinks() {
  const open = window.open.bind(window);
  window.open = (url, ...rest) => (openAppLink(url) ? null : open(url, ...rest));
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (a && openAppLink(a.href)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  const native = window.anixartNative;
  if (native?.onDeepLink) { native.onDeepLink(openAppLink); launchLink().then(openAppLink); }
}
