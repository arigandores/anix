'use strict';
// Автообновление (electron-updater, GitHub Releases). Окно в приложении (public/js/update.js): при запуске проверка →
// «Вышла новая версия» с «Что нового» → «Обновить»: скачивание с прогрессом → тихая установка поверх и перезапуск.
// Скачивается только с согласия (autoDownload выключен). Для обновления в релизе лежат latest.yml, установщик и
// его .blockmap (их выкладывает .github/workflows/release.yml): по blockmap докачиваются только изменённые части.
// «Что нового» — описание релиза (Markdown) из GitHub API: electron-updater отдаёт его уже в HTML.
// Тесты: ANIX_UPDATE_FEED — свой сервер вместо GitHub (generic: latest.yml, установщик, release.json с полем body).
const { app, net } = require('electron');
const { autoUpdater, CancellationToken } = require('electron-updater');

const REPO = 'arigandores/anix-desktop';
const FEED = process.env.ANIX_UPDATE_FEED || null;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false; // ставим только по «Обновить»
autoUpdater.disableWebInstaller = true;
autoUpdater.allowPrerelease = false; // только обычные релизы, даже у сборки с версией вида 1.5.0-test.1
// (иначе electron-updater у такой сборки ищет на GitHub лишь предварительные выпуски того же канала)
autoUpdater.logger = null;
// Докачка по .blockmap — по одному диапазону за запрос: хранилище файлов релизов GitHub на запрос нескольких
// диапазонов сразу отвечает 501 (провайдер github в electron-updater так и делает сам), так же — с прогрессом.
// Свой сервер (generic) по умолчанию просил бы несколько сразу — для него то же явно.
if (FEED) {
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: FEED, useMultipleRangeRequest: false });
} else {
  const [owner, repo] = REPO.split('/');
  autoUpdater.setFeedURL({ provider: 'github', owner, repo });
}

// Обновления — только у установленного приложения: запуск из исходников (electron .) обновлять нечего
const supported = () => app.isPackaged || !!FEED;

// Текст релиза vX.Y.Z (Markdown); '' — нет или не загрузился
async function notes(version) {
  const url = FEED ? new URL('release.json', FEED.replace(/\/?$/, '/')).href : `https://api.github.com/repos/${REPO}/releases/tags/v${version}`;
  try {
    const r = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    return r.ok ? String((await r.json()).body || '') : '';
  } catch { return ''; }
}

let token = null; // идёт скачивание — его можно отменить

function register(ipcMain) {
  // { supported, current, version?, notes? } — version есть, только если вышла новее
  ipcMain.handle('update-check', async () => {
    const current = app.getVersion();
    if (!supported()) return { supported: false, current };
    const r = await autoUpdater.checkForUpdates();
    if (!r || !r.cancellationToken) return { supported: true, current }; // токен есть, только если версия новее
    const { version } = r.updateInfo;
    return { supported: true, current, version, notes: await notes(version) };
  });
  ipcMain.handle('update-notes', (_e, version) => notes(version || app.getVersion()));
  ipcMain.handle('update-download', async (e) => {
    if (token) token.cancel();
    const my = token = new CancellationToken();
    const onProgress = (p) => { if (!e.sender.isDestroyed()) e.sender.send('update-progress', { percent: p.percent, transferred: p.transferred, total: p.total, speed: p.bytesPerSecond }); };
    autoUpdater.on('download-progress', onProgress);
    try { await autoUpdater.downloadUpdate(my); return { ok: true }; } catch (err) {
      return { ok: false, canceled: my.cancelled, error: String(err && err.message || err) };
    } finally { autoUpdater.removeListener('download-progress', onProgress); if (token === my) token = null; }
  });
  ipcMain.handle('update-cancel', () => { if (token) token.cancel(); return true; });
  // тихая установка (/S --updated) в ту же папку и запуск новой версии (--force-run)
  ipcMain.handle('update-install', () => { setImmediate(() => module.exports.quitAndInstall()); return true; });
}

module.exports = { register, quitAndInstall: () => autoUpdater.quitAndInstall(true, true) };
