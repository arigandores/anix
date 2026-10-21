// Плеер пальцем (как в приложении Anixart): режим кадра кнопкой и щипком, перемотка свайпом по горизонтали с плашкой,
// видео до края экрана (под вырезом камеры), кнопки окна «картинка в картинке» и гарнитуры, кнопка «картинка в картинке»
import { ensureDevice, install, launch, js, until, check, skip, done, REAL, tap, back, sleep, windowState, sh, PKG, pageErrors, tapWatchable, cdp, screenshot, reattach } from './_device.mjs';

const V = `document.querySelector('.player-overlay video')`;
const fitNow = () => js(`getComputedStyle(${V}).objectFit`);
const touch = (type, pts) => cdp('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
// провести пальцами: from/to — списки точек [[x, y], …], по шагам
async function drag(from, to, steps = 10) {
  await touch('touchStart', from);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', from.map(([x, y], k) => [x + (to[k][0] - x) * i / steps, y + (to[k][1] - y) * i / steps]));
    await sleep(16);
  }
  await touch('touchEnd', []);
  await sleep(300);
}

await ensureDevice();
install();
await launch({ fresh: true });
if ((await js(`fetch('/api/config/toggles').then((r) => r.status)`)) >= 500) { skip('плеер пальцем', 'бекенд Anixart не отвечает'); done('player-touch'); }

await tapWatchable({ wait: 25000 });
await tap('.btn-watch', { wait: 20000, after: 1200 });
await until(`${REAL('.type-row, .ep-row')} > 0`, 45000);
if (await js(`${REAL('.type-row')} > 0`)) await tap('.type-row', { index: 0, after: 1200 });
await tap('.ep-row', { index: 0, wait: 45000 });
if (!(await until(`(() => { const v = ${V}; return v && v.currentTime > 1.5 && !v.paused && v.duration > 300; })()`, 40000))) { skip('плеер пальцем', 'серия не запустилась'); done('player-touch'); }
await sleep(800);

// Видео — до края экрана: у окна нет отступа под вырез камеры, кнопки отодвигает страница
const w0 = await windowState();
check('плеер: у окна нет отступов (видео до края, под вырезом камеры)', w0.rootPadding === '0,0,0,0', w0.rootPadding);
check('плеер: вырез камеры передан странице (--cut-*)', await js(`getComputedStyle(document.documentElement).getPropertyValue('--cut-l') !== ''`));

// Режим кадра: по умолчанию «Вписать», кнопка перебирает «Заполнить» → «Растянуть» → «Вписать», выбор запоминается
check('режим кадра по умолчанию — вписать', await fitNow() === 'contain', await fitNow());
check('кнопки «Кадр» и «Картинка в картинке» в панели', await js(`!!document.querySelector('.player-controls .fit-btn') && !!document.querySelector('.player-controls .pip-btn')`));
await js(`document.querySelector('.fit-btn').click(), 1`);
check('«Кадр» → заполнить, плашка «Заполнить»', await fitNow() === 'cover' && await js(`document.querySelector('.p-hint.show')?.textContent`) === 'Заполнить');
check('режим кадра запомнился', await js(`localStorage.getItem('anixart.pref.PLAYER_FIT')`) === '"cover"');
await js(`document.querySelector('.fit-btn').click(), 1`);
check('«Кадр» → растянуть', await fitNow() === 'fill');
await js(`document.querySelector('.fit-btn').click(), 1`);
check('«Кадр» → снова вписать', await fitNow() === 'contain');

// Щипок: развели пальцы — заполнить, свели — вписать; пауза при этом не нажимается
const r = await js(`(() => { const b = document.querySelector('.player-stage').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
const cx = r.x + r.w / 2; const cy = r.y + r.h / 2;
const paused0 = await js(`${V}.paused`);
await drag([[cx - 60, cy], [cx + 60, cy]], [[cx - 220, cy], [cx + 220, cy]]);
check('щипок наружу — заполнить', await fitNow() === 'cover', await fitNow());
await drag([[cx - 220, cy], [cx + 220, cy]], [[cx - 50, cy], [cx + 50, cy]]);
check('щипок внутрь — вписать', await fitNow() === 'contain', await fitNow());
await sleep(500);
check('щипок не ставит паузу', await js(`${V}.paused`) === paused0);

// Свайп по горизонтали: перемотка на отпускании, плашка «+м:сс · м:сс» во время движения
await js(`(${V}.pause(), ${V}.currentTime = 120, 1)`);
await sleep(800);
const t0 = await js(`${V}.currentTime`);
await touch('touchStart', [[r.x + r.w * 0.3, cy]]);
for (let i = 1; i <= 12; i++) { await touch('touchMove', [[r.x + r.w * (0.3 + 0.5 * i / 12), cy + i]]); await sleep(16); }
const shown = await js(`document.querySelector('.p-hint.show')?.textContent || ''`);
check('свайп: плашка с перемоткой вперёд', /^\+\d+:\d\d · \d+:\d\d$/.test(shown), shown);
screenshot('player-touch-swipe');
check('свайп: пока палец на экране — не перематывает', Math.abs(await js(`${V}.currentTime`) - t0) < 1);
await touch('touchEnd', []);
await sleep(600);
const t1 = await js(`${V}.currentTime`);
check('свайп вправо на полэкрана — вперёд примерно на минуту', t1 - t0 > 30 && t1 - t0 < 90, `${t0.toFixed(1)} → ${t1.toFixed(1)}`);
check('свайп не снимает паузу и не прячет плашку навсегда', await js(`${V}.paused && !document.querySelector('.p-hint.show')`));
await drag([[r.x + r.w * 0.8, cy]], [[r.x + r.w * 0.6, cy]]);
const t2 = await js(`${V}.currentTime`);
check('свайп влево — назад', t2 < t1 - 3, `${t1.toFixed(1)} → ${t2.toFixed(1)}`);
await drag([[cx, r.y + r.h * 0.3]], [[cx + 10, r.y + r.h * 0.8]]);
check('вертикальный свайп — без перемотки', Math.abs(await js(`${V}.currentTime`) - t2) < 1);

// Перемотка опенинга без меток: кнопка — только у серии без меток (с метками — «Пропустить» по ним), +1:25
const op = await js(`(() => { const b = document.querySelector('.player-controls .op-btn'); return { shown: !!b && !b.hidden, marks: !!document.querySelector('.seg[data-kind="opening"]'), title: b?.title }; })()`);
check('кнопка «перемотать опенинг» — только у серии без метки опенинга (метка эндинга — не в счёт)', op.shown !== op.marks, op);
if (op.shown) {
  const a = await js(`${V}.currentTime`);
  await js(`document.querySelector('.op-btn').click(), 1`); await sleep(300);
  check('«перемотать опенинг» — +1:25', Math.abs(await js(`${V}.currentTime`) - a - 85) < 2 && /\+1:25/.test(op.title), op.title);
}

// Блокировка: касания не действуют, ориентация зафиксирована; тап — замок, замок или «Назад» — снять
await js(`document.querySelector('.player-top .lock-btn').click(), 1`);
await sleep(500);
let lw = await windowState();
check('замок — плеер заблокирован, ориентация зафиксирована', await js(`document.querySelector('.player-overlay').classList.contains('locked')`) && lw.requestedOrientation === 14, lw.requestedOrientation);
const pausedL = await js(`${V}.paused`); const tL = await js(`${V}.currentTime`);
await touch('touchStart', [[r.x + r.w * 0.3, cy]]);
for (let i = 1; i <= 10; i++) { await touch('touchMove', [[r.x + r.w * (0.3 + 0.05 * i), cy]]); await sleep(16); }
await touch('touchEnd', []);
await sleep(400);
check('заблокирован: свайп не перематывает', Math.abs(await js(`${V}.currentTime`) - tL) < 2 || !pausedL);
await tap('.player-stage', { after: 500 });
check('заблокирован: тап — замок, без кнопок плеера', await js(`document.querySelector('.p-unlock.show') && getComputedStyle(document.querySelector('.player-controls')).display === 'none'`));
await back();
lw = await windowState();
check('«Назад» на заблокированном — снимает блокировку, плеер открыт', lw.playerOpen && await js(`!document.querySelector('.player-overlay').classList.contains('locked')`) && lw.requestedOrientation === 6, lw);
await js(`document.querySelector('.player-top .lock-btn').click(), 1`); await sleep(300);
await tap('.player-stage', { after: 400 });
await tap('.p-unlock', { after: 500 });
check('замок на экране — снимает блокировку', await js(`!document.querySelector('.player-overlay').classList.contains('locked')`) && (await windowState()).requestedOrientation === 6);

// Команды от окна «картинка в картинке» и гарнитуры (MainActivity.media → __anixMedia)
await js(`(__anixMedia('play'), 1)`);
check('команда «продолжить» — видео идёт', !!(await until(`!${V}.paused`, 5000)));
await sleep(500);
let w = await windowState();
check('идёт серия: кнопки окна PiP — −10 с, пауза, +10 с', w.pipActions === '−10 с|Пауза|+10 с', w.pipActions);
check('идёт серия: медиасессия «играет» (кнопки гарнитуры)', w.session === 3, w.session);
const before = await js(`${V}.currentTime`);
await js(`(__anixMedia('rew'), 1)`); await sleep(300);
check('команда −10 с', await js(`${V}.currentTime`) < before - 8);
await js(`(__anixMedia('pause'), 1)`);
check('команда «пауза»', !!(await until(`${V}.paused`, 5000)));
await sleep(500);
w = await windowState();
check('на паузе: в окне PiP — «Продолжить», медиасессия на паузе', w.pipActions === '−10 с|Продолжить|+10 с' && w.session === 2, w);
const atNext = await js(`document.querySelector('.player-top .ttl span').textContent`);
await js(`(__anixMedia('next'), 1)`);
check('команда «следующая серия»', !!(await until(`document.querySelector('.player-top .ttl span').textContent !== ${JSON.stringify(atNext)}`, 30000)), atNext); // ссылка на серию под нагрузкой — дольше

// Кнопка «Картинка в картинке»
await until(`(() => { const v = ${V}; return v && v.readyState >= 2; })()`, 30000);
await js(`(${V}.play(), 1)`);
await sleep(800);
await js(`document.querySelector('.pip-btn').click(), 1`);
await sleep(2000);
w = await windowState();
check('кнопка «Картинка в картинке» — окно PiP', w.inPip, w);
screenshot('player-touch-pip');
sh(`am start -W -n ${PKG}/.MainActivity`);
await sleep(1500);
await reattach();
w = await windowState();
check('вернулись из PiP — плеер на весь экран', !w.inPip && w.playerOpen, w);

await js(`document.querySelector('.player-overlay .player-top .icon-btn').click(), 1`); // закрыть плеер
await sleep(800);
w = await windowState();
check('плеер закрыт — медиасессии нет, у окна снова отступы под полосы', w.session === 0 && w.rootPadding !== '0,0,0,0', w);

// «Только горизонтально» выключено — плеер поворачивается за телефоном
await js(`(localStorage.setItem('anixart.pref.PLAYER_LANDSCAPE_ONLY', 'false'), 1)`);
// после плеера — экран серий; нет его (под нагрузкой закрытие ушло дальше) — открыть заново
if (!(await until(`${REAL('.ep-row')} > 0`, 8000))) {
  await tap('.btn-watch', { wait: 20000, after: 1200 });
  if (await until(`${REAL('.type-row')} > 0 && ${REAL('.ep-row')} === 0`, 5000)) await tap('.type-row', { index: 0, after: 1200 });
}
await tap('.ep-row', { index: 0, wait: 30000, after: 500 });
// плеер открывается, когда пришла ссылка на серию (на строке — кружок загрузки), под нагрузкой — несколько секунд
await until(`!!document.querySelector('.player-overlay:not(.mini)')`, 30000);
await sleep(1500);
w = await windowState();
check('«Только горизонтально» выключено — ориентация за телефоном', w.playerOpen && w.requestedOrientation === 13, w.requestedOrientation);
await js(`(localStorage.setItem('anixart.pref.PLAYER_LANDSCAPE_ONLY', 'true'), document.querySelector('.player-overlay .player-top .icon-btn').click(), 1)`);
await sleep(800);
await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('player-touch');
