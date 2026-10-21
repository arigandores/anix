// «Картинка в картинке»: свернули приложение, пока идёт серия, — плеер маленьким окном поверх других, видео идёт,
// кнопки плеера спрятаны; вернулись — плеер во весь экран. На паузе свернули — без окна, а серия не играет в фоне
import { ensureDevice, install, launch, js, until, check, skip, done, REAL, tap, sleep, windowState, screenshot, sh, PKG, pageErrors } from './_device.mjs';

const playing = () => js(`(() => { const v = document.querySelector('.player-overlay video'); return !!v && !v.paused && v.currentTime > 0; })()`);
const time = () => js(`document.querySelector('.player-overlay video')?.currentTime || 0`);

await ensureDevice();
install();
await launch({ fresh: true });
if ((await js(`fetch('/api/config/toggles').then((r) => r.status)`)) >= 500) { skip('PiP', 'бекенд Anixart не отвечает'); done('pip'); }

// Серия: первое аниме, первая озвучка, первая серия
await tap('.release-row', { index: 0, wait: 25000 });
await tap('.btn-watch', { wait: 20000, after: 1200 });
await until(`${REAL('.type-row, .ep-row')} > 0`, 20000);
if (await js(`${REAL('.type-row')} > 0`)) await tap('.type-row', { index: 0, after: 1200 });
await tap('.ep-row', { index: 0, wait: 20000 });
if (!(await until(`(() => { const v = document.querySelector('.player-overlay video'); return v && v.currentTime > 1.5 && !v.paused; })()`, 40000))) { skip('PiP', 'серия не запустилась'); done('pip'); }

// «Домой» во время серии → PiP
sh('input keyevent 3');
await sleep(2500);
let w = await windowState();
check('«Домой» во время серии — «картинка в картинке»', w.inPip, w);
check('в PiP — только видео (html.android-pip)', await js(`document.documentElement.classList.contains('android-pip') && getComputedStyle(document.querySelector('.player-controls')).display === 'none'`));
const t1 = await time(); await sleep(2500);
check('в PiP видео идёт', await playing() && (await time()) > t1 + 1, `${t1} → ${await time()}`);
screenshot('pip-window');

// Вернулись — плеер во весь экран, кнопки снова доступны
sh(`am start -W -n ${PKG}/.MainActivity`);
await sleep(2000);
w = await windowState();
check('вернулись — PiP закрыт, плеер на весь экран', !w.inPip && w.playerOpen && w.landscape, w);
check('класс PiP снят, видео идёт', await js(`!document.documentElement.classList.contains('android-pip')`) && await playing());

// Пауза и «Домой» — без PiP, серия стоит
await js(`document.querySelector('.player-overlay video').pause(), 1`);
await sleep(500);
sh('input keyevent 3');
await sleep(2500);
w = await windowState();
check('на паузе «Домой» — без PiP', !w.inPip, w);
const t2 = await time(); await sleep(2000);
check('в фоне серия не играет', !(await playing()) && Math.abs((await time()) - t2) < 0.5);
sh(`am start -W -n ${PKG}/.MainActivity`);
await sleep(1500);

// Играет в PiP, экран погас (блокировка) — серия на паузе, а не играет в фоне (MainActivity.onStop → __anixPause)
await js(`document.querySelector('.player-overlay video').play(), 1`);
await until(`!document.querySelector('.player-overlay video').paused`, 5000);
sh('input keyevent 3');
await sleep(2500);
if (!(await windowState()).inPip) skip('экран погас в PiP', 'PiP не открылся');
else {
  sh('input keyevent 223'); // экран погас
  await sleep(2500);
  const t3 = await time(); await sleep(1500);
  check('экран погас — серия встала на паузу', !(await playing()) && Math.abs((await time()) - t3) < 0.5);
  sh('input keyevent 224'); sh('wm dismiss-keyguard');
  await sleep(1500);
}
sh(`am start -W -n ${PKG}/.MainActivity`);
await sleep(1500);
await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('pip');
