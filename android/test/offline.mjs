// Без сети: запуск показывает «Не удалось загрузить данные» с «Повторить» (не пустой экран и не вечную загрузку),
// сеть вернулась — «Повторить» загружает каталог; сеть пропала по ходу — экран аниме показывает ошибку, приложение живо
import { ensureDevice, install, launch, js, until, check, done, REAL, tap, sleep, screenshot, sh, pageErrors } from './_device.mjs';

const net = (on) => { sh(`svc wifi ${on ? 'enable' : 'disable'}`); sh(`svc data ${on ? 'enable' : 'disable'}`); };
const online = async () => { for (let i = 0; i < 30; i++) { if (/1 received|bytes from/.test(sh('ping -c 1 -W 1 8.8.8.8 2>&1 || true'))) return true; await sleep(1000); } return false; };
const errorShown = `[...document.querySelectorAll('#viewport .screen:last-child .empty')].some((e) => /Не удалось загрузить/.test(e.textContent) && e.getClientRects().length)`;

await ensureDevice();
install();
try {
  net(false);
  await sleep(1500);
  const t0 = Date.now();
  await launch({ fresh: true });
  const err = await until(errorShown, 40000, 500);
  check('без сети — «Не удалось загрузить данные» вместо каталога', !!err, `${Math.round((Date.now() - t0) / 1000)} с`);
  check('…не дольше 10 секунд', Date.now() - t0 < 10000, `${Math.round((Date.now() - t0) / 1000)} с`);
  check('…с кнопкой «Повторить»', await js(`[...document.querySelectorAll('#viewport .screen:last-child .empty .btn')].some((b) => /Повторить/.test(b.textContent))`));
  screenshot('offline-home');
  // без сети запросы не ждут таймаутов (сеть, пропадая, бывает «висит» — тогда экран полминуты стоял скелетоном)
  const fast = await js(`(async () => { const t = performance.now(); const r = await fetch('/api/release/1'); const j = await r.json(); return { ms: Math.round(performance.now() - t), status: r.status, error: j.error, onLine: navigator.onLine }; })()`);
  check('без сети запрос сразу отвечает «Нет подключения к интернету»', fast.ms < 1000 && fast.status === 502 && fast.error === 'Нет подключения к интернету', fast);

  net(true);
  check('сеть вернулась', await online());
  await tap('#viewport .screen:last-child .empty .btn', { text: 'Повторить', after: 1000 });
  check('«Повторить» — каталог загрузился', !!(await until(`${REAL('.release-row')} >= 3`, 30000)));

  // Без сети вкладки переключаются; сеть вернулась — вкладка, показанная с ошибкой, при возврате загружается сама
  net(false);
  await sleep(2000);
  await tap('#bottomnav .nav-item[data-tab="discover"]', { after: 1500 });
  check('без сети вкладка «Обзор» открывается (ошибка или заглушка, не зависание)', await js(`document.querySelector('#bottomnav .nav-item.active')?.dataset.tab === 'discover'`) && !!(await until(`${errorShown} || ${REAL('.release-row, .release-card, .card, .tile')} > 0`, 30000, 500)));
  net(true); await online();
  await tap('#bottomnav .nav-item[data-tab="home"]', { after: 1500 });
  check('вернулись на «Главную» — каталог на месте', !!(await until(`${REAL('.release-row')} >= 3`, 20000)));

  // Сеть пропала, пока пользователь листает: страница аниме — ошибка с «Повторить», «Назад» работает
  net(false);
  await sleep(2000);
  await tap('.release-row', { index: 2, after: 1500 });
  const relErr = await until(`${errorShown} || ${REAL('.btn-watch')} > 0`, 40000, 500);
  check('сеть пропала — страница аниме: ошибка или уже загруженное, без зависания', !!relErr);
  screenshot('offline-release');
  net(true);
  await online();
  if (await js(errorShown)) {
    await tap('#viewport .screen:last-child .empty .btn', { text: 'Повторить', after: 1000 });
    check('сеть вернулась — «Повторить» открывает аниме', !!(await until(`${REAL('.btn-watch')} > 0`, 30000)));
  }
} finally {
  net(true);
}
await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('offline');
