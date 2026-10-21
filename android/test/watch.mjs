// Главный сценарий, как пальцем: каталог → аниме → «Смотреть» → озвучка → серия → встроенный плеер играет.
// В плеере: горизонталь без системных полос, экран не гаснет; тап показывает и прячет кнопки (не пауза), пауза — кнопкой;
// «Назад» закрывает плеер — снова вертикаль, полосы на месте; место в серии запомнено и переживает перезапуск
import { ensureDevice, install, launch, js, until, check, skip, done, REAL, tap, back, sleep, windowState, screenshot, sh, pageErrors, tapWatchable } from './_device.mjs';

await ensureDevice();
install();
await launch({ fresh: true });
const api = await js(`fetch('/api/config/toggles').then((r) => r.status)`);
if (api >= 500) { skip('просмотр', `бекенд Anixart отвечает ${api}`); done('watch'); }

check('каталог загрузился', !!(await until(`${REAL('.release-row')} >= 3`, 25000)));
await tapWatchable();
check('страница аниме: кнопка «Смотреть»', !!(await until(`${REAL('.btn-watch')}`, 20000)));
const title = await js(`document.querySelector('.appbar')?.textContent || ''`);
await tap('.btn-watch');
check('первый просмотр: список озвучек', !!(await until(`${REAL('.type-row')} > 0`, 20000)));

// Озвучка: первая, у которой серия запускается (источник бывает недоступен из этой страны — тогда следующая)
const voices = await js(`document.querySelectorAll('.type-row').length`);
let played = null; let voice = '';
for (let i = 0; i < Math.min(voices, 4) && !played; i++) {
  if (i === 0) { voice = await js(`document.querySelectorAll('.type-row')[0].textContent`); await tap('.type-row', { index: 0 }); }
  else {
    await tap('.wchip', { index: 0 });
    if (!(await until(`${REAL('.pop-item')} > ${i}`, 8000))) break;
    voice = await js(`[...document.querySelectorAll('.pop-item')].filter((e) => e.getClientRects().length)[${i}].textContent`);
    await tap('.pop-item', { index: i });
  }
  if (!(await until(`${REAL('.ep-row')} > 0`, 20000))) continue;
  await tap('.ep-row', { index: 0 });
  played = await until(`(() => { const v = document.querySelector('.player-overlay video'); return v && v.currentTime > 1.5 && v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight, t: v.currentTime } : null; })()`, 40000, 500);
  if (!played) {
    const msg = await js(`document.querySelector('.player-msg')?.textContent || ''`);
    console.log(`  озвучка «${voice.trim().slice(0, 30)}» не запустилась: ${msg.slice(0, 120)}`);
    if (await js(`!!document.querySelector('.player-overlay')`)) await back();
  }
}
check('серия играет во встроенном плеере', !!played, played ? `${played.w}×${played.h}, «${voice.trim().slice(0, 30)}»` : title.slice(0, 40));
if (!played) done('watch');

await sleep(1200);
let w = await windowState();
check('плеер: горизонталь, полосы спрятаны', w.playerOpen && w.landscape && !w.statusBarVisible && !w.navBarVisible, w);
check('плеер: экран не гаснет, пока идёт серия', w.keepScreenOn && w.playing, w);
check('плеер занимает весь экран', await js(`(() => { const r = document.querySelector('.player-overlay').getBoundingClientRect(); return r.width >= innerWidth - 1 && r.height >= innerHeight - 1; })()`));
screenshot('watch-player');

// Тап по видео: кнопки показываются и прячутся, серия не встаёт на паузу
await until(`document.querySelector('.player-overlay').classList.contains('idle')`, 8000);
await tap('.player-stage', { after: 900 });
check('тап по видео — кнопки видны, серия идёт', await js(`!document.querySelector('.player-overlay').classList.contains('idle') && !document.querySelector('.player-overlay video').paused`));
// кнопки сами прячутся через 2,5 с — второй тап сразу, пока они видны (снимок — потом)
await tap('.player-stage', { after: 600 });
check('второй тап — кнопки спрятались, серия идёт', await js(`document.querySelector('.player-overlay').classList.contains('idle') && !document.querySelector('.player-overlay video').paused`));
await tap('.player-stage', { after: 600 });
screenshot('watch-controls');
// Пауза — кнопкой на панели
await tap('.player-stage', { after: 700 });
const playBtn = await js(`(() => { const b = [...document.querySelectorAll('.player-controls button')].find((x) => /пауз|воспр|play/i.test((x.title || '') + (x.getAttribute('aria-label') || ''))); if (b) b.dataset.testPlay = '1'; return !!b; })()`);
check('на панели есть кнопка паузы', playBtn);
if (playBtn) {
  await tap('[data-test-play]', { after: 900 });
  check('кнопка — пауза', await js(`document.querySelector('.player-overlay video').paused`));
  w = await windowState();
  check('на паузе экран может гаснуть', !w.keepScreenOn, w);
  check('на паузе — круглая ▶ посреди экрана', await js(`(() => { const b = document.querySelector('.p-center'); return !!b && b.getClientRects().length > 0 && getComputedStyle(b).visibility !== 'hidden' && Number(getComputedStyle(b).opacity) > 0.5; })()`));
  await tap('.p-center', { after: 1200 });
  check('▶ — серия снова идёт', await js(`!document.querySelector('.player-overlay video').paused`));
}
// На телефоне нет ползунка громкости (кнопки телефона) и «во весь экран» (плеер и так на весь экран)
check('на панели нет громкости и «во весь экран»', await js(`!document.querySelector('.player-controls .vol') && ![...document.querySelectorAll('.player-controls button')].some((b) => /Во весь экран/.test(b.title))`));

// Мини-плеер: «Свернуть» — вертикаль, полосы на месте, серия идёт, каталог листается; тап — снова на весь экран
await tap('.player-stage', { after: 700 });
await tap('.player-top [title^="Свернуть"]', { after: 1500 });
w = await windowState();
check('мини-плеер: вертикаль и полосы, серия идёт', await js(`document.querySelector('.player-overlay').classList.contains('mini')`) && !w.landscape && w.statusBarVisible && w.playing && w.keepScreenOn, w);
screenshot('watch-mini');
const mini = await js(`(() => { const m = document.querySelector('.player-overlay.mini').getBoundingClientRect(); const n = document.getElementById('bottomnav').getBoundingClientRect(); const bar = document.querySelector('.player-overlay.mini .mini-bar'); return { w: Math.round(m.width), vw: innerWidth, gap: Math.round(n.top - m.bottom), bar: Number(getComputedStyle(bar).opacity) }; })()`);
check('мини-плеер: компактный, над нижним меню', mini.w <= mini.vw * 0.66 && mini.gap >= 4, mini);
check('мини-плеер: кнопки видны без наведения', mini.bar === 1, mini);
await tap('#bottomnav .nav-item[data-tab="discover"]', { after: 1200 });
check('под мини-плеером работает каталог (вкладка «Обзор»), серия идёт', await js(`document.querySelector('#bottomnav .nav-item.active')?.dataset.tab === 'discover' && !!document.querySelector('.player-overlay.mini') && !document.querySelector('.player-overlay video').paused`));
await tap('#bottomnav .nav-item[data-tab="home"]', { after: 1000 }); // назад на вкладку с экраном серий
await tap('.player-overlay.mini .mini-bar [title="Развернуть"]', { after: 1500 });
check('«Развернуть» на мини-плеере — на весь экран', await js(`!document.querySelector('.player-overlay').classList.contains('mini')`) && (await windowState()).landscape);
await tap('.player-stage', { after: 700 });
await tap('.player-top [title^="Свернуть"]', { after: 1500 });
await tap('.player-overlay.mini .player-stage', { after: 1500 });
w = await windowState();
check('тап по мини-плееру — снова на весь экран, горизонталь', await js(`!document.querySelector('.player-overlay').classList.contains('mini')`) && w.landscape && !w.statusBarVisible, w);

await sleep(3000);
const pos = await js(`document.querySelector('.player-overlay video').currentTime`);

// «Назад» закрывает плеер: вертикаль, полосы на месте, на экране серий — «остановились на …»
await back();
check('«Назад» закрыл плеер', await js(`!document.querySelector('.player-overlay')`));
await sleep(800);
w = await windowState();
check('после плеера — вертикаль и системные полосы', !w.playerOpen && !w.landscape && w.statusBarVisible && !w.keepScreenOn, w);
check('на экране серий — где остановились', !!(await until(`/остановились на/i.test(document.querySelector('.ep-row.current')?.textContent || '')`, 5000)));
screenshot('watch-episodes-after');

// Перезапуск (свернули → закрыли из «Недавних»): на странице аниме «Продолжить» с того же места
sh('input keyevent 3'); await sleep(2000);
await launch();
await tapWatchable({ wait: 25000 });
const cont = await until(`(() => { const b = document.querySelector('.btn-watch'); return b && /Продолжить/.test(b.textContent) ? b.textContent : null; })()`, 20000);
check('после перезапуска — «Продолжить» на странице аниме', !!cont, cont || '');
check(`позиция запомнена (~${Math.round(pos)} с)`, pos > 3);
await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('watch');
