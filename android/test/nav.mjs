// Навигация как в приложении Anixart: системная «Назад» на корне вкладки — на прошлую открытую вкладку, с первой —
// приложение сворачивается; тост — над нижним меню, а не поверх него; обновление свайпом вниз (кружок под шапкой,
// списки обновляются на месте, страница аниме — заново), не срабатывает от короткого натяжения и не у прокрученного экрана
import { ensureDevice, install, launch, js, until, check, skip, done, REAL, tap, back, sleep, topActivity, PKG, cdp, screenshot, pageErrors, tapWatchable, sh, point, windowState } from './_device.mjs';

const touch = (type, pts) => cdp('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
const tab = () => js(`import('/js/router.js').then((r) => r.currentTab())`);
const apiCalls = () => js(`performance.getEntriesByType('resource').filter((e) => /\\/(api\\/|__relay)/.test(e.name)).length`); // к серверу Anixart — через /__relay (shim.js)
// потянуть пальцем вниз от y на dy, по шагам; shot — снимок, пока палец на экране
async function pullDown(x, y, dy, { shot = null, steps = 12 } = {}) {
  await touch('touchStart', [[x, y]]);
  for (let i = 1; i <= steps; i++) { await touch('touchMove', [[x, y + dy * i / steps]]); await sleep(16); }
  const mid = await js(`(() => { const p = document.querySelector('.ptr'); return { show: p.classList.contains('show'), go: !!p.querySelector('.ptr-ring.go'), scroll: document.getElementById('viewport').scrollTop }; })()`);
  if (shot) screenshot(shot);
  await touch('touchEnd', []);
  return mid;
}

await ensureDevice();
install();
await launch({ fresh: true });
if ((await js(`fetch('/api/config/toggles').then((r) => r.status)`)) >= 500) { skip('навигация', 'бекенд Anixart не отвечает'); done('nav'); }

// Тост — над нижним меню
await js(`import('/js/ui.js').then(({ toast }) => (toast('Проверка', { ms: 4000 }), 1))`);
await sleep(700);
const pos = await js(`(() => { const t = document.getElementById('toast').getBoundingClientRect(); const n = document.getElementById('bottomnav').getBoundingClientRect(); return { toast: Math.round(t.bottom), nav: Math.round(n.top) }; })()`);
check('тост над нижним меню, не поверх', pos.toast <= pos.nav - 8, pos);

// «Назад» по вкладкам: Главная → Закладки → Лента, «Назад» — Закладки, ещё — Главная, ещё — приложение свернулось
await tap('#bottomnav .nav-item[data-tab="bookmarks"]', { after: 900 });
await tap('#bottomnav .nav-item[data-tab="feed"]', { after: 900 });
await tap('#bottomnav .nav-item[data-tab="bookmarks"]', { after: 900 }); // повторно — в истории один раз
await tap('#bottomnav .nav-item[data-tab="feed"]', { after: 900 });
await back();
check('«Назад» на корне «Ленты» — на «Закладки»', await tab() === 'bookmarks');
check('и нижнее меню показывает «Закладки»', await js(`document.querySelector('#bottomnav .nav-item.active')?.dataset.tab`) === 'bookmarks');
await back();
check('ещё «Назад» — на «Главную» (вкладка в истории один раз)', await tab() === 'home');
await back();
check('«Назад» на «Главной» — приложение свернулось', !topActivity().startsWith(PKG), topActivity());
sh(`am start -W -n ${PKG}/.MainActivity`);
await sleep(1200);

// Экран внутри вкладки: «Назад» — сначала экран, потом вкладка
await tap('#bottomnav .nav-item[data-tab="discover"]', { after: 900 });
await tap('#bottomnav .nav-item[data-tab="home"]', { after: 900 });
await tapWatchable({ wait: 25000, after: 1500 });
await until(`document.body.dataset.screen === 'release'`, 15000); // под нагрузкой страница аниме открывается дольше
await back();
check('«Назад» со страницы аниме — к списку, вкладка та же', await tab() === 'home' && await js(`document.body.dataset.depth`) === '1');
await back();
check('потом «Назад» — на прошлую вкладку «Обзор»', await tab() === 'discover');
await tap('#bottomnav .nav-item[data-tab="home"]', { after: 1200 });

// Обновление свайпом вниз: список на Главной — тихо, на месте
await until(`${REAL('.release-row, .release-card')} > 3`, 25000);
// палец — на полосе вкладок: касание строки аниме само загружает его страницу заранее (запрос — не обновление)
const vr = await js(`(() => { const r = document.querySelector('.screen .tabbar').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await js(`(performance.clearResourceTimings(), document.getElementById('viewport').scrollTop = 0, 1)`);
let calls = await apiCalls();
let mid = await pullDown(vr.x, vr.y, 60);
check('короткое натяжение: кружок есть, но не дотянут', mid.show && !mid.go, mid);
await sleep(1200);
check('короткое натяжение — без обновления', await apiCalls() === calls);
const firstBefore = await js(`document.querySelector('.tabbody .release-row, .tabbody .release-card')?.dataset.key`);
mid = await pullDown(vr.x, vr.y, 260, { shot: 'nav-pull' });
check('натянули дальше порога — кружок «готов», экран не прокручивается', mid.show && mid.go && mid.scroll === 0, mid);
check('отпустили — список запрошен заново', !!(await waitCalls(calls)));
check('список обновился на месте (скелетона нет, строки те же)', !!(await until(`!document.querySelector('.ptr.show') && !document.querySelector('.tabbody .sk')`, 15000)) && await js(`document.querySelector('.tabbody .release-row, .tabbody .release-card')?.dataset.key`) === firstBefore);

// Прокрученный экран — свайп вниз прокручивает, а не обновляет
await js(`(document.getElementById('viewport').scrollTop = 600, 1)`);
await sleep(300);
calls = await apiCalls();
mid = await pullDown(vr.x, vr.y, 200);
await sleep(800);
check('прокрученный экран: свайп вниз — прокрутка, без кружка', !mid.show && await apiCalls() === calls, mid);
await js(`(document.getElementById('viewport').scrollTop = 0, 1)`);

// Горизонтальный свайп по-прежнему меняет вкладку, кружка нет
const tabBefore = await js(`[...document.querySelectorAll('.tabbar .tab')].findIndex((t) => t.classList.contains('active'))`);
await touch('touchStart', [[vr.x + 120, vr.y + 300]]); // по списку: полоса вкладок прокручивается вбок сама
for (let i = 1; i <= 10; i++) { await touch('touchMove', [[vr.x + 120 - 26 * i, vr.y + 300 + 12 * i / 10]]); await sleep(16); }
const ptrOnSwipe = await js(`document.querySelector('.ptr').classList.contains('show')`);
await touch('touchEnd', []);
await sleep(700);
check('горизонтальный свайп — соседняя вкладка, без кружка', !ptrOnSwipe && await js(`[...document.querySelectorAll('.tabbar .tab')].findIndex((t) => t.classList.contains('active'))`) === tabBefore + 1);

// Шапка прячется при прокрутке вниз (полоса вкладок — к верху экрана) и возвращается при прокрутке вверх
const bars = () => js(`(() => { const v = document.getElementById('viewport').getBoundingClientRect().top; const a = document.querySelector('.screen .appbar').getBoundingClientRect(); const t = document.querySelector('.screen .tabbar').getBoundingClientRect(); return { hidden: document.documentElement.classList.contains('bar-hidden'), appbar: Math.round(a.bottom - v), tabbar: Math.round(t.top - v) }; })()`);
const sp = await point('.tabbody .release-row', { index: 1 });
sh(`input swipe ${sp.x} ${sp.y + 500} ${sp.x} ${sp.y - 300} 400`); await sleep(900);
let b = await bars();
check('прокрутка вниз — шапка уехала, вкладки у верха экрана', b.hidden && b.appbar <= 1 && Math.abs(b.tabbar) <= 1, b);
screenshot('nav-bar-hidden');
sh(`input swipe ${sp.x} ${sp.y} ${sp.x} ${sp.y + 250} 300`); await sleep(900);
b = await bars();
check('прокрутка вверх — шапка вернулась, вкладки под ней', !b.hidden && b.appbar > 40 && b.tabbar >= b.appbar - 1, b);
await js(`(document.getElementById('viewport').scrollTop = 0, 1)`); await sleep(400);

// Долгое нажатие на аниме — меню и отклик вибрацией
const h0 = (await windowState()).haptics;
const lp = await point('.tabbody .release-row');
sh(`input swipe ${lp.x} ${lp.y} ${lp.x} ${lp.y} 800`);
await sleep(900);
check('долгое нажатие — меню аниме и вибрация', await js(`!!document.querySelector('.backdrop:not(.closing)')`) && (await windowState()).haptics === h0 + 1, (await windowState()).haptics - h0);
await back();
await sleep(500);

// Страница аниме — строится заново со свежими данными, без въезда и без потери экрана
await tapWatchable({ wait: 25000, after: 1500 });
await until(`document.body.dataset.screen === 'release'`, 15000); // под нагрузкой страница аниме открывается дольше
const title = await js(`document.querySelector('.screen h1, .screen .title')?.textContent || ''`);
await js(`(performance.clearResourceTimings(), window.__oldScreen = document.querySelector('#viewport > .screen'), 1)`);
const rr = await js(`(() => { const r = document.getElementById('viewport').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 200 }; })()`);
await pullDown(rr.x, rr.y, 260);
check('страница аниме: свайп вниз — запрос к серверу', !!(await waitCalls(0)));
check('страница аниме: экран заменён свежим, то же аниме', !!(await until(`document.querySelector('#viewport > .screen') !== window.__oldScreen && !document.querySelector('.ptr.show')`, 15000)) && await js(`document.querySelector('.screen h1, .screen .title')?.textContent || ''`) === title, title);
check('страница аниме: «Назад» по-прежнему ведёт к списку', await js(`document.body.dataset.depth`) === '2');
// комментарии — без нижнего меню (больше места полю ввода), назад — меню снова на месте
const relKey = await js(`document.querySelector('.tabbody .release-row')?.dataset.key || ''`);
await js(`import('/js/router.js').then((r) => (r.navigate('comments', { kind: 'release', id: ${JSON.stringify(Number(relKey) || 1)} }), 1))`);
await until(`document.body.dataset.screen === 'comments'`, 10000);
check('комментарии — без нижнего меню', await js(`getComputedStyle(document.getElementById('bottomnav')).display === 'none'`));
await back();
check('назад со страницы комментариев — нижнее меню на месте', await js(`getComputedStyle(document.getElementById('bottomnav')).display !== 'none'`));
await back();

await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('nav');

async function waitCalls(n) {
  for (let t0 = Date.now(); Date.now() - t0 < 10000; await sleep(250)) if (await apiCalls() > n) return true;
  return false;
}
