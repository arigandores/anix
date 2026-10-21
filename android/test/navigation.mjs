// Навигация пальцем и системная «Назад»: вкладки нижнего меню, экраны, нижний лист «Ещё», выпадающее меню, поиск с
// клавиатурой, веб-плеер; на корне вкладки «Назад» — прошлые вкладки, потом сворачивает приложение, а возврат — на тот же экран
import { ensureDevice, install, launch, js, until, check, skip, done, REAL, tap, back, sleep, screenshot, topActivity, sh, PKG, typeText, pageErrors, windowState } from './_device.mjs';

const depth = () => js('Number(document.body.dataset.depth || 1)');
const tab = () => js(`document.querySelector('#bottomnav .nav-item.active')?.dataset.tab`);
const sheetOpen = () => js(`!!document.querySelector('.backdrop:not(.closing)')`);
const popOpen = () => js(`[...document.querySelectorAll('.pop-item')].some((e) => e.getClientRects().length)`);

await ensureDevice();
install();
await launch({ fresh: true });
const apiOk = (await js(`fetch('/api/config/toggles').then((r) => r.status)`)) < 500;

// Вкладки нижнего меню
for (const t of ['discover', 'bookmarks', 'feed', 'profile', 'home']) {
  await tap(`#bottomnav .nav-item[data-tab="${t}"]`, { after: 700 });
  check(`вкладка «${t}» открылась`, await tab() === t);
}
// «Назад» на корне вкладки — прошлые вкладки по порядку (Главная была первой, но открыта последней), потом — свернуть
for (const t of ['profile', 'feed', 'bookmarks', 'discover']) {
  await back();
  check(`«Назад» на корне вкладки — прошлая вкладка «${t}»`, await tab() === t);
}
check('«Назад» на корне последней вкладки — приложение свернулось', (await back(), !topActivity().startsWith(PKG)), topActivity());
sh(`am start -W -n ${PKG}/.MainActivity`); await sleep(1500);
check('вернулись — та же вкладка, без перезапуска', topActivity().startsWith(PKG) && await tab() === 'discover' && await js('!!document.querySelector(".nav-item")'));
await tap('#bottomnav .nav-item[data-tab="home"]', { after: 700 });

// Экран → «Назад»
await tap('[title="Настройки"]', { after: 900 });
check('настройки — экран поверх главной', await depth() === 2);
await tap('.settings-tab[data-section="look"]');
await tap('.settings-body .menu-item', { text: 'Тёмная тема', after: 700 });
check('нижний лист выбора открыт', await sheetOpen());
await back();
check('«Назад» закрыл лист, экран остался', !(await sheetOpen()) && await depth() === 2);
await back();
check('«Назад» — на главную', await depth() === 1 && await tab() === 'home');

// Поиск: поле с клавиатурой, «Назад» сначала прячет клавиатуру, потом закрывает экран
await tap('.searchbar', { after: 1200 });
check('экран поиска', await depth() === 2);
const focused = await until(`document.activeElement && document.activeElement.tagName === 'INPUT'`, 3000);
if (!focused) await tap('input', { after: 800 });
await typeText('naruto');
check('текст набирается в поле поиска', /naruto/i.test(await js(`document.activeElement?.value || ''`)));
const ws = await windowState();
check('клавиатура показана, страница ужалась над ней', ws.imeVisible && ws.webHeight < ws.rootHeight * 0.75, ws);
check('поле поиска видно над клавиатурой', await js(`(() => { const r = document.activeElement.getBoundingClientRect(); return r.bottom > 0 && r.bottom <= innerHeight; })()`));
if (apiOk) check('результаты поиска пришли', !!(await until(`${REAL('.release-row, .release-card')} > 0`, 20000)));
screenshot('nav-search');
await back();
const stillSearch = await depth() === 2;
check('первая «Назад» — прячет клавиатуру, экран поиска остался', stillSearch && !(await windowState()).imeVisible);
if (stillSearch) await back();
check('вторая «Назад» — на главную', await depth() === 1);

if (!apiOk) { skip('страница аниме, «Ещё», веб-плеер', 'бекенд Anixart не отвечает'); done('navigation'); }

// Страница аниме из поиска: аниме, у которого больше 6 озвучек (тогда в меню озвучек есть поле поиска) — по API,
// потом тем же запросом в поиске приложения, и жмём его строку по названию
const pick = await js(`(async () => {
  for (const q of ['Sora wa Akai Kawa', 'Jujutsu Kaisen', 'One Piece', 'Solo Leveling', 'Shingeki no Kyojin']) {
    const r = await (await fetch('/api/search/releases/0', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Version': 'v2' }, body: JSON.stringify({ query: q, searchBy: 0 }) })).json();
    for (const rel of (r.releases || []).slice(0, 4)) {
      const t = await (await fetch('/api/episode/' + rel.id)).json();
      if ((t.types || []).length > 6) return { q, title: rel.title_ru };
    }
  }
  return { q: 'naruto', title: null };
})()`);
await tap('.searchbar', { after: 1200 });
await typeText(pick.q);
await until(`${REAL('.release-row, .release-card')} > 0`, 20000);
await back(); // спрятать клавиатуру
await tap('.release-row, .release-card', pick.title ? { text: pick.title, after: 1200 } : { index: 0, after: 1200 });
check('страница аниме открылась', await depth() === 3 && !!(await until(`${REAL('.btn-watch')}`, 20000)));
await tap('.appbar [title="Ещё"]', { after: 700 });
check('«Ещё» — нижний лист', await sheetOpen());
await back();
check('«Назад» закрыл лист — страница аниме на месте', !(await sheetOpen()) && await depth() === 3);

// Экран серий: выпадающее меню озвучки закрывается «Назад»
await tap('.btn-watch', { after: 1200 });
await until(`${REAL('.type-row, .ep-row')} > 0`, 20000);
if (await js(`${REAL('.type-row')} > 0`)) await tap('.type-row', { index: 0, after: 1200 });
await until(`${REAL('.ep-row')} > 0`, 20000);
await tap('.wchip', { index: 0, after: 700 });
check('меню озвучек открыто', await popOpen());
await sleep(800);
if (!(await js(`!!document.querySelector('.pop-search')`))) skip('клавиатура в меню озвучек', 'озвучек меньше 7 — поля поиска нет');
else check('меню озвучек: поле поиска есть, клавиатура сама не открывается', !(await windowState()).imeVisible);
screenshot('nav-voice-menu');
await back();
check('«Назад» закрыл меню, экран серий остался', !(await popOpen()) && await depth() === 4);

// Веб-плеер (плеер источника) — «Назад» закрывает его
await tap('.wchip-player', { after: 700 });
await tap('.pop-item', { text: 'Веб-плеер', after: 900 });
await tap('.ep-row', { index: 0, after: 2500 });
const web = await until(`!!document.querySelector('.player-overlay iframe')`, 15000);
check('веб-плеер открылся', !!web);
screenshot('nav-web-player');
await back();
check('«Назад» закрыл веб-плеер', !(await js(`!!document.querySelector('.player-overlay')`)) && await depth() === 4);
await tap('.wchip-player', { after: 700 });
await tap('.pop-item', { text: 'Встроенный плеер', after: 700 });
await back(); await back(); await back();
check('«Назад» × 3 — на главную', await depth() === 1);
await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('navigation');
