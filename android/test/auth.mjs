// Вход: экран входа с клавиатурой, ошибки логина и пароля от бекенда, кнопки соцсетей; вход через ВКонтакте, Telegram
// и Яндекс — в окне приложения (страница провайдера, «Назад» отменяет), Google — в системном браузере с ожиданием в
// приложении. Настоящий вход и выход — если заданы ANIX_TEST_LOGIN и ANIX_TEST_PASSWORD
import { ensureDevice, install, launch, js, until, waitFor, check, skip, done, tap, back, sleep, sh, PKG, topActivity, windowState, screenshot, typeText, pageErrors, devtools } from './_device.mjs';

const pages = async () => (await (await fetch(`${devtools()}/json`)).json()).map((t) => t.url);

await ensureDevice();
install();
await launch({ fresh: true });
if ((await js(`fetch('/api/config/toggles').then((r) => r.status)`)) >= 500) { skip('вход', 'бекенд Anixart не отвечает'); done('auth'); }

await tap('#bottomnav .nav-item[data-tab="profile"]', { after: 900 });
check('профиль без входа — «Войдите в аккаунт»', !!(await until(`/Вы не вошли/.test(document.body.textContent)`, 8000)));
await tap('.center-gate .btn', { after: 1200 });
check('экран входа', !!(await until(`!!document.querySelector('input[autocomplete="current-password"]')`, 8000)));
screenshot('auth-screen');

// Неверные данные — ошибка под полем
await tap('input[autocomplete="username"]', { after: 700 });
await typeText('anix_no_such_user_7731');
await tap('input[autocomplete="current-password"]', { after: 500 });
await typeText('wrongpass123');
const w = await windowState();
check('клавиатура не закрывает поле пароля', w.imeVisible && await js(`(() => { const r = document.activeElement.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; })()`), w);
await back(); // спрятать клавиатуру
await tap('.auth-wrap .btn-primary', { after: 300 });
check('несуществующий профиль — ошибка под полем', !!(await until(`/не найден|неверн|Не удалось войти/i.test(document.querySelector('.auth-wrap').textContent)`, 15000)),
  await js(`document.querySelector('.auth-wrap').textContent.slice(0, 160)`));

// Соцсети: какие кнопки есть
const social = await js(`[...document.querySelectorAll('.auth-wrap button[title^="Войти через"]')].map((b) => b.title.replace('Войти через ', ''))`);
const feats = await js(`fetch('/__features').then((r) => r.json()).then((f) => f.social)`);
const want = Object.entries({ 'Яндекс': feats.yandex, 'ВКонтакте': feats.vk, 'Telegram': feats.telegram, 'Google': feats.google }).filter(([, on]) => on).map(([n]) => n);
check('кнопки соцсетей — все, для которых есть ключи', JSON.stringify(social) === JSON.stringify(want), social);
check('нет подписи «только в Anix Desktop для Windows»', !/для Windows/.test(await js(`document.querySelector('.auth-wrap').textContent`)));

// ВКонтакте, Telegram, Яндекс — окно приложения со страницей провайдера; «Назад» — отмена без ошибки
const HOSTS = { 'ВКонтакте': /id\.vk\.(ru|com)|vk\.com/, Telegram: /oauth\.telegram\.org/, 'Яндекс': /oauth\.yandex\.ru|passport\.yandex/ };
for (const name of social.filter((n) => HOSTS[n])) {
  await tap(`.auth-wrap button[title="Войти через ${name}"]`, { after: 1500 });
  const open = await waitFor(async () => (await windowState()).socialOpen, 8000, 300);
  check(`${name}: окно входа открылось`, !!open);
  const url = await waitFor(async () => (await pages()).find((u) => HOSTS[name].test(u)), 20000, 500);
  check(`${name}: в окне — страница провайдера`, !!url, url || (await pages()).join(' '));
  check(`${name}: в приложении — «Завершите вход в окне…»`, await js(`/Завершите вход/.test(document.body.textContent)`));
  screenshot(`auth-${name === 'ВКонтакте' ? 'vk' : name === 'Яндекс' ? 'yandex' : 'telegram'}`);
  // шапка окна: «Вход через …» и крестик «Закрыть» (SocialAuth.kt); у первого провайдера закрываем крестиком, у
  // остальных — «Назад»
  sh('uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true');
  const xml = sh('cat /sdcard/ui.xml 2>/dev/null || true');
  const close = /content-desc="Закрыть"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
  check(`${name}: в шапке окна — «Вход через ${name}» и крестик «Закрыть»`, !!close && xml.includes(`Вход через ${name}`));
  if (close && name === social.filter((n) => HOSTS[n])[0]) sh(`input tap ${(Number(close[1]) + Number(close[3])) >> 1} ${(Number(close[2]) + Number(close[4])) >> 1}`);
  else await back();
  await sleep(800);
  check(`${name}: ${close && name === social.filter((n) => HOSTS[n])[0] ? 'крестик' : '«Назад»'} закрыл окно, ожидание в приложении снято`, !(await windowState()).socialOpen && !(await js(`/Завершите вход/.test(document.body.textContent)`)));
  check(`${name}: без сообщения об ошибке`, !(await js(`/canceled|ошибк/i.test(document.getElementById('toast')?.textContent || '')`)));
}

// Перехват редиректа: страница провайдера уходит на redirect_uri с кодом (VK, Telegram) или токеном во фрагменте
// (Яндекс) — окно закрывается, приложение меняет код на токен. Код поддельный — обмен отклонён, это видно по сообщению
const inPage = async (match, expr) => {
  const t = (await (await fetch(`${devtools()}/json`)).json()).find((x) => match.test(x.url));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok) => { ws.onopen = ok; });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr } }));
  await sleep(300); ws.close();
};
// куда провайдер вернёт — из запроса, который приложение отдало окну входа (страница провайдера к этому времени
// уже могла уйти на свой адрес без redirect_uri)
const REDIRECT = {
  'ВКонтакте': (r) => `${r.redirectPrefix}?code=FAKE_CODE&state=${r.state}&device_id=DEV1`,
  Telegram: (r) => `${r.redirectPrefix}?code=FAKE_CODE`,
  'Яндекс': (r) => `https://${r.redirectHost}/auth/finish?platform=android#access_token=FAKE_TOKEN&token_type=bearer&state=${r.state}`,
};
await js(`(() => { const orig = anixartNative.socialAuth; anixartNative.socialAuth = (req) => { window.__lastReq = req; return orig(req); }; return 1; })()`);
const EXPECT = { 'ВКонтакте': /VK|ВКонтакте/, Telegram: /Telegram/, 'Яндекс': /Яндекс|yandex/i };
for (const name of social.filter((n) => REDIRECT[n])) {
  await js(`(window.__toasts = [], new MutationObserver(() => { const t = document.getElementById('toast')?.textContent; if (t && __toasts.at(-1) !== t) __toasts.push(t); }).observe(document.body, { childList: true, subtree: true, characterData: true }), 1)`);
  await tap(`.auth-wrap button[title="Войти через ${name}"]`, { after: 1500 });
  const url = await waitFor(async () => (await pages()).find((u) => HOSTS[name].test(u)), 20000, 500);
  if (!url) { check(`${name}: страница провайдера для редиректа`, false); continue; }
  await inPage(HOSTS[name], `location.href = ${JSON.stringify(REDIRECT[name](await js('window.__lastReq')))}`);
  const closed = await waitFor(async () => !(await windowState()).socialOpen, 10000, 300);
  check(`${name}: редирект пойман — окно закрылось само`, !!closed);
  // сообщение именно этого провайдера (тост предыдущего ещё может висеть) или экран регистрации через него
  const said = await until(`(window.__toasts || []).find((t) => ${EXPECT[name]}.test(t)) || (/Почти готово/.test(document.body.textContent) ? 'регистрация через соцсеть' : null)`, 20000);
  check(`${name}: код передан на обмен (поддельный — отклонён)`, !!said && !/canceled/.test(said), said || await js(`(window.__toasts || []).join(' | ')`));
  if (await js(`/Почти готово/.test(document.body.textContent)`)) await back(); // экран регистрации через соцсеть — назад ко входу
  await until(`!!document.querySelector('.auth-wrap button[title^="Войти через"]')`, 5000);
}

// Google — системный браузер, приложение ждёт; «Отмена» снимает ожидание
if (social.includes('Google')) {
  await tap('.auth-wrap button[title="Войти через Google"]', { after: 300 });
  // браузер — по условию, а не через 3 с: под нагрузкой (4 эмулятора) открывался позже
  const top = await waitFor(() => { const a = topActivity(); return a && !a.startsWith(PKG) ? a : null; }, 15000, 500) || topActivity();
  check('Google: вход открылся в браузере', !!top && !top.startsWith(PKG), top.startsWith(PKG) ? `${top}; тосты: ${await js(`(window.__toasts || []).join(' | ')`)}` : top);
  sh(`am start -W -n ${PKG}/.MainActivity`);
  check('Google: приложение ждёт вход из браузера', !!(await until(`/Продолжите вход в открывшемся браузере/.test(document.body.textContent)`, 5000)));
  await tap('.backdrop:not(.closing) button', { text: 'Отмена', after: 900 });
  check('Google: «Отмена» — ожидание снято', !(await js(`/Продолжите вход/.test(document.body.textContent)`)));
}

// Настоящий вход и выход
const L = process.env.ANIX_TEST_LOGIN; const P = process.env.ANIX_TEST_PASSWORD;
if (!L || !P) skip('настоящий вход', 'не заданы ANIX_TEST_LOGIN и ANIX_TEST_PASSWORD');
else {
  await js(`(document.querySelector('input[autocomplete="username"]').value = ${JSON.stringify(L)}, document.querySelector('input[autocomplete="current-password"]').value = ${JSON.stringify(P)}, 1)`);
  await tap('.auth-wrap .btn-primary', { after: 2500 });
  check('вход: открылся профиль', !!(await until(`localStorage.getItem('anixart.token') || Object.keys(localStorage).some((k) => /token/i.test(k) && localStorage.getItem(k))`, 15000)));
  await launch();
  check('вход переживает перезапуск', await js(`Object.keys(localStorage).some((k) => /token/i.test(k) && localStorage.getItem(k))`));
}
await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('auth');
