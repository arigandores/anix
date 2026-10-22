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
// рамка видео — во весь плеер, а не по пропорциям ролика: иначе режим кадра ничего не меняет, а верх и низ обрезаны
const vbox = await js(`(() => { const v = ${V}.getBoundingClientRect(); const s = document.querySelector('.player-stage').getBoundingClientRect(); return { v: [Math.round(v.width), Math.round(v.height)], s: [Math.round(s.width), Math.round(s.height)], ih: innerHeight }; })()`);
check('видео — ровно во всю область плеера (режим кадра виден)', Math.abs(vbox.v[0] - vbox.s[0]) <= 1 && Math.abs(vbox.v[1] - vbox.s[1]) <= 1 && vbox.v[1] <= vbox.ih + 1, vbox);
check('кнопки «Кадр» и «Картинка в картинке» в панели', await js(`!!document.querySelector('.player-controls .fit-btn') && !!document.querySelector('.player-controls .pip-btn')`));
await js(`document.querySelector('.fit-btn').click(), 1`);
check('«Кадр» → заполнить, плашка «Заполнить»', await fitNow() === 'cover' && await js(`document.querySelector('.p-hint.show')?.textContent`) === 'Заполнить');
check('режим кадра запомнился', await js(`localStorage.getItem('anixart.pref.PLAYER_FIT')`) === '"cover"');
// Улучшение картинки (sharpen.js, как «720p +» в Anixart): холст над видео — с тем же режимом кадра; выключили — его нет
const big = await js(`${V}.videoWidth * ${V}.videoHeight > 1280 * 960`); // 1080p — улучшение не включается, так и задумано
await js(`(document.querySelector('.player-overlay').sharpen.setMode('soft'), ${V}.play().then(() => 1, () => 1))`);
const shp = await until(`(() => { const c = document.querySelector('.sharpen-canvas'); return c && getComputedStyle(c).display !== 'none' ? { fit: c.style.objectFit, w: c.width, vw: ${V}.videoWidth } : null; })()`, 8000);
if (big) check('улучшение картинки: у источника 1080p холста нет (и так чёткий)', !shp); else check('улучшение картинки: холст над видео, размер кадра и режим кадра — как у видео', !!shp && shp.fit === (await fitNow()) && shp.w === shp.vw, shp);
await js(`(document.querySelector('.player-overlay').sharpen.setMode('off'), ${V}.pause(), 1)`);
check('улучшение выключено — холста не видно', await js(`getComputedStyle(document.querySelector('.sharpen-canvas')).display === 'none'`));

// Нейросеть Anime4K (anime4k-gl.js): пункт «Нейросеть» — только с вердиктом фоновой проверки (phone-check.js); при выборе —
// холст Anime4K вдвое больше кадра, резкость выключена
const noVerdict = await js(`(localStorage.removeItem('anix.a4k'), import('/js/upscale/phone-check.js').then((m) => m.neuralOk()))`);
check('без проверки телефона «Нейросети» нет', noVerdict === false);
await js(`(localStorage.setItem('anix.a4k', JSON.stringify({ ms: { 480: { rm: 20, rs: 15, m: 10 }, 720: { rm: 49, rs: 25, m: 20 }, 1080: { r: 12 } }, v: 4 })), localStorage.setItem('anixart.pref.PLAYER_SHARPEN', '"neural"'), 1)`);
await js(`(document.querySelector('.player-overlay video').dispatchEvent(new Event('loadedmetadata')), ${V}.play().then(() => 1, () => 1))`);
const nn = await until(`(() => { const c = document.querySelector('.anime4k-canvas'); return c && getComputedStyle(c).display !== 'none' ? { w: c.width, vw: ${V}.videoWidth, sharp: getComputedStyle(document.querySelector('.sharpen-canvas:not(.anime4k-canvas)')).display } : null; })()`, 10000);
check('«Нейросеть»: холст Anime4K вдвое больше кадра, резкость выключена', !!nn && nn.w === nn.vw * 2 && nn.sharp === 'none', nn);
// облегчение: телефон не успел — цепочка полегче, и запоминается для этого разрешения (следующие серии — сразу с неё)
const chainBefore = await js(`document.querySelector('.player-overlay').anime4kChain`);
await js(`import('/js/upscale/phone-check.js').then((m) => (m.lighterFrom(${V}.videoWidth, ${V}.videoHeight, document.querySelector('.player-overlay').anime4kChain), document.querySelector('.player-overlay video').dispatchEvent(new Event('loadedmetadata')), 1))`);
await sleep(600);
const chainAfter = await js(`document.querySelector('.player-overlay').anime4kChain`);
check('720p: лучшая, что успевает, — Restore S; не успевает — легче (M) и запоминается', chainBefore === 'rs' && chainAfter === 'm' && !!(await js(`localStorage.getItem('anix.a4k.cap')`)), { chainBefore, chainAfter });
await js(`(localStorage.removeItem('anix.a4k.cap'), 1)`);
await js(`(localStorage.setItem('anixart.pref.PLAYER_SHARPEN', '"off"'), localStorage.removeItem('anix.a4k'), document.querySelector('.player-overlay video').dispatchEvent(new Event('loadedmetadata')), ${V}.pause(), 1)`);
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
check('свайп вправо на полэкрана — вперёд на 1:40, как в Anixart (p²/25 с)', t1 - t0 > 85 && t1 - t0 < 110, `${t0.toFixed(1)} → ${t1.toFixed(1)}`);
check('свайп не снимает паузу и не прячет плашку навсегда', await js(`${V}.paused && !document.querySelector('.p-hint.show')`));
// идёт видео — на время свайпа пауза (как в Anixart), отпустили — перемотало и играет дальше
await js(`${V}.play().then(() => 1, () => 1)`); await sleep(800);
await touch('touchStart', [[r.x + r.w * 0.8, cy]]);
for (let i = 1; i <= 8; i++) { await touch('touchMove', [[r.x + r.w * (0.8 - 0.2 * i / 8), cy]]); await sleep(16); }
check('свайп по идущему видео: пока ведёшь — пауза', await js(`${V}.paused`));
await touch('touchEnd', []);
await sleep(900);
const t2 = await js(`${V}.currentTime`);
check('после свайпа видео играет дальше', !(await js(`${V}.paused`)));
await js(`(${V}.pause(), 1)`);
check('свайп влево — назад', t2 < t1 - 3, `${t1.toFixed(1)} → ${t2.toFixed(1)}`);
await drag([[cx, r.y + r.h * 0.3]], [[cx + 10, r.y + r.h * 0.8]]);
check('вертикальный свайп — без перемотки', Math.abs(await js(`${V}.currentTime`) - t2) < 1);

// Перемотка опенинга без меток: кнопка — только у серии без меток (с метками — «Пропустить» по ним), +1:25. Видна ли —
// по вёрстке, не по атрибуту hidden: .icon-btn перебивал его, и кнопка стояла и при метках
const op = await js(`(() => { const b = document.querySelector('.player-controls .op-btn'); return { shown: !!b && getComputedStyle(b).display !== 'none', marks: !!document.querySelector('.seg[data-kind="opening"]'), title: b?.title, label: b?.textContent }; })()`);
check('кнопка «перемотать опенинг» — только у серии без метки опенинга (метка эндинга — не в счёт)', op.shown !== op.marks, op);
if (op.shown) {
  const a = await js(`${V}.currentTime`);
  await js(`document.querySelector('.op-btn').click(), 1`); await sleep(300);
  check('«перемотать опенинг» — +1:25, на кнопке «+85 с»', Math.abs(await js(`${V}.currentTime`) - a - 85) < 2 && /\+1:25/.test(op.title) && op.label === '+85 с', op);
}

// Полоса перемотки пальцем: пока тянут — точка и время за пальцем, видео не перематывается (и над опенингом не
// всплывает «Пропустить»), кнопки не прячутся, даже если тянуть дольше 2,5 с; отпустили — перемотка туда
await js(`(${V}.currentTime = 30, ${V}.play().then(() => 1, () => 1))`); await sleep(1200);
await js(`(document.querySelector('.player-overlay').classList.remove('idle'), 1)`);
const sk = await js(`(() => { const r = document.querySelector('.player-controls .seek').getBoundingClientRect(); const op = document.querySelector('.seek .seg[data-kind="opening"]'); const o = op ? op.getBoundingClientRect() : null; return { x: r.left, w: r.width, y: r.top + r.height / 2, op: o ? (o.left + o.width / 2 - r.left) / r.width : null }; })()`);
const from = sk.op ?? 0.05; const to = 0.6; const tStart = await js(`${V}.currentTime`);
await touch('touchStart', [[sk.x + sk.w * from, sk.y]]);
const during = [];
for (let i = 1; i <= 15; i++) {
  await touch('touchMove', [[sk.x + sk.w * (from + (to - from) * i / 15), sk.y]]); await sleep(200);
  if (i === 2 || i === 15) during.push(await js(`({ knob: parseFloat(document.querySelector('.seek .knob').style.left), t: ${V}.currentTime, skip: document.querySelector('.skip-row').classList.contains('show'), idle: document.querySelector('.player-overlay').classList.contains('idle'), tip: document.querySelector('.seek .tip, .seek-tip')?.classList.contains('show') ?? null })`));
}
check('ползунок пальцем: точка идёт за пальцем', Math.abs(during[1].knob - to * 100) < 2.5, during);
check('ползунок пальцем: пока тянут — видео не перематывается', during.every((d) => Math.abs(d.t - tStart) < 6), { tStart, during });
check('ползунок пальцем: над опенингом посреди жеста — без «Пропустить»', during.every((d) => !d.skip), during);
check('ползунок пальцем: кнопки не прячутся, пока тянут (3 с)', during.every((d) => !d.idle), during);
await touch('touchEnd', []); await sleep(900);
const dur = await js(`${V}.duration`); const tEnd = await js(`${V}.currentTime`);
check('ползунок отпустили — перемотка туда, где палец', Math.abs(tEnd - to * dur) < 5, `${tEnd.toFixed(1)} из ${dur.toFixed(0)}, ждали ~${(to * dur).toFixed(0)}`);
await js(`(${V}.pause(), 1)`);

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
// и улучшение картинки включено: закрытие плеера — не «недоступно на этом устройстве» (видеокарту освобождаем сами)
await js(`(document.getElementById('toast') && (document.getElementById('toast').textContent = ''), document.querySelector('.player-overlay').sharpen?.setMode('soft'), 1)`); await sleep(1500);
await js(`(localStorage.setItem('anixart.pref.PLAYER_LANDSCAPE_ONLY', 'true'), document.querySelector('.player-overlay .player-top .icon-btn').click(), 1)`);
await sleep(800);
check('закрыли плеер с улучшением картинки — без тоста «недоступно»', !/недоступно/.test(await js(`document.getElementById('toast')?.textContent || ''`)), await js(`document.getElementById('toast')?.textContent || ''`));
await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('player-touch');
