// Главная и соседние экраны пальцем (замечания с телефона): шапка прячется без щели под ней; выбранная вкладка — по
// центру полосы (видно, что дальше есть ещё); у вкладок своя прокрутка — возврат свайпом на то же место, сразу, без
// анимации прокрутки и без возврата шапки; соседняя вкладка строится заранее и при свайпе не запускает проявление
// строк разом; поиск — строка не шире экрана, нижнего меню над клавиатурой нет; фильтр — поля с окном галочек, а не
// сотни чипов; быстрые нажатия по соседним переключателям — срабатывают все; «Обзор» без соцсетей Anixart;
// комментарии на странице аниме — в самом низу. Вход и ответы сервера для настроек уведомлений подменены (__mock)
import { ensureDevice, install, launch, js, until, check, done, tap, back, sleep, sh, screenshot, persist, REAL, cdp } from './_device.mjs';

await ensureDevice();
install();
await launch();
await until(REAL('.release-row'), 30000);
await sleep(4000); // первая страница и соседние вкладки догрузились
const vpY = () => js('document.getElementById("viewport").scrollTop');
const setY = (y) => js(`(() => { const v = document.getElementById('viewport'); v.scrollTop = ${y}; return v.scrollTop; })()`);
const swipe = (x1, x2) => sh(`input swipe ${x1} 1400 ${x2} 1400 180`);

// 0. Страница не масштабируется щипком (это приложение, а не сайт): метатег и WebView, масштаб после щипка — 1
check('метатег viewport запрещает масштабирование', await js(`/user-scalable=no/.test(document.querySelector('meta[name=viewport]').content)`));
{
  const pinch = (type, d) => cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: 200 - d, y: 450, id: 0 }, { x: 200 + d, y: 450, id: 1 }] });
  await pinch('touchStart', 30);
  for (let d = 40; d <= 160; d += 20) { await pinch('touchMove', d); await sleep(30); }
  await pinch('touchEnd', 0); await sleep(600);
  check('щипок двумя пальцами не масштабирует страницу', await js('visualViewport.scale') === 1, await js('visualViewport.scale'));
}

// 1. Шапка: между её низом и полосой вкладок — ни одного кадра со щелью
await js(`(() => { window.__gap = []; const loop = () => { const s = document.querySelector('#viewport .screen'); const a = s.querySelector('.appbar').getBoundingClientRect(); const b = s.querySelector('.tabbar').getBoundingClientRect(); const v = document.getElementById('viewport').getBoundingClientRect().top; window.__gap.push(Math.round(b.top - Math.max(a.bottom, v))); window.__hid = window.__hid || document.documentElement.classList.contains('bar-hidden'); if (window.__gap.length < 400) requestAnimationFrame(loop); }; requestAnimationFrame(loop); return 1; })()`);
for (let i = 0; i < 3; i++) { sh('input swipe 540 1800 540 900 250'); await sleep(450); sh('input swipe 540 900 540 1300 250'); await sleep(450); }
const gaps = await js('window.__gap');
check('шапка прячется и возвращается без щели под ней', gaps.length > 50 && gaps.every((g) => g <= 1), `кадров со щелью: ${gaps.filter((g) => g > 1).length} из ${gaps.length}`);
check('шапка пряталась при прокрутке вниз (проверка щели — с движением)', await js('!!window.__hid'));

// 2. Своя прокрутка у вкладок: «Аниме» с середины → «Дунхуа» с начала списка → обратно на то же место, одним прыжком
await setY(1800); await sleep(600);
const animeY = await vpY();
swipe(900, 200); await sleep(1500);
check('соседняя вкладка — с начала своего списка', (await vpY()) < 5, `прокрутка ${await vpY()}`);
await setY(1200); await sleep(600);
sh('input swipe 540 1500 540 1100 300'); await sleep(700); // палец вниз — шапка спряталась
const hiddenBefore = await js(`document.documentElement.classList.contains('bar-hidden')`);
await js(`(() => { window.__sc = []; document.getElementById('viewport').addEventListener('scroll', (e) => window.__sc.push(e.target.scrollTop)); return 1; })()`);
swipe(200, 900); await sleep(1500);
const sc = await js('window.__sc');
check('вернулись свайпом — на прежнее место, без анимации прокрутки', Math.abs((await vpY()) - animeY) < 2 && sc.length <= 1, `было ${animeY}, стало ${await vpY()}, событий прокрутки ${sc.length}`);
check('прыжок прокрутки вкладки не возвращает шапку', hiddenBefore && await js(`document.documentElement.classList.contains('bar-hidden')`), { hiddenBefore });

// 3. Выбранная вкладка — по центру полосы: справа видно следующую
for (let i = 0; i < 2; i++) { swipe(900, 200); await sleep(1300); }
const bar = await js(`(() => { const b = document.querySelector('#viewport .screen .tabbar'); const r = b.getBoundingClientRect(); const tabs = [...b.querySelectorAll('.tab')]; const i = tabs.findIndex((t) => t.classList.contains('active')); const a = tabs[i].getBoundingClientRect(); const n = tabs[i + 1]?.getBoundingClientRect(); return { name: tabs[i].textContent, center: Math.round(a.left + a.width / 2 - (r.left + r.width / 2)), nextVisible: !!n && n.left < r.right - 24 }; })()`);
screenshot('home-ux-tabs');
check('выбранная вкладка — по центру полосы, следующая видна', Math.abs(bar.center) < 6 && bar.nextVisible, bar);

// 4. Свайп к вкладке, построенной заранее, — без проявления строк разом
const next = await js(`(() => { const b = document.querySelector('#viewport .screen .tabbar'); const tabs = [...b.querySelectorAll('.tab')]; return tabs.findIndex((t) => t.classList.contains('active')) + 1; })()`);
await sleep(2500);
await js(`(() => { window.__an = 0; let n = 0; const loop = () => { window.__an = Math.max(window.__an, document.getAnimations().filter((a) => a.animationName === 'content-in').length); if (++n < 90) requestAnimationFrame(loop); }; requestAnimationFrame(loop); return 1; })()`);
swipe(900, 200); await sleep(1800);
check('свайп к соседней вкладке: строки не проявляются все разом', (await js('window.__an')) < 5, `анимаций появления строк: ${await js('window.__an')} (вкладка ${next})`);

// 5. Поиск: строка не шире экрана, нижнего меню над клавиатурой нет
await setY(0); await sleep(500);
await tap('#viewport .screen .searchbar', { after: 2500 });
const kb = await js(`(() => { const last = [...document.querySelectorAll('#viewport .screen .appbar > *')].pop().getBoundingClientRect(); return { right: Math.round(last.right), w: innerWidth, kb: document.documentElement.classList.contains('kb-open'), nav: getComputedStyle(document.getElementById('bottomnav')).display }; })()`);
screenshot('home-ux-search');
check('поиск: кнопки строки поиска на экране', kb.right <= kb.w, kb);
check('открыта клавиатура — нижнего меню нет', kb.kb && kb.nav === 'none', kb);
await back(); await back();
check('клавиатура закрыта — нижнее меню на месте', !!(await until(`getComputedStyle(document.getElementById('bottomnav')).display !== 'none'`, 5000)));

// 6. Фильтр «Моей вкладки»: поля с окном галочек, выбранное — в поле
await js(`import('/js/router.js').then((r) => (r.navigate('filter', { customTab: true }), 1))`); await sleep(2000);
const chips = await js(`document.querySelectorAll('#viewport .screen .filter-form .chip').length`);
const height = await js('document.getElementById("viewport").scrollHeight');
check('фильтр: жанры, закладки, озвучки — полями, не сотнями чипов', chips === 0 && height < 3000, { chips, height });
await tap('#viewport .screen .pick-field', { index: 0, after: 1000 });
check('«Жанры» — окно с режимом и галочками', await js(`!!document.querySelector('.backdrop:not(.closing) .pick-modes') && document.querySelectorAll('.backdrop:not(.closing) .pick-list input[type=checkbox]').length > 20`));
await tap('.backdrop:not(.closing) .pick-list .sheet-item', { index: 1, after: 300 });
await tap('.backdrop:not(.closing) .dialog-actions .btn-primary', { after: 800 });
check('выбранный жанр — в поле', await js(`(document.querySelector('#viewport .screen .pick-field')?.textContent || '') !== 'Неважно'`), await js(`document.querySelector('#viewport .screen .pick-field')?.textContent`));
screenshot('home-ux-filter');
await back();

// 7. «Обзор» без соцсетей Anixart; комментарии на странице аниме — внизу
await js(`import('/js/router.js').then((r) => (r.switchTab('discover'), 1))`);
await until(`document.querySelectorAll('#viewport .screen .tile').length > 0`, 20000);
check('«Обзор»: нет плиток «Anixart ВКонтакте» и «Anixart в Telegram»', await js(`![...document.querySelectorAll('#viewport .screen .tile')].some((t) => /ВКонтакте|Telegram/.test(t.textContent))`));
await js(`import('/js/router.js').then((r) => (r.switchTab('home'), 1))`); await sleep(1500);
await tap('#viewport .screen .release-row', { index: 0, after: 4000 });
await until(`!!document.querySelector('#viewport .screen .rel-body:not(.skeleton) .rel-comments')`, 20000);
// порядок на телефоне — как в Anixart: описание, «В списках у людей», рейтинг, коллекции, видео, кадры, связанные,
// рекомендуемые, комментарии (каких блоков у аниме нет — пропускаются)
const ORDER = ['rb-info', 'rb-stats', 'rb-rating', 'rb-collections', 'rb-video', 'rb-screens', 'rb-related', 'rb-recommended', 'rel-comments'];
const order = await js(`[...document.querySelectorAll('#viewport .screen .rel-body:not(.skeleton) .card')].filter((e) => /(rb-|rel-comments)/.test(e.className)).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((e) => ${JSON.stringify(ORDER)}.find((c) => e.classList.contains(c)))`);
check('страница аниме: блоки по порядку Anixart, комментарии — в самом низу', order.length >= 4 && order[0] === 'rb-info' && order.at(-1) === 'rel-comments' && order.every((c, i) => !i || ORDER.indexOf(c) > ORDER.indexOf(order[i - 1])), order);
await back();

// Обновление свайпом вниз на «Моей вкладке» (пустой — экран пересобирается) — на ней же, а не на вкладке по умолчанию
await js(`import('/js/router.js').then((r) => (r.switchTab('home'), 1))`); await sleep(1200);
await tap('#viewport .screen .tabbar .tab', { index: 0, after: 1200 });
await js(`import('/js/router.js').then((r) => r.refreshCurrent()).then(() => 1)`); await sleep(1500);
check('обновление «Моей вкладки» — остаёмся на ней', await js(`[...document.querySelectorAll('#viewport .screen .tabbar .tab')].findIndex((t) => t.classList.contains('active'))`) === 0);

// 8. Быстрые нажатия по соседним переключателям (настройки уведомлений) — срабатывают все
await js(`(localStorage.setItem('anixart.token', 'test-token'), localStorage.setItem('anixart.profile', JSON.stringify({ id: 1, login: 'tester' })), 1)`);
await persist();
await launch();
await js(`(() => { const off = {}; for (const k of ['is_episode_notifications_enabled', 'is_first_episode_notification_enabled', 'is_related_release_notifications_enabled', 'is_article_notifications_enabled', 'is_comment_notifications_enabled', 'is_my_collection_comment_notifications_enabled', 'is_my_article_comment_notifications_enabled', 'is_report_process_notifications_enabled']) off[k] = false;
  window.__mock = { 'profile/preference/notification/my': { code: 0, ...off }, 'type/all': { code: 0, types: [] } }; window.__calls = []; const f = window.fetch;
  window.fetch = (u, o = {}) => { const url = String(u instanceof Request ? u.url : u); window.__calls.push(url); const path = url.split('?')[0];
    if (/\\/notification\\/.*\\/edit$/.test(path)) return Promise.resolve(new Response('{"code":0}', { headers: { 'Content-Type': 'application/json' } }));
    const key = Object.keys(window.__mock).find((k) => path.endsWith('/api/' + k)); return key ? Promise.resolve(new Response(JSON.stringify(window.__mock[key]), { headers: { 'Content-Type': 'application/json' } })) : f(u, o); };
  return 1; })()`);
await js(`import('/js/router.js').then((r) => (r.navigate('notification-settings'), 1))`);
await until(`document.querySelectorAll('#viewport .screen .menu-item .switch').length > 4`, 15000); await sleep(800);
const pts = await js(`[...document.querySelectorAll('#viewport .screen label.menu-item .switch')].filter((x) => { const r = x.getBoundingClientRect(); return r.top > 0 && r.bottom < document.getElementById('bottomnav').getBoundingClientRect().top; }).slice(1, 5).map((s) => { const r = s.getBoundingClientRect(); const [ox, oy] = anixAndroid.webOrigin().split(',').map(Number); return [Math.round(ox + (r.left + r.width / 2) * devicePixelRatio), Math.round(oy + (r.top + r.height / 2) * devicePixelRatio)]; })`);
for (const [x, y] of pts) sh(`input tap ${x} ${y}`);
await sleep(1500);
const on = await js(`[...document.querySelectorAll('#viewport .screen label.menu-item .switch input')].slice(1, 5).map((c) => c.checked)`);
const sent = (await js('window.__calls')).filter((u) => /notification\/.*\/edit/.test(u)).length;
check('четыре быстрых нажатия по переключателям — включились все четыре', pts.length === 4 && on.length === 4 && on.every(Boolean) && sent === 4, { on, sent });
await js(`(localStorage.removeItem('anixart.token'), localStorage.removeItem('anixart.profile'), 1)`);
await persist();

done('home-ux');
