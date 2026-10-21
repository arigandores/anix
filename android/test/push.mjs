// Уведомления Anixart на телефоне (push.js, NotifyJob.kt): при запуске разрешение не спрашивают; первое открытие
// «Уведомлений» — системный запрос, «Разрешить» — фоновая проверка включена, плашки нет; фоновая проверка (скрытый
// WebView) присылает новое — системные уведомления с названием аниме, старое и уже присланное — нет; выключили в
// настройках приложения — плашка «Включить»; выход из аккаунта — проверка выключена.
// Аккаунта нет — вход подделан (токен в localStorage), уведомления сервера — подменены (anix.test.notifyFeed)
import { ensureDevice, install, launch, js, until, check, done, tap, sleep, sh, PKG, topActivity, windowState, screenshot, pageErrors, persist, waitFor } from './_device.mjs';

const PERM = 'android.permission.POST_NOTIFICATIONS';
// наши уведомления (тег — тип:id уведомления сервера); общую группу система добавляет сама
const ours = () => sh('dumpsys notification --noredact').split(/\n(?=\s*NotificationRecord\()/).filter((r) => r.includes(`pkg=${PKG}`) && /tag=[a-zA-Z]+:\d+/.test(r));
const runJob = async () => { sh(`cmd jobscheduler run -f ${PKG} 1`); await sleep(500); };
// системный диалог разрешения: нажать «Разрешить» (кнопка по id, подпись зависит от языка)
async function allow() {
  const dialog = await waitFor(() => /permissioncontroller/.test(topActivity()), 8000, 300);
  if (!dialog) return false;
  sh('uiautomator dump /sdcard/ui.xml >/dev/null');
  const m = /resource-id="com\.android\.permissioncontroller:id\/permission_allow_button"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(sh('cat /sdcard/ui.xml'));
  if (!m) return false;
  sh(`input tap ${(+m[1] + +m[3]) >> 1} ${(+m[2] + +m[4]) >> 1}`);
  await sleep(1200);
  return true;
}

await ensureDevice();
install();
sh(`pm revoke ${PKG} ${PERM} || true`);
sh(`pm clear-permission-flags ${PKG} ${PERM} user-set user-fixed || true`);
sh('cmd notification cancel_all 2>/dev/null || true');
await launch({ fresh: true });
await js(`(localStorage.setItem('anixart.token', 'test-token'), localStorage.setItem('anixart.profile', JSON.stringify({ id: 1, login: 'tester' })), 1)`);
await persist();
await launch();

// При запуске — не спрашиваем, проверка выключена
await sleep(1500);
check('при запуске разрешение на уведомления не спрашивают', !/permissioncontroller/.test(topActivity()), topActivity());
check('разрешения нет — фоновая проверка выключена', !(await windowState()).notifyScheduled);

// Первое открытие «Уведомлений» — системный запрос
await tap('.appbar [title="Уведомления"]', { after: 300 });
const asked = await allow();
check('первое открытие «Уведомлений» — системный запрос разрешения, «Разрешить»', asked, topActivity());
check('разрешили — фоновая проверка включена', !!(await waitFor(async () => (await windowState()).notifyScheduled, 5000, 300)));
check('…точка отсчёта записана, плашки «не приходят» нет', await js(`!!localStorage.getItem('anix.notify.last') && !document.querySelector('.push-off')`));

// Фоновая проверка: новое — уведомлением, с названием аниме; старое (до точки отсчёта) — нет
const now = Math.floor(Date.now() / 1000);
const feed = { content: [
  { id: 11, type: 'episode', is_new: true, timestamp: now + 5, episode: { name: '7 серия', source: { type: { name: 'AniDUB' } }, release: { id: 1, title_ru: 'Тестовое аниме', image: '' } } },
  { id: 12, type: 'friend', is_new: true, timestamp: now + 6, status: 0, by_profile: { id: 2, login: 'friend42' } },
  { id: 10, type: 'episode', is_new: true, timestamp: now - 3600, episode: { name: '6 серия', release: { id: 1, title_ru: 'Старое аниме' } } },
] };
await js(`(localStorage.setItem('anix.test.notifyFeed', ${JSON.stringify(JSON.stringify(feed))}), localStorage.setItem('anix.notify.last', '${now}'), 1)`);
await persist();
sh('input keyevent 3'); // приложение свернули
await runJob();
const got = await waitFor(() => { const r = ours(); return r.length >= 2 ? r : null; }, 30000, 1000);
const text = (got || ours()).join('\n');
check('фоновая проверка — уведомление о серии: аниме и серия с озвучкой', /Тестовое аниме/.test(text) && /7 серия · AniDUB/.test(text), text.slice(0, 300));
check('…и о заявке в друзья', /friend42 хочет добавить вас в друзья/.test(text));
check('старое (до точки отсчёта) — не присылается', !/Старое аниме/.test(text));
await runJob();
await sleep(8000);
check('повторная проверка — без повторов', ours().length === (got || []).length, `${ours().length}`);
screenshot('push-shade');

// Выключили в настройках приложения — плашка «Включить» на экране уведомлений, включили — снова работает
sh(`am start -W -n ${PKG}/.MainActivity`); await sleep(1200);
await launch();
await js(`(localStorage.setItem('anixart.pref.PHONE_NOTIFY', 'false'), 1)`);
await persist();
await launch();
check('выключили в приложении — фоновая проверка выключена', !!(await waitFor(async () => !(await windowState()).notifyScheduled, 5000, 300)));
await tap('.appbar [title="Уведомления"]', { after: 1500 });
check('экран уведомлений — плашка «не приходят» с «Включить»', !!(await until(`/Включить/.test(document.querySelector('.push-off')?.textContent || '')`, 5000)));
screenshot('push-banner');
await tap('.push-off button', { after: 1200 });
check('«Включить» — проверка снова включена, плашки нет', (await windowState()).notifyScheduled && await js(`!document.querySelector('.push-off')`));

// Вышли из аккаунта — проверка выключена
await js(`import('/js/api.js').then(({ auth }) => (auth.clear(), 1))`);
check('выход из аккаунта — фоновая проверка выключена', !!(await waitFor(async () => !(await windowState()).notifyScheduled, 5000, 300)));
sh('cmd notification cancel_all 2>/dev/null || true');
await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('push');
