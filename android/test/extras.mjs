// Мелочи, перенятые у приложения Anixart: разовая подсказка на Главной, компактное нижнее меню, значок приложения на
// выбор, светлая заставка при светлой теме, голосовой поиск, ярлык аниме на рабочий стол, поле комментария внизу,
// «Правила сообщества», «Поделиться» в профиле, «Динамика просмотра» в профиле
import { execFileSync } from 'node:child_process';
import { ensureDevice, install, launch, js, until, check, skip, done, tap, back, sleep, sh, PKG, topActivity, screenshot, pageErrors, persist, waitFor, tapWatchable, ADB, REAL } from './_device.mjs';

const away = () => !topActivity().startsWith(PKG);
const home = () => { sh(`am start -W -n ${PKG}/.MainActivity`); return sleep(1200); };
const launcher = () => sh(`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${PKG}`).trim().split('\n').pop();
// под нагрузкой (4 эмулятора) нажатие сразу после запуска бывает раньше, чем экран готов принимать нажатия — ещё раз
const openSettings = async (section) => {
  await tap('[title="Настройки"]', { after: 900 });
  if (!(await until(`!!document.querySelector('.settings-tab')`, 5000))) await tap('[title="Настройки"]', { after: 900 });
  await tap(`.settings-tab[data-section="${section}"]`, { after: 500 });
};

await ensureDevice();
install();
await launch({ fresh: true });
const apiOk = (await js(`fetch('/api/config/toggles').then((r) => r.status)`)) < 500;

// Разовая подсказка на Главной: про долгое нажатие на вкладку, закрывается касанием, второй раз — нет
check('первый запуск — подсказка про вкладки Главной', !!(await until(`/Удерживайте название вкладки/.test(document.querySelector('.hint-tip.show')?.textContent || '')`, 6000)));
screenshot('extras-hint');
await tap('#bottomnav .nav-item[data-tab="home"]', { after: 500 });
check('касание — подсказка закрылась', !!(await until(`!document.querySelector('.hint-tip')`, 2000)));
await persist();
await launch();
await sleep(2500);
check('второй запуск — подсказки нет', await js(`!document.querySelector('.hint-tip')`));

// Внешний вид: компактное нижнее меню — без подписей и ниже
const navH = await js(`document.getElementById('bottomnav').offsetHeight`);
await openSettings('look');
await tap('.settings-body .menu-item', { text: 'Компактное нижнее меню', after: 500 });
check('«Компактное нижнее меню» — без подписей и ниже', await js(`document.documentElement.classList.contains('compact-nav') && getComputedStyle(document.querySelector('#bottomnav .nav-item > span:last-child')).display === 'none' && document.getElementById('bottomnav').offsetHeight < ${navH} - 10`), navH);
await tap('.settings-body .menu-item', { text: 'Компактное нижнее меню', after: 500 });

// Значок приложения: светлый — ярлык запуска сменился, снова основной
check('значок по умолчанию — основной', /IconDefault/.test(launcher()), launcher());
await tap('.settings-body .menu-item', { text: 'Значок приложения', after: 600 });
await tap('.backdrop:not(.closing) .sheet-item, .backdrop:not(.closing) button', { text: 'Светлый', after: 1500 });
check('«Значок приложения» → светлый — ярлык запуска светлый', !!(await waitFor(() => /IconLight/.test(launcher()), 8000, 500)), launcher());
check('…приложение не закрылось', topActivity().startsWith(PKG), topActivity());
await tap('.settings-body .menu-item', { text: 'Значок приложения', after: 600 });
await tap('.backdrop:not(.closing) .sheet-item, .backdrop:not(.closing) button', { text: 'Основной', after: 1500 });
check('снова основной', !!(await waitFor(() => /IconDefault/.test(launcher()), 8000, 500)), launcher());

// Светлая тема — заставка при запуске светлая (раньше — тёмный экран до загрузки страницы)
await tap('.settings-body .menu-item', { text: 'Тёмная тема', after: 600 });
await tap('.backdrop:not(.closing) .sheet-item, .backdrop:not(.closing) button', { text: 'Светлая', after: 1200 });
await persist();
sh(`am force-stop ${PKG}`);
sh(`am start -n ${PKG}/.MainActivity`); // без -W: снимок до загрузки страницы
await sleep(250);
const raw = execFileSync(ADB, ['exec-out', 'screencap'], { maxBuffer: 64 << 20, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const w = raw.readUInt32LE(0); const hgt = raw.readUInt32LE(4); const hdr = raw.length - w * hgt * 4;
const px = (x, y) => { const o = hdr + (y * w + x) * 4; return [raw[o], raw[o + 1], raw[o + 2]]; };
const mid = px(w >> 1, (hgt * 0.6) | 0);
check('светлая тема — при запуске светлый экран, не тёмный', mid.every((c) => c > 200), mid);
await launch();
await js(`(localStorage.setItem('anixart.theme', 'dark'), 1)`);
await persist();
await launch();

// «Правила сообщества» — страница на сайте, в браузере
await openSettings('about');
await tap('.settings-body .menu-item', { text: 'Правила сообщества', after: 2500 });
check('«Правила сообщества» — в браузере', away(), topActivity());
await home();
await back();

// Голосовой поиск: кнопка микрофона в поиске — системное распознавание речи
if (await js(`!!window.anixartNative.voice.available()`)) {
  await tap('.appbar .searchbar', { after: 1200 });
  check('в поиске — кнопка голосового поиска', await js(`!!document.querySelector('.appbar .voice-btn')`));
  await tap('.appbar .voice-btn', { after: 2500 });
  check('микрофон — системное распознавание речи', away(), topActivity());
  await back(); await sleep(800);
  if (away()) await home();
  check('отменили — снова поиск, поле пустое', topActivity().startsWith(PKG) && await js(`document.body.dataset.screen === 'search' && document.querySelector('.appbar .searchbar input').value === ''`));
  await back();
} else skip('голосовой поиск', 'на устройстве нет распознавания речи');

if (!apiOk) { skip('аниме, комментарии, профиль', 'бекенд Anixart не отвечает'); done('extras'); }

// Ярлык аниме на рабочий стол — системный запрос рабочего стола
await until(`${REAL('.release-row')} > 0`, 25000);
await tapWatchable({ wait: 25000, after: 1500 });
await tap('.appbar [title="Ещё"]', { after: 700 });
await tap('.backdrop:not(.closing) .sheet-item, .backdrop:not(.closing) button', { text: 'На рабочий стол', after: 3000 });
const pin = sh('dumpsys activity activities | grep -E "topResumedActivity|mResumedActivity" | head -2');
check('«На рабочий стол» — запрос рабочего стола на ярлык', /launcher|PinItem|AddItem/i.test(pin) || away(), pin.trim());
screenshot('extras-pin');
await back(); await sleep(800);
if (away()) await home();

// Комментарии: поле — внизу экрана, над ним — список
await js(`import('/js/router.js').then((r) => (r.navigate('comments', { kind: 'release', id: 1 }), 1))`);
if (await until(`document.body.dataset.screen === 'comments'`, 8000)) {
  await sleep(1500);
  const pos = await js(`(() => { const c = document.querySelector('.screen .comment-input').getBoundingClientRect(); const v = document.getElementById('viewport').getBoundingClientRect(); return { bottom: Math.round(v.bottom - c.bottom), top: Math.round(c.top - v.top) }; })()`);
  check('комментарии: поле ввода внизу экрана', pos.bottom <= 2 && pos.top > 200, pos);
  screenshot('extras-comments');
  await back();
} else skip('поле комментария внизу', 'нет кнопки комментариев на странице аниме');
await back();

// Профиль (открытый, id 1): «Поделиться» в меню и «Динамика просмотра», если сервер её отдаёт
await js(`import('/js/router.js').then((r) => (r.navigate('profile', { id: 1 }), 1))`);
await until(`${REAL('.screen .card')} > 0 || !!document.querySelector('.screen .empty')`, 20000);
const hasDyn = await js(`!!document.querySelector('.wdyn')`);
if (hasDyn) {
  check('профиль: «Динамика просмотра» — столбцы с датами', await js(`document.querySelectorAll('.wdyn-col').length > 0 && [...document.querySelectorAll('.wdyn-d')].some((d) => /\\d\\d\\.\\d\\d/.test(d.textContent))`));
  await js(`document.querySelector('.wdyn').scrollIntoView({ block: 'center' }), 1`); await sleep(300);
  screenshot('extras-dynamics');
} else {
  // у профиля нет данных — тот же блок на подставленных (как в Anixart): 8 дней подряд по последний с просмотрами, число и
  // дата у каждого столбца, день без просмотров — «0» и короткий столбик; один день данных — не один столбец в пустоте
  const now = Math.floor(Date.now() / 1000);
  const fake = Array.from({ length: 14 }, (_, i) => ({ day: i, timestamp: now - (13 - i) * 86400, count: [0, 2, 5, 1, 0, 7, 3, 4, 0, 12, 6, 2, 9, 3][i] }));
  await js(`import('/js/screens/profile.js').then(({ watchDynamics }) => { const c = watchDynamics(${JSON.stringify(fake)}); c.id = 'test-dyn'; document.querySelector('#viewport .screen').prepend(c); c.scrollIntoView({ block: 'center' }); return 1; })`);
  await sleep(400);
  const d = await js(`(() => { const cols = [...document.querySelectorAll('#test-dyn .wdyn-col')]; const r = document.getElementById('test-dyn').getBoundingClientRect(); return { cols: cols.length, labels: cols.filter((c) => /\\d\\d\\.\\d\\d/.test(c.querySelector('.wdyn-d').textContent)).length, fits: cols.every((c) => c.getBoundingClientRect().right <= r.right + 1), tallest: Math.round(Math.max(...cols.map((c) => c.querySelector('.wdyn-bar').getBoundingClientRect().height))) }; })()`);
  check('«Динамика просмотра»: 8 дней, дата и число у каждого, всё в карточке', d.cols === 8 && d.labels === 8 && d.fits && d.tallest > 60, d);
  screenshot('extras-dynamics');
  await js(`document.getElementById('test-dyn').remove(), 1`);
  // один день с просмотрами — те же 8 дней: 7 нулей и столбец
  const one = await js(`import('/js/screens/profile.js').then(({ watchDynamics }) => { const c = watchDynamics([{ day: 1, timestamp: ${JSON.stringify(Math.floor(Date.now() / 1000))}, count: 4 }]); document.body.append(c); const n = [...c.querySelectorAll('.wdyn-n')].map((x) => x.textContent).join(','); const zeros = c.querySelectorAll('.wdyn-bar.zero').length; c.remove(); return { n, zeros }; })`);
  check('«Динамика просмотра»: один день — 8 столбцов, 7 нулей', one.n === '0,0,0,0,0,0,0,4' && one.zeros === 7, one);
}
await tap('.appbar [title="Ещё"]', { after: 700 });
check('профиль: в меню «Ещё» — «Поделиться»', await js(`[...document.querySelectorAll('.backdrop:not(.closing) .sheet-item, .backdrop:not(.closing) button')].some((b) => /Поделиться/.test(b.textContent))`));
await back();

await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('extras');
