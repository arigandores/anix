// Запуск с чистыми данными: каталог приходит (подпись запросов принята бекендом), без ошибок на странице,
// тёмные системные полосы, нижнее меню без AI; данные (настройки, вход) переживают перезапуск — адрес страницы постоянный
import { ensureDevice, install, launch, js, until, check, skip, done, REAL, pageErrors, windowState, screenshot, PORT, sleep, key, cdp, reattach, topActivity, pid, PKG } from './_device.mjs';

await ensureDevice();
install();
await launch({ fresh: true });

check('страница на постоянном порту', await js('location.port') === String(PORT), await js('location.href'));
const api = await js(`fetch('/api/config/toggles').then((r) => r.status)`);
if (api >= 500) { skip('каталог', `бекенд Anixart отвечает ${api} — проверить позже`); }
else {
  check('подписанный запрос принят бекендом', api === 200, api);
  check('каталог: настоящие строки, не скелетон', !!(await until(`${REAL('.release-row, .release-card')} >= 3`, 25000)));
  check('постеры каталога загрузились', !!(await until(`(() => { const im = [...document.querySelectorAll('.release-row img')].filter((i) => i.getBoundingClientRect().top < innerHeight).slice(0, 3); return im.length >= 2 && im.every((i) => i.complete && i.naturalWidth > 0); })()`, 15000)));
}
const nav = await js(`[...document.querySelectorAll('#bottomnav .nav-item')].filter((b) => b.getClientRects().length).map((b) => b.dataset.tab)`);
check('нижнее меню: 5 вкладок, без AI', JSON.stringify(nav) === JSON.stringify(['home', 'discover', 'bookmarks', 'feed', 'profile']), nav);
check('боковое меню (рельс) на телефоне скрыто', await js(`!document.getElementById('rail').getClientRects().length || getComputedStyle(document.getElementById('rail')).display === 'none'`));
check('html.android и мост на месте', await js(`document.documentElement.classList.contains('android') && !!window.anixartNative && typeof navigator.share === 'function'`));
const w = await windowState();
check('тёмная тема — светлые значки на тёмных полосах', w.darkBars === true && w.statusBarVisible === true, w);
check('без горизонтальной прокрутки', await js('document.scrollingElement.scrollWidth <= innerWidth + 1'));
const css = await js(`(() => {
  const sheet = [...document.styleSheets].find((x) => /app\\.css/.test(x.href || ''));
  let rules = 0; let hoverOutside = 0;
  const walk = (list, inHover) => { for (const r of list) { if (r.cssRules && r.media) walk(r.cssRules, inHover || /hover:\\s*hover/.test(r.media.mediaText)); else if (r.selectorText) { rules++; if (/:hover/.test(r.selectorText) && !inHover) hoverOutside++; } } };
  walk(sheet.cssRules, false);
  return { rules, hoverOutside };
})()`);
check('app.css разобран целиком, :hover — только при наведении мышью', css.rules > 800 && css.hoverOutside === 0, css);
check('shim.js выполнился до конца (PiP, пауза в фоне)', await js('typeof window.__anixPip === "function" && typeof window.__anixPause === "function"'));
screenshot('launch-home');

// Данные переживают перезапуск: настройка и метка в localStorage. Как у пользователя: свернул приложение и
// закрыл его из «Недавних» (WebView пишет localStorage на диск с задержкой ~1 с — сразу после записи убитый процесс её теряет)
await js(`localStorage.setItem('anixart.pref.VIEW_TYPE', '1'), localStorage.setItem('anix.test.mark', 'x'), 1`);
await key(3, 2000); // «Домой»
await launch();
check('после перезапуска — те же данные (localStorage)', await js(`localStorage.getItem('anix.test.mark') === 'x' && localStorage.getItem('anixart.pref.VIEW_TYPE') === '1'`));
await js(`localStorage.removeItem('anix.test.mark'), localStorage.removeItem('anixart.pref.VIEW_TYPE'), 1`);
await sleep(500);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
pageErrors.length = 0;

// Процесс страницы упал (система убила его из-за памяти) — приложение не падает, страница открывается заново
cdp('Page.crash').catch(() => {});
await sleep(4000);
check('процесс страницы упал — приложение живо', topActivity().startsWith(PKG) && !!pid(), topActivity());
await reattach();
check('…и страница открылась заново', !!(await until(`!!document.querySelector('#bottomnav .nav-item')`, 20000)));
await sleep(500);
check('на странице после перезапуска нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('launch');
