// Обновление приложения: поддельный GitHub на компьютере (через adb reverse) отдаёт версию 99.0.0 с APK. При запуске —
// окно «Вышла новая версия» с «Что нового»; «Обновить» — скачивание с прогрессом и системное окно установки Android;
// отказ — «Обновление не установлено» и «Установить»; согласие — приложение ставится поверх, данные на месте;
// «Пропустить эту версию» — при следующем запуске окна нет
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDevice, install, launch, js, until, check, done, tap, sleep, sh, adb, topActivity, screenshot, persist, PKG, ROOT, waitFor, pageErrors } from './_device.mjs';

const APK = fs.readFileSync(path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'));
let hits = 0;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  // список релизов: последний — только для Windows (без APK) — телефону не обновление; предлагается 99.0.0 с APK.
  // В тексте — разделы платформ: показывается общее и «Android», не «Windows»
  if (u.pathname === '/releases') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { tag_name: 'v99.1.0', body: 'Только для Windows.\nПлатформы: windows', assets: [{ name: 'latest.yml', browser_download_url: 'x' }] },
      { tag_name: 'v99.0.0', body: 'Тестовая версия.\nПлатформы: windows, android\n\n## Что нового\n- Проверка обновления на Android\n- Вторая строка\n\n**Windows**\n- Только про Windows\n\n**Android**\n- Только про Android', assets: [{ name: 'Anix-99.0.0.apk', browser_download_url: `http://127.0.0.1:${PORT_T}/apk` }] },
    ]));
    return;
  }
  if (u.pathname.startsWith('/releases/tags/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ body: '## Что нового\n- текущая' })); return; }
  if (u.pathname === '/apk') {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': APK.length });
    // медленнее, чтобы прогресс было видно (~3 с): кусками по 256 КБ
    let i = 0; const step = () => { if (i >= APK.length) { res.end(); return; } res.write(APK.subarray(i, i + 262144)); i += 262144; setTimeout(step, 150); }; step();
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const PORT_T = srv.address().port;
const FEED = `http://127.0.0.1:${PORT_T}/releases`;
const dialogText = () => js(`document.querySelector('.update-dialog')?.textContent || ''`);
const installerOnTop = () => /packageinstaller|PackageInstaller/i.test(topActivity());
// кнопка системного окна установщика по тексту (uiautomator) — нажать как пальцем. Только узлы установщика:
// uiautomator видит и кнопки страницы в WebView («Установить» в окне приложения)
function tapSystem(re) {
  sh('uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true');
  const xml = sh('cat /sdcard/ui.xml 2>/dev/null || true');
  const node = [...xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?package="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
    .find((m) => re.test(m[1]) && /packageinstaller/.test(m[2]));
  if (!node) return null;
  const [, text, , x1, y1, x2, y2] = node;
  sh(`input tap ${(Number(x1) + Number(x2)) >> 1} ${(Number(y1) + Number(y2)) >> 1}`);
  return text;
}

try {
  await ensureDevice();
  install();
  adb('reverse', `tcp:${PORT_T}`, `tcp:${PORT_T}`);
  await launch({ fresh: true });
  await js(`(localStorage.setItem('anix.test.updateFeed', ${JSON.stringify(FEED)}), localStorage.setItem('anix.test.mark', 'keep'), 1)`);
  await persist();
  await launch();

  check('при запуске — «Вышла новая версия»', !!(await until(`/Вышла новая версия/.test(document.querySelector('.update-dialog')?.textContent || '')`, 20000)));
  const txt = await dialogText();
  check('в окне — версия и «Что нового» из релиза: последний с APK, а не последний (только для Windows)', /Anix 99\.0\.0/.test(txt) && /Проверка обновления на Android/.test(txt) && !/Anix Desktop/.test(txt), txt.slice(0, 160));
  check('«Что нового» — общее и раздел Android, без раздела Windows и строки «Платформы»', /Только про Android/.test(txt) && !/Только про Windows/.test(txt) && !/Платформы/.test(txt), txt.slice(0, 300));
  screenshot('update-offer');

  // «Обновить» → скачивание с прогрессом → системное окно установки → отказ
  await tap('.update-dialog button', { text: 'Обновить', after: 0 });
  // прогресс и текст для Android — одним взглядом, пока идёт скачивание (быстро скачалось — уже «подтвердите…»)
  check('скачивание: прогресс в процентах и МБ, текст для Android', !!(await until(`/\\d+% · [\\d,]+ из [\\d,]+ МБ/.test(document.querySelector('.update-dialog')?.textContent || '') && /Android спросит/.test(document.querySelector('.update-dialog')?.textContent || '')`, 15000, 100)));
  const shown = await waitFor(() => installerOnTop(), 40000, 500);
  check('скачали — системное окно установки Android', !!shown, topActivity());
  screenshot('update-installer');
  sh('input keyevent 4'); // отказ
  await sleep(2500);
  if (!topActivity().startsWith(PKG)) sh(`am start -W -n ${PKG}/.MainActivity`);
  check('отказались — «Обновление не установлено: установку отменили» и «Установить»', !!(await until(`/Обновление не установлено: установку отменили/.test(document.querySelector('.update-dialog')?.textContent || '') && [...document.querySelectorAll('.update-dialog button')].some((b) => b.textContent === 'Установить')`, 15000)), await dialogText());
  check('APK скачан один раз', hits === 1, hits);

  // «Установить» → согласиться: приложение ставится поверх, данные на месте. Разрешение «ставить приложения из этого
  // источника» пользователь включает один раз в настройках (системное окно ведёт туда) — в тесте выдаём заранее
  sh(`appops set ${PKG} REQUEST_INSTALL_PACKAGES allow`);
  await tap('.update-dialog button', { text: 'Установить', after: 300 });
  check('повтор — «Подтвердите обновление», а не прошлая ошибка', /Подтвердите обновление/.test(await dialogText()) && !/установку отменили/.test(await dialogText()), await dialogText());
  await sleep(2200);
  await waitFor(() => installerOnTop(), 20000, 500);
  const updatedAt = () => (/lastUpdateTime=([^\n]+)/.exec(sh(`dumpsys package ${PKG}`)) || [])[1];
  const before = updatedAt();
  const pressed = await waitFor(() => tapSystem(/^(Update|Обновить|Install|Установить)$/i), 15000, 1000);
  check('в системном окне — «Обновить»', !!pressed, pressed);
  await sleep(1500); screenshot('update-after-press');
  const reinstalled = await waitFor(() => updatedAt() !== before, 60000, 1000);
  if (!reinstalled) { screenshot('update-not-installed'); console.log('  сверху:', topActivity()); }
  check('установка прошла (пакет обновлён системой)', !!reinstalled, `${before} → ${updatedAt()}`);
  await sleep(2000);
  await launch();
  check('после обновления данные на месте (localStorage)', await js(`localStorage.getItem('anix.test.mark')`) === 'keep');

  // «Пропустить эту версию» → при следующем запуске окна нет
  check('после обновления окно снова предлагает версию', !!(await until(`!!document.querySelector('.update-dialog')`, 20000)));
  await tap('.update-dialog .update-skip', { after: 300 });
  await tap('.update-dialog button', { text: 'Позже', after: 800 });
  await persist();
  await launch();
  await sleep(6000);
  check('«Пропустить эту версию» — при запуске окна нет', !(await js(`!!document.querySelector('.update-dialog')`)));
  // «Проверить обновления» в настройках предлагает и пропущенную
  await tap('[title="Настройки"]', { after: 900 });
  // под нагрузкой нажатие сразу после запуска бывает раньше, чем экран готов принимать нажатия — ещё раз
  if (!(await until(`!!document.querySelector('.settings-tab')`, 5000))) await tap('[title="Настройки"]', { after: 900 });
  await tap('.settings-tab[data-section="about"]');
  await tap('.settings-body .menu-item', { text: 'Проверить обновления', after: 300 });
  check('«Проверить обновления» — окно с пропущенной версией', !!(await until(`/99\\.0\\.0/.test(document.querySelector('.update-dialog')?.textContent || '')`, 15000)));
  await tap('.update-dialog button', { text: 'Позже', after: 600 });
} finally {
  sh(`appops set ${PKG} REQUEST_INSTALL_PACKAGES default`);
  try { await js(`(localStorage.removeItem('anix.test.updateFeed'), localStorage.removeItem('anix.test.mark'), 1)`); } catch { /* приложение уже закрыто */ }
  srv.close();
  try { adb('reverse', '--remove', `tcp:${PORT_T}`); } catch { /* уже нет */ }
}
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('update');
