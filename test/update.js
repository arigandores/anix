require('./_failfast');
// Автообновление (electron/updater.js + public/js/update.js) против своего сервера обновлений вместо GitHub:
// latest.yml, «установщик» (случайные байты с настоящим sha512) и release.json с текстом релиза.
// Окно при запуске и «Что нового» без «Как установить», тост после обновления, «Пропустить эту версию»,
// окно ждёт закрытия плеера (веб-плеер во весь экран, мини-плеер), «Проверить обновления» в настройках, скачивание
// с прогрессом (Esc не прерывает) и установка, битый файл → «Повторить», обрыв связи → «Скачать вручную», «Отмена»
// посреди скачивания, сервер обновлений недоступен, версия для браузера. Установка подменена: приложение не закрывается.
// Запуск: npx electron test/update.js
'use strict';
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { start } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails++; };
async function until(fn, max, step = 100) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v || Date.now() - t0 > max) return v; await sleep(step); }
}

const NOTES = [
  '**Anix Desktop 9.0** — тестовый выпуск: обновление прямо из приложения.',
  '',
  '> Anix Desktop — независимый проект, не связанный с разработчиками Anixart.',
  '',
  '**Как установить**',
  'Скачайте `AnixDesktop-Setup-9.0.0.exe` — установщик.',
  '',
  'Файл не подписан, поэтому SmartScreen может предупредить при запуске.',
  '',
  '**Что нового в 9.0**',
  '- **Автообновление.** Приложение само предлагает новую версию.',
  '- **Что нового.** Описание версии видно до обновления.',
  '- **Прочее.** Мелкие исправления.',
  '',
  '**AI-помощник** работает с аккаунтом Claude.',
  '',
  '**Версия для браузера** — архив «Source code» ниже.',
].join('\r\n');

// версии на сервере: байты «установщика» и их sha512 для latest.yml; corrupt — отдаётся с испорченным байтом,
// dropAfter — связь рвётся после стольких байт; chunkMs — скорость отдачи
const releases = new Map();
let serving = null; // какую версию отдаёт latest.yml
let feedDown = false; // сервер обновлений недоступен: соединение сбрасывается
let latestHits = 0;
let notesBody = null; // текст релиза; null — NOTES
function addRelease(version, { size = 3 << 20, chunkMs = 25, corrupt = false, dropAfter = 0 } = {}) {
  const bytes = crypto.randomBytes(size);
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  releases.set(version, { bytes, sha512, chunkMs, corrupt, dropAfter });
}
const file = (v) => `AnixDesktop-Setup-${v}.exe`;
const feed = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (feedDown) { req.socket.destroy(); return; }
  if (url === '/latest.yml') {
    latestHits++;
    const r = releases.get(serving);
    res.setHeader('Content-Type', 'text/yaml');
    res.end(`version: ${serving}\nfiles:\n  - url: ${file(serving)}\n    sha512: ${r.sha512}\n    size: ${r.bytes.length}\npath: ${file(serving)}\nsha512: ${r.sha512}\nreleaseDate: '2026-10-17T00:00:00.000Z'\n`);
    return;
  }
  if (url === '/release.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ body: notesBody ?? NOTES })); return; }
  const v = [...releases.keys()].find((x) => url === `/${file(x)}`);
  if (!v) { res.statusCode = 404; res.end(); return; } // .blockmap прежней версии нет — electron-updater качает файл целиком
  const r = releases.get(v);
  let bytes = r.bytes;
  if (r.corrupt) { bytes = Buffer.from(bytes); bytes[bytes.length >> 1] ^= 0xff; }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
  let at = 0;
  const pump = () => {
    if (res.destroyed) return;
    if (r.dropAfter && at >= r.dropAfter) { req.socket.destroy(); return; }
    if (at >= bytes.length) { res.end(); return; }
    res.write(bytes.subarray(at, at += 64 << 10));
    setTimeout(pump, r.chunkMs);
  };
  pump();
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  await new Promise((ok) => feed.listen(0, '127.0.0.1', ok));
  const FEED = `http://127.0.0.1:${feed.address().port}/`;
  process.env.ANIX_UPDATE_FEED = FEED;
  // настройки обновления «как в установленном приложении» (app-update.yml): свой кэш, чтобы не задеть настоящий
  const cacheName = `anix-update-test-${process.pid}`;
  const cacheDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), cacheName);
  process.on('exit', () => fs.rmSync(cacheDir, { recursive: true, force: true })); // и при FAIL (app.exit из _failfast)
  const yml = path.join(app.getPath('userData'), 'app-update-test.yml');
  fs.mkdirSync(path.dirname(yml), { recursive: true });
  fs.writeFileSync(yml, `provider: generic\nurl: ${FEED}\nupdaterCacheDirName: ${cacheName}\n`);
  const updater = require('../electron/updater');
  require('electron-updater').autoUpdater.updateConfigPath = yml;
  let installs = 0;
  updater.quitAndInstall = () => { installs++; };
  updater.register(ipcMain);

  const current = app.getVersion();
  const major = Number(current.split('.')[0]);
  const V1 = `${major + 1}.0.0`; const V2 = `${major + 1}.1.0`; const V3 = `${major + 1}.2.0`; const V4 = `${major + 1}.3.0`;
  addRelease(V1); addRelease(V2, { corrupt: true }); addRelease(V3, { chunkMs: 150 }); addRelease(V4, { dropAfter: 1 << 20 }); addRelease(current);
  serving = V1;

  const srv = await start(0);
  const win = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(__dirname, '..', 'electron', 'preload.js') } });
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  win.webContents.on('did-finish-load', () => win.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }'));
  const opened = []; // «Скачать вручную» — ссылка уходит в системный браузер (в приложении это делает main.js)
  win.webContents.setWindowOpenHandler(({ url }) => { opened.push(url); return { action: 'deny' }; });
  const js = (c) => win.webContents.executeJavaScript(c, true).catch((e) => { throw new Error(`${e.message} — в ${c.slice(0, 160)}`); });
  const reload = (before = '') => new Promise((ok) => {
    win.webContents.once('did-finish-load', async () => { if (before) await js(before); ok(); });
    win.webContents.reload();
  });
  const shotDir = path.join(__dirname, 'shots'); fs.mkdirSync(shotDir, { recursive: true });
  const shot = async (name) => fs.writeFileSync(path.join(shotDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const dlg = () => js(`(() => { const d = document.querySelector('.update-dialog'); return d && !d.closest('.closing') ? { title: d.querySelector('.dialog-title')?.textContent, text: d.innerText, li: d.querySelectorAll('.update-notes li').length, buttons: [...d.querySelectorAll('button')].map((b) => b.textContent) } : null; })()`);
  const press = (label) => js(`(() => { const b = [...document.querySelectorAll('.update-dialog button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  const checked = () => js(`import('/js/update.js').then((m) => !!m.lastCheck())`); // проверка при запуске закончилась
  const pref = (k) => js(`JSON.parse(localStorage.getItem('anixart.pref.${k}'))`);
  const ready = `for (let i = 0; i < 100 && !document.querySelector('#viewport .screen'); i++) await new Promise((ok) => setTimeout(ok, 50));`;
  const settingsItem = (title, w = win) => w.webContents.executeJavaScript(`import('/js/router.js').then(async (r) => {
    document.querySelectorAll('.backdrop').forEach((b) => b.remove());
    ${ready} // сразу после перезагрузки роутер ещё не готов (строки грузятся) — ждём первый экран
    if (document.querySelector('#viewport .screen:last-child')?.dataset.screen !== 'settings') r.navigate('settings', {});
    for (let i = 0; i < 50; i++) {
      const el = [...document.querySelectorAll('#viewport .screen:last-child .menu-item')].find((e) => e.querySelector('.grow > div')?.textContent === ${JSON.stringify(title)});
      if (el) { el.click(); return true; }
      await new Promise((ok) => setTimeout(ok, 100));
    }
    return false;
  })`, true);
  const sub = (title) => js(`[...document.querySelectorAll('#viewport .screen:last-child .menu-item')].find((e) => e.querySelector('.grow > div')?.textContent === ${JSON.stringify(title)})?.querySelector('.sub')?.textContent || ''`);
  // скачивание идёт и дошло до p% (по подписи под полосой)
  const pct = async () => Number((/^(\d+)%/.exec(await js(`document.querySelector('.update-dialog .bench-label')?.textContent || ''`)) || [])[1] || 0);

  await win.loadURL(srv.url);
  await reload(`localStorage.clear(); localStorage.setItem('anixart.pref.APP_VERSION', '"0.9.0"')`);

  // 1. Первый запуск после обновления — тост; затем окно о новой версии с «Что нового»
  const toastText = await until(() => js(`document.getElementById('toast')?.classList.contains('show') && document.getElementById('toast').textContent`), 4000);
  check('тост «обновлён до» после смены версии', /обновлён до \d/.test(toastText || ''), toastText);
  const appVersion = require('../package.json').version;
  check('запомнена текущая версия', (await pref('APP_VERSION')) === appVersion);
  let d = await until(dlg, 8000);
  check('при запуске — окно «Вышла новая версия»', d?.title === 'Вышла новая версия' && d.text.includes(`Anix Desktop ${V1}`), JSON.stringify(d?.title));
  check('«Что нового»: первая строка и три пункта', d?.li === 3 && d.text.includes('тестовый выпуск'), `li=${d?.li}`);
  check('без «Как установить», SmartScreen и версии для браузера', d && !/Как установить|SmartScreen|Версия для браузера|AI-помощник|независимый проект/.test(d.text));
  check('кнопки «Позже» / «Обновить» и «Пропустить эту версию»', d && d.buttons.join('|') === 'Позже|Обновить' && d.text.includes('Пропустить эту версию'), d?.buttons.join('|'));
  await shot('update-offer');

  // 2. «Пропустить эту версию» → при следующем запуске окна нет; тоста о версии второй раз нет
  await js(`document.querySelector('.update-skip input').click()`);
  await press('Позже');
  check('«Пропустить» запомнил версию', (await pref('UPDATE_SKIP_VERSION')) === V1);
  await reload();
  await until(checked, 8000); await sleep(1200);
  check('пропущенная версия при запуске не предлагается', !(await dlg()));
  check('тост «обновлён до» — только один раз', !(await js(`document.getElementById('toast')?.classList.contains('show') && /обновлён/.test(document.getElementById('toast').textContent)`)));

  // 3. Веб-плеер во весь экран, потом не во весь экран — окно ждёт, пока плеер закроют
  await reload(`localStorage.removeItem('anixart.pref.UPDATE_SKIP_VERSION')`);
  await js(`import('/js/player.js').then(({ openWebPlayer }) => openWebPlayer({ url: 'about:blank', iframe: false, name: 'тест' }, { title_ru: 'Тест' })).then(() => 1)`);
  const fsBtn = `document.querySelector('.player-overlay .player-top button[title^="Во весь экран"]')`;
  await js(`${fsBtn}.click(); 1`);
  check('веб-плеер во весь экран', await until(() => js(`!!document.fullscreenElement`), 3000));
  await until(checked, 8000); await sleep(1500);
  check('поверх полноэкранного плеера окна нет', !(await dlg()) && !(await js(`!!document.querySelector('.backdrop')`)));
  await js(`${fsBtn}.click(); 1`);
  await until(() => js(`!document.fullscreenElement`), 3000); await sleep(1500);
  check('вышли из полноэкранного, плеер открыт — окна нет', !(await dlg()));
  await js(`document.querySelector('.player-overlay .player-top button[title="Назад"]').click(); 1`);
  d = await until(dlg, 3000);
  check('плеер закрыли — окно открылось', !!d);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await until(async () => !(await dlg()), 2000);
  check('закрыли без галочки — версия не пропущена', (await pref('UPDATE_SKIP_VERSION')) == null);

  // 3б. Встроенный плеер свёрнут в мини-плеер — серия идёт, окно тоже ждёт
  await reload();
  await js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/20592/365/412?sort=1')).json();
    window.__p = openBuiltinPlayer({ release: { id: 20592, title_ru: 'Братья' }, episodes: r.episodes, index: 0, sort: 1, typeId: 365, dub: 'AniLiberty', startAt: 0 });
    document.querySelector('.player-overlay').mini(true);
    return 1;
  })()`);
  check('мини-плеер открыт', await js(`!!document.querySelector('.player-overlay.mini')`));
  await until(checked, 8000); await sleep(1500);
  check('при мини-плеере окна нет', !(await dlg()));
  await js(`window.__p.close(); 1`);
  d = await until(dlg, 3000);
  check('мини-плеер закрыли — окно открылось', !!d);

  // 4. Настройки → «Проверить обновления» предлагает и пропущенную; «Обновить» — прогресс, Esc не прерывает, установка
  await js(`localStorage.setItem('anixart.pref.UPDATE_SKIP_VERSION', ${JSON.stringify(JSON.stringify(V1))})`);
  check('в настройках есть «Проверить обновления»', await settingsItem('Проверить обновления'));
  d = await until(dlg, 5000);
  check('проверка из настроек предлагает пропущенную версию', d?.text.includes(V1));
  await press('Обновить');
  let maxPct = 0; let midShot = false;
  const progress = await until(async () => {
    const p = await pct();
    maxPct = Math.max(maxPct, p);
    if (p > 20 && !midShot) {
      midShot = true;
      await shot('update-progress');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('.update-dialog').closest('.backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    }
    return installs > 0 && js(`document.querySelector('.update-dialog .bench-label')?.textContent`);
  }, 15000);
  check('прогресс скачивания с процентами и МБ', maxPct > 20 && midShot, `max ${maxPct}%`);
  check('скачано и запущена установка', installs === 1 && /Устанавливаем/.test(progress || ''), `installs=${installs} «${progress}»`);
  check('Esc и клик мимо окна во время скачивания его не закрыли', !!(await dlg()));
  const pending = path.join(cacheDir, 'pending', file(V1));
  check('файл обновления на месте и целый', fs.existsSync(pending) && fs.statSync(pending).size === releases.get(V1).bytes.length);

  // 5. Файл скачался битым — понятная ошибка; «Повторить», когда файл в порядке, — установка
  serving = V2;
  await reload();
  await settingsItem('Проверить обновления');
  await until(dlg, 5000);
  await press('Обновить');
  d = await until(async () => { const x = await dlg(); return x && x.buttons.includes('Повторить') && x; }, 15000);
  check('битый файл — понятное сообщение и «Повторить» / «Скачать вручную»', !!d && d.buttons.join('|') === 'Скачать вручную|Закрыть|Повторить'
    && d.text.includes('скачался с ошибкой') && !/sha512/.test(d.text), d?.buttons.join('|'));
  check('битый файл не устанавливается', installs === 1);
  await shot('update-error');
  releases.get(V2).corrupt = false;
  await press('Повторить');
  await until(() => installs === 2, 15000);
  check('«Повторить» — скачано заново и установка', installs === 2);
  check('после «Повторить» — целый файл', fs.existsSync(path.join(cacheDir, 'pending', file(V2))));

  // 6. Связь оборвалась посреди скачивания — «нет связи», «Скачать вручную» открывает страницу релиза
  serving = V4;
  await reload();
  await settingsItem('Проверить обновления');
  await until(dlg, 5000);
  await press('Обновить');
  d = await until(async () => { const x = await dlg(); return x && x.buttons.includes('Повторить') && x; }, 20000);
  check('обрыв связи — «нет связи с GitHub»', !!d && /нет связи/.test(d.text), d?.text.replace(/\s+/g, ' ').slice(0, 140));
  check('обрыв связи — установки нет', installs === 2);
  await press('Скачать вручную');
  check('«Скачать вручную» — страница релиза в браузере, окно закрылось', opened.includes('https://github.com/arigandores/anix-desktop/releases/latest') && await until(async () => !(await dlg()), 2000), opened.join(' '));

  // 7. «Отмена» посреди скачивания
  serving = V3;
  await reload();
  await settingsItem('Проверить обновления');
  await until(dlg, 5000);
  await press('Обновить');
  await until(async () => (await pct()) > 0, 8000);
  await press('Отмена');
  const gone = await until(async () => !(await dlg()), 4000);
  const t7 = await js(`document.getElementById('toast')?.textContent`);
  check('«Отмена» закрывает окно, тост «Обновление отменено»', gone && t7 === 'Обновление отменено', t7);
  check('после отмены установки нет', installs === 2);

  // 8. Установлена последняя версия
  serving = current;
  await reload();
  await settingsItem('Проверить обновления');
  const s8 = await until(async () => { const s = await sub('Проверить обновления'); return /последняя/.test(s) && s; }, 5000);
  check('«Установлена последняя версия»', !!s8 && !(await dlg()), s8);

  // 9. Сервер обновлений недоступен: при запуске — молча; в настройках — «нет связи»
  feedDown = true;
  const hits = latestHits;
  await reload();
  await sleep(2500); // проверка при запуске — через 2 с после загрузки; дальше ждём её неудачи
  await settingsItem('Проверить обновления');
  const s9 = await until(async () => { const s = await sub('Проверить обновления'); return /Не удалось/.test(s) && s; }, 8000);
  check('при запуске без связи — ни окна, ни тоста', !(await dlg()) && !(await js(`document.getElementById('toast')?.classList.contains('show') || false`)));
  check('проверка из настроек без связи — «Не удалось проверить»', !!s9, s9 || await sub('Проверить обновления'));
  check('до сервера ответы не доходили', latestHits === hits);
  feedDown = false;

  // 10. «Что нового» в настройках — текст релиза установленной версии
  check('в настройках есть «Что нового»', await settingsItem('Что нового'));
  d = await until(dlg, 5000);
  check('«Что нового в <версия>» со списком', d?.title === `Что нового в ${appVersion}` && d.li === 3, d?.title);
  await shot('update-whatsnew');
  check('без ошибок в консоли', !errors.length, errors.slice(0, 3).join(' | '));

  // 11. Огромный текст релиза (у GitHub предел — 125 000 знаков): окно в пределах экрана, кнопки видны без прокрутки
  // окна, листается только список; длинное слово и ссылка без пробелов не раздвигают окно. Большое и маленькое окно,
  // с разделом «Что нового» и без него (тогда показывается весь текст)
  const word = 'Очень'.repeat(120); const link = `https://github.com/arigandores/anix-desktop/compare/v1.5.0...v9.1.0?${'x'.repeat(400)}`;
  const item = (i) => `- **Пункт ${i}.** ${'Длинное описание изменения с подробностями, чтобы строка переносилась несколько раз. '.repeat(3)}`;
  const HUGE = ['**Anix Desktop 9.1** — огромный выпуск.', '', '**Что нового в 9.1**', `- ${word}`, `- [ссылка](${link})`,
    ...Array.from({ length: 450 }, (_, i) => item(i + 1)), '', '**Версия для браузера** — архив ниже.'].join('\n').slice(0, 125000);
  const NOHEAD = Array.from({ length: 300 }, (_, i) => i % 10 ? `Абзац ${i}: ${'обычный текст релиза без раздела «Что нового». '.repeat(4)}` : `## Раздел ${i}\n> цитата ${word}`).join('\n\n').slice(0, 125000);
  const geometry = `(() => {
    const d = document.querySelector('.update-dialog'); const r = d.getBoundingClientRect(); const n = d.querySelector('.update-notes');
    const bs = [...d.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
    return { inView: r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
      buttons: bs.length > 0 && bs.every((b) => b.width > 0 && b.top >= r.top - 1 && b.bottom <= r.bottom + 1),
      dialogScroll: d.scrollHeight - d.clientHeight, notesScroll: n ? n.scrollHeight > n.clientHeight + 10 : false,
      wide: n ? n.scrollWidth - n.clientWidth : -1, page: document.documentElement.scrollWidth - innerWidth,
      skip: !!d.querySelector('.update-skip') && d.querySelector('.update-skip').getBoundingClientRect().bottom <= r.bottom + 1 };
  })()`;
  serving = V1;
  for (const [label, body] of [['с «Что нового»', HUGE], ['без «Что нового»', NOHEAD]]) {
    notesBody = body;
    for (const [w, hgt] of [[1100, 800], [380, 560]]) {
      win.setContentSize(w, hgt);
      await reload();
      const t0 = Date.now();
      await settingsItem('Проверить обновления');
      await until(dlg, 8000);
      const ms = Date.now() - t0;
      const g = await js(geometry);
      check(`огромный текст ${label}, окно ${w}×${hgt}: всё в пределах экрана, кнопки видны, листается только список`,
        g.inView && g.buttons && g.dialogScroll <= 1 && g.notesScroll && g.wide <= 1 && g.page <= 0 && g.skip, `${JSON.stringify(g)} · ${ms} мс`);
      await shot(`update-huge-${label === 'с «Что нового»' ? 'list' : 'text'}-${w}`);
    }
  }
  // «Что нового» из настроек — то же окно без галочки
  notesBody = HUGE; win.setContentSize(380, 560);
  await reload();
  await settingsItem('Что нового');
  await until(dlg, 8000);
  const gw = await js(geometry);
  check('огромный текст в «Что нового», окно 380×560: в пределах экрана, OK виден, листается только список',
    gw.inView && gw.buttons && gw.dialogScroll <= 1 && gw.notesScroll && gw.wide <= 1 && gw.page <= 0, JSON.stringify(gw));
  await shot('update-huge-whatsnew-380');
  notesBody = null; win.setContentSize(1100, 800);

  // 12. Версия для браузера (нет anixartNative): ни проверки, ни пунктов в настройках, ни ошибок
  await win.loadURL('about:blank'); // проверка при запуске в первом окне не попадёт в счёт запросов
  const web = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { offscreen: true } });
  const webErrors = [];
  web.webContents.on('console-message', (e) => { if (e.level === 'error') webErrors.push(e.message); });
  const hitsWeb = latestHits;
  await web.loadURL(srv.url);
  await settingsItem('О приложении', web); // такого пункта нет — ждём, пока экран настроек построится
  const webItems = await web.webContents.executeJavaScript(`[...document.querySelectorAll('#viewport .screen:last-child .menu-item .grow > div:first-child')].map((e) => e.textContent)`);
  await sleep(2500);
  check('браузер: настройки открылись', webItems.includes('Исходный код'), webItems.slice(-4).join(' | '));
  check('браузер: нет «Проверить обновления» и «Что нового»', !webItems.includes('Проверить обновления') && !webItems.includes('Что нового'));
  check('браузер: проверки обновлений нет, ошибок нет', latestHits === hitsWeb && !webErrors.length && !(await web.webContents.executeJavaScript(`!!document.querySelector('.update-dialog')`)), webErrors.slice(0, 2).join(' | '));

  // 13. Докачка с GitHub — по одному диапазону за запрос (хранилище релизов на несколько сразу отвечает 501, и
  // обновление качалось бы целиком). Так делает сам electron-updater — после обновления библиотеки здесь видно,
  // не изменилось ли это. Провайдер GitHub создаётся, но в сеть не ходит.
  const { autoUpdater } = require('electron-updater');
  autoUpdater.setFeedURL({ provider: 'github', owner: 'arigandores', repo: 'anix-desktop' });
  const gh = await autoUpdater.clientPromise;
  check('GitHub: докачка по одному диапазону за запрос', gh.constructor.name === 'GitHubProvider' && gh.isUseMultipleRangeRequest === false, `${gh.constructor.name} multiRange=${gh.isUseMultipleRangeRequest}`);
  check('GitHub: только обычные релизы', autoUpdater.allowPrerelease === false);

  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  srv.server.close(); feed.close();
  app.exit(fails ? 1 : 0);
});
