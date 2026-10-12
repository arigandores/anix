'use strict';
// Windows-приложение: поднимает локальный сервер (прокси к бекенду Anixart) внутри процесса
// и открывает фронтенд в окне Chromium.
const { app, BrowserWindow, shell, Menu, nativeImage, session, ipcMain } = require('electron');
const path = require('path');
const { start } = require('../server');

let win;
let serverInfo;

// Порт должен быть постоянным: localStorage (вход, настройки, история серий) привязан к origin вместе с портом.
// Запасные порты — на случай, если основной занят чужой программой; 0 — крайний вариант.
const PORTS = [38371, 38372, 38373, 38374, 0];
async function startServer() {
  for (const p of PORTS) {
    try { return await start(p); } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
  }
  throw new Error('no free port');
}

async function createWindow() {
  if (!serverInfo) serverInfo = await startServer();
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'public', 'icon.png'));
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    title: 'Anix Desktop',
    icon,
    backgroundColor: '#121212',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(serverInfo.url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Кнопки «назад/вперёд» мыши → история, F11 → полноэкранный режим, Ctrl+Shift+I → DevTools
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward' && win.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack();
    if (cmd === 'browser-forward' && win.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward();
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.key === 'I' && input.control && input.shift) { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (input.key === 'F5') { win.webContents.reload(); e.preventDefault(); }
  });
  await win.loadURL(serverInfo.url);
}

// clear_webview_cache: HTTP-кэш + cookies/хранилища сторонних сайтов (плееры, реклама); настройки
// и вход приложения (localStorage своего origin) не трогаем. Возвращает размер очищенного кэша в байтах.
ipcMain.handle('clear-web-cache', async () => {
  const ses = session.defaultSession;
  const size = await ses.getCacheSize().catch(() => 0);
  await ses.clearCache();
  await ses.clearStorageData({ storages: ['cookies', 'serviceworkers', 'cachestorage', 'shadercache'] });
  for (const p of [...new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.session))]) if (p !== ses) await p.clearCache();
  return size;
});

// Окно рекламы Kodik: страница рекламы с JS-интерфейсом KodikInterface.advertEnded();
// HTTP 500 на пути с "/ftor" тоже считается окончанием рекламы; после загрузки — синтетический тап по центру.
ipcMain.handle('kodik-ad', (_e, url) => new Promise((resolve) => {
  const ad = new BrowserWindow({
    parent: win, modal: true, width: 960, height: 600, title: 'Реклама', backgroundColor: '#000', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'kodik-preload.js'), autoplayPolicy: 'no-user-gesture-required' },
  });
  let done = false;
  const finish = () => { if (done) return; done = true; ipcMain.removeListener('kodik-ad-ended', onEnded); session.defaultSession.webRequest.onCompleted(null); if (!ad.isDestroyed()) ad.close(); resolve(true); };
  const onEnded = (ev) => { if (ev.sender === ad.webContents) finish(); };
  ipcMain.on('kodik-ad-ended', onEnded);
  ad.webContents.session.webRequest.onCompleted({ urls: ['*://*/*'] }, (d) => { if (d.statusCode === 500 && d.url.includes('/ftor')) finish(); });
  // Автозапуск: как в мобильном приложении (тап по центру + воспроизведение без жеста). Плеер рекламы
  // грузится во фрейме позже окончания загрузки страницы, поэтому пробуем несколько раз:
  // запускаем все <video> во всех фреймах и нажимаем кнопку play, если она есть.
  const AUTOPLAY_JS = `(() => {
    let started = false;
    for (const v of document.querySelectorAll('video')) {
      if (v.paused) { v.play().then(() => {}, () => {}); }
      if (!v.paused || v.currentTime > 0) started = true;
    }
    // плеер Kodik: оверлей .play_button / .play_background; жмём один раз на фрейм
    const btn = document.querySelector('.play_button, .play_background, .vjs-big-play-button, [class*="play-button"], [class*="playButton"]');
    if (btn && !started && !window.__anixPlayClicked) {
      window.__anixPlayClicked = true;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      started = true;
    }
    return started;
  })()`;
  const tapCenter = () => {
    if (ad.isDestroyed()) return;
    const [w, h] = ad.getContentSize();
    ad.webContents.sendInputEvent({ type: 'mouseDown', x: Math.floor(w / 2), y: Math.floor(h / 2), button: 'left', clickCount: 1 });
    ad.webContents.sendInputEvent({ type: 'mouseUp', x: Math.floor(w / 2), y: Math.floor(h / 2), button: 'left', clickCount: 1 });
  };
  let autoplayTimer = null;
  const tryAutoplay = async (attempt = 0) => {
    if (done || ad.isDestroyed()) return;
    let started = false;
    for (const frame of ad.webContents.mainFrame.framesInSubtree) {
      try { if (await frame.executeJavaScript(AUTOPLAY_JS, true)) started = true; } catch { /* фрейм ещё не готов */ }
    }
    if (!started && (attempt === 1 || attempt === 4)) tapCenter();
    if (!started && attempt < 20) autoplayTimer = setTimeout(() => tryAutoplay(attempt + 1), 700);
  };
  ad.webContents.on('did-finish-load', () => {
    ad.webContents.insertCSS('html, body { overflow: hidden !important; }').catch(() => {});
    tapCenter();
    tryAutoplay(0);
  });
  ad.on('closed', () => { clearTimeout(autoplayTimer); finish(); });
  ad.loadURL(url);
}));

// Вход через соцсети: открываем официальную страницу провайдера в модальном окне и ловим redirect_uri
// (обычный способ для встроенных браузеров). Возвращаем перехваченные параметры фронтенду.
// Google блокирует OAuth во встроенных webview по UA с «Electron» — подставляем чистый Chrome
const AUTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

ipcMain.handle('social-auth', (_e, req) => new Promise((resolve) => {
  const authSession = session.fromPartition(`auth-${Date.now()}`); // чистые куки на каждый вход
  authSession.setUserAgent(AUTH_UA);
  const w = new BrowserWindow({
    parent: win, modal: true, width: 520, height: 680, title: 'Вход', backgroundColor: '#fff', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, partition: authSession.partition, nodeIntegration: false },
  });
  w.webContents.setUserAgent(AUTH_UA);
  let done = false;
  const finish = (value) => { if (done) return; done = true; if (!w.isDestroyed()) w.close(); resolve(value); };

  const check = (raw) => {
    if (!raw) return false;
    let u;
    try { u = new URL(raw); } catch { return false; }
    const matchHost = req.redirectHost && u.host === req.redirectHost;
    const matchScheme = req.redirectScheme && u.protocol === `${req.redirectScheme}:`;
    const matchPrefix = req.redirectPrefix && raw.startsWith(req.redirectPrefix);
    if (!matchHost && !matchScheme && !matchPrefix) return false;
    const q = u.searchParams;
    const frag = new URLSearchParams((u.hash || '').replace(/^#/, ''));
    const get = (k) => q.get(k) || frag.get(k);
    if (req.tokenInFragment) {
      const at = get('access_token');
      if (at) { finish({ ok: true, params: { access_token: at } }); return true; }
    }
    if (req.provider === 'google') {
      const idt = get('id_token');
      if (idt) { finish({ ok: true, params: { id_token: idt, requestUri: raw } }); return true; }
    }
    const code = get('code');
    if (code) { finish({ ok: true, params: { code, device_id: get('device_id') || '', state: get('state') || '' } }); return true; }
    if (get('error')) { finish({ ok: false, error: get('error_description') || get('error') }); return true; }
    return false;
  };

  for (const ev of ['will-redirect', 'will-navigate']) {
    w.webContents.on(ev, (e, u) => { if (check(u)) e.preventDefault(); });
  }
  // Кастомная схема (vk<clientId>://) не навигируется — ловим через перехват запросов
  if (req.redirectScheme) {
    authSession.webRequest.onBeforeRequest({ urls: [`${req.redirectScheme}://*/*`, '*://*/blank.html*'] }, (d, cb) => {
      if (check(d.url)) { cb({ cancel: true }); return; }
      cb({});
    });
  }
  w.webContents.on('did-navigate', (_ev, u) => check(u));
  w.on('closed', () => finish({ ok: false, error: 'canceled' }));
  w.loadURL(req.url, { userAgent: AUTH_UA }).catch((err) => finish({ ok: false, error: String(err && err.message || err) }));
}));

// Один экземпляр: второй запуск занял бы запасной порт (другой origin — «пустые» настройки) — вместо этого
// показываем уже открытое окно.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  // Разрешаем полноэкранный режим для плеера (iframe/HTML5 video)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write'].includes(permission)));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
