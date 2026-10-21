// Редакторы, перенятые у приложения Anixart: создание коллекции (название, релизы поиском, проверки до запроса,
// запрос collectionMy/create с телом как у Anixart), выбор обложки — системный выбор файла, экран редактора не
// обновляется свайпом вниз; настройки профиля (фото — выбор файла, блоклист — «Разблокировать»), подробные настройки
// уведомлений, экспорт закладок — системный «Сохранить как». Аккаунта нет — вход подделан (токен в localStorage),
// запросы к серверу перехвачены, ответы экранов профиля, уведомлений и экспорта — подменены (__mock)
import { ensureDevice, install, launch, js, until, check, skip, done, tap, back, sleep, sh, PKG, topActivity, screenshot, pageErrors, persist, REAL } from './_device.mjs';

const calls = (re) => js(`(window.__calls || []).filter((c) => ${re}.test(c.url))`);
const toastText = () => js(`document.getElementById('toast')?.textContent || ''`);
const typeInto = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);

await ensureDevice();
install();
await launch({ fresh: true });
const apiOk = (await js(`fetch('/api/config/toggles').then((r) => r.status)`)) < 500;
await js(`(localStorage.setItem('anixart.token', 'test-token'), localStorage.setItem('anixart.profile', JSON.stringify({ id: 1, login: 'tester' })), 1)`);
await persist();
await launch();
// запросы страницы к серверу — в __calls (адрес, метод, тело); ответ из __mock[путь] — вместо сервера
await js(`(() => { window.__calls = []; window.__mock = {}; const f = window.fetch; window.fetch = (u, o = {}) => {
  const url = String(u instanceof Request ? u.url : u);
  window.__calls.push({ url, method: (o.method || 'GET').toUpperCase(), body: typeof o.body === 'string' ? o.body : o.body ? '[binary]' : '' });
  const key = Object.keys(window.__mock).find((k) => url.split('?')[0].endsWith('/api/' + k));
  return key ? Promise.resolve(new Response(JSON.stringify(window.__mock[key]), { headers: { 'Content-Type': 'application/json' } })) : f(u, o);
}; return 1; })()`);
const mock = (m) => js(`(Object.assign(window.__mock, ${JSON.stringify(m)}), 1)`);
const pickerUp = () => /documentsui|photopicker|providers\.media|intentresolver/i.test(topActivity());
const toApp = async () => { await back(); await sleep(800); if (!topActivity().startsWith(PKG)) { sh(`am start -W -n ${PKG}/.MainActivity`); await sleep(1000); } };

// Создание коллекции
await js(`import('/js/router.js').then((r) => (r.navigate('collection-editor'), 1))`);
check('редактор коллекции открылся: поля, «Добавить релиз», «Сохранить»', !!(await until(`document.body.dataset.screen === 'collection-editor' && !!document.querySelector('.screen input.input') && [...document.querySelectorAll('.screen button')].some((b) => /Добавить релиз/.test(b.textContent))`, 10000)));
check('свайп вниз на редакторе не обновляет (правки не теряются)', await js(`import('/js/router.js').then((r) => !r.canRefresh())`));
await tap('.appbar [title="Сохранить"]', { after: 500 });
check('короткое название — ошибка до запроса', /названи/i.test(await toastText()) && !(await calls('/collectionMy/')).length, await toastText());
await typeInto('.screen input.input', 'Тестовая коллекция для проверки');
await tap('.appbar [title="Сохранить"]', { after: 500 });
check('без релизов — ошибка до запроса', !(await calls('/collectionMy/')).length && /релиз/i.test(await toastText()), await toastText());

if (apiOk) {
  await tap('.screen button', { text: 'Добавить релиз', after: 900 });
  await typeInto('.backdrop:not(.closing) .searchbar input', 'Наруто');
  const found = await until(`${REAL('.backdrop:not(.closing) .release-row')} > 0`, 20000);
  check('«Добавить релиз» — поиск находит аниме', !!found);
  if (found) {
    await tap('.backdrop:not(.closing) .release-row', { index: 0, after: 500 });
    check('нажатие — отмечено галочкой', await js(`!!document.querySelector('.backdrop:not(.closing) .release-row .ic')`));
    screenshot('editors-pick');
    check('окно поиска: «Готово» видно, не под списком', await js(`(() => { const b = [...document.querySelectorAll('.backdrop:not(.closing) button')].find((x) => /Готово/.test(x.textContent)); const r = b.getBoundingClientRect(); return r.bottom <= innerHeight && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; })()`));
    await tap('.backdrop:not(.closing) button', { text: 'Готово', after: 700 });
    check('в коллекции один релиз', await js(`/^1 из/.test(document.querySelector('.section-head .muted')?.textContent || '')`));
    screenshot('editors-collection');
    await js(`(document.getElementById('toast') && (document.getElementById('toast').textContent = ''), 1)`);
    await tap('.appbar [title="Сохранить"]', { after: 2500 });
    const sent = (await calls('/collectionMy\\/create/'))[0];
    let body = null; try { body = JSON.parse(sent?.body || 'null'); } catch { /* не JSON */ }
    check('«Сохранить» — POST collectionMy/create: название, приватность, id релизов', !!sent && sent.method === 'POST' && body?.title === 'Тестовая коллекция для проверки' && body.is_private === false && Array.isArray(body.releases) && body.releases.length === 1, sent || (await js(`(window.__calls || []).map((c) => c.method + ' ' + c.url.split('?')[0]).slice(-6).join(' | ')`)) + ' / ' + await toastText());
    check('ответ сервера без входа — сообщение, экран редактора на месте', await js(`document.body.dataset.screen === 'collection-editor'`) && !!(await toastText()), await toastText());
  }
} else skip('релизы в коллекции', 'бекенд Anixart не отвечает');

// Обложка — системный выбор файла (WebView без onShowFileChooser его не открывал)
await tap('.screen button', { text: 'Загрузить обложку', after: 2500 });
const picker = topActivity();
check('«Загрузить обложку» — системный выбор файла', /documentsui|photopicker|providers\.media|intentresolver/i.test(picker), picker);
await back(); await sleep(800);
if (!topActivity().startsWith(PKG)) { sh(`am start -W -n ${PKG}/.MainActivity`); await sleep(1000); }
check('отменили выбор — снова редактор', await js(`document.body.dataset.screen === 'collection-editor'`));

await back(); await sleep(600);

// Настройки профиля: фото — системный выбор файла; блоклист — список и «Разблокировать»
await mock({ 'profile/preference/my': { code: 0, avatar: '', status: 'тест', is_stats_hidden: false, privacy_stats: 0, privacy_counts: 0, privacy_social: 0, privacy_friend_requests: 0 },
  'profile/1': { code: 0, profile: { id: 1, login: 'tester', privilege_level: 0 } },
  'profile/blocklist/all/0': { code: 0, content: [{ id: 5, login: 'blocked_user', avatar: '' }], total_count: 1 },
  'profile/blocklist/remove/5': { code: 0 } });
await js(`import('/js/router.js').then((r) => (r.navigate('profile-settings'), 1))`);
check('«Настройки профиля» открылись: фото, никнейм, приватность, блоклист', !!(await until(`(() => { const t = document.querySelector('#viewport .screen')?.textContent || ''; return document.body.dataset.screen === 'profile-settings' && /Изменить фото профиля/.test(t) && /Изменить никнейм/.test(t) && /Блоклист/.test(t); })()`, 10000)));
screenshot('editors-profile');
await tap('.screen .menu-item', { text: 'Изменить фото профиля', after: 700 });
await tap('.backdrop:not(.closing) .sheet-item, .backdrop:not(.closing) button', { text: 'Загрузить с устройства', after: 2500 });
check('фото профиля — системный выбор файла', pickerUp(), topActivity());
await toApp();
await tap('.screen .menu-item', { text: 'Блоклист', after: 1500 });
check('блоклист — заблокированный пользователь в списке', !!(await until(`/blocked_user/.test(document.querySelector('#viewport .screen')?.textContent || '')`, 8000)));
const unblock = await js(`(() => { const b = [...document.querySelectorAll('#viewport .screen button')].find((x) => /Разблок/i.test(x.textContent + (x.title || ''))); b?.click(); return !!b; })()`);
await sleep(800);
if (await js(`!!document.querySelector('.backdrop:not(.closing)')`)) await tap('.backdrop:not(.closing) .dialog-actions button', { index: 1, after: 800 });
check('«Разблокировать» — запрос profile/blocklist/remove/5', unblock && (await calls('/blocklist.remove.5/')).length === 1);
await back(); await back(); await sleep(600);

// Подробные настройки уведомлений: режим «из выбранных списков» — выбор списков; от озвучек; по релизам
await mock({ 'profile/preference/notification/my': { code: 0, is_episode_notifications_enabled: true, is_first_episode_notification_enabled: false, profile_status_notification_preferences: [0, 1], profile_type_notification_preferences: [], is_selected_releases_notifications_enabled: false },
  'type/all': { code: 0, types: [{ id: 1, name: 'AniDUB' }, { id: 2, name: 'AniLibria' }] } });
await js(`import('/js/router.js').then((r) => (r.navigate('notification-settings'), 1))`);
check('настройки уведомлений: «о новых сериях», «из списков», «от озвучек», «по релизам»', !!(await until(`(() => { const t = document.querySelector('#viewport .screen')?.textContent || ''; return /новых серия/i.test(t) && /списк/i.test(t) && /озвуч/i.test(t) && /релиз/i.test(t); })()`, 10000)), await js(`(document.querySelector('#viewport .screen')?.textContent || '').slice(0, 200)`));
screenshot('editors-notif-settings');
await back(); await sleep(600);

// Экспорт закладок: настройки → Дополнительно → «Экспорт закладок» → «Экспортировать» → системный «Сохранить как»
await mock({ 'export/bookmarks': { code: 0, releases: [{ id: 1, title_ru: 'Тестовое аниме', title_original: 'Test', year: '2020', profile_list_status: 1 }] } });
await tap('[title="Настройки"]', { after: 900 });
await tap('.settings-tab[data-section="advanced"]', { after: 500 });
await tap('.settings-body .menu-item', { text: 'Экспорт закладок', after: 900 });
await tap('.backdrop:not(.closing) label, .backdrop:not(.closing) .sheet-item', { text: 'Смотрю', after: 400 });
await tap('.backdrop:not(.closing) .dialog-actions button', { text: 'Экспортировать', after: 3000 });
check('экспорт закладок — запрос export/bookmarks и системный «Сохранить как»', (await calls('/export.bookmarks/')).length >= 1 && /documentsui/i.test(topActivity()), topActivity());
screenshot('editors-export');
await toApp();

await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('editors');
