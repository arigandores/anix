'use strict';
// Windows-приложение: поднимает локальный сервер (прокси к бекенду Anixart) внутри процесса
// и открывает фронтенд в окне Chromium.
const { app, BrowserWindow, shell, Menu, nativeImage, session, ipcMain } = require('electron');
const path = require('path');
const { start } = require('../server');
const trt = require('./trt'); // ускорение апскейла на тензорных ядрах NVIDIA
const { attachWebQuality } = require('./web-quality'); // веб-плеер: качество по «Приоритету качества»
const updater = require('./updater'); // автообновление из GitHub Releases

let win;
let serverInfo;

// Своя шапка окна: системную полосу с названием убираем, кнопки окна — системные (меню раскладок Windows и
// перетаскивание за край остаются), но в цветах приложения. Где и какой высоты кнопки, решает страница
// (js/titlebar.js): в строке шапки экрана или над плеером полосой; она же перекрашивает их под экран.
const TITLEBAR_H = 63; // в строке шапки экрана (64 px) — без её нижней линии
const TITLEBAR_ARG = '--anix-titlebar'; // preload.js: окно со своей шапкой (в тестах и окне входа её нет)
ipcMain.handle('titlebar-colors', (e, { color, symbolColor, height = TITLEBAR_H } = {}) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed() || !/^#[0-9a-f]{6}$/i.test(color) || !/^#[0-9a-f]{6}$/i.test(symbolColor)) return false;
  w.setTitleBarOverlay({ color, symbolColor, height: Math.max(24, Math.min(80, Math.round(height) || TITLEBAR_H)) });
  return true;
});

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
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#121212', symbolColor: '#9e9e9e', height: TITLEBAR_H },
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [TITLEBAR_ARG],
    },
  });
  Menu.setApplicationMenu(null);
  // во весь экран (F11, плеер) кнопок окна нет — полоса под них не нужна
  // (isFullScreen() в момент события ещё прежний — состояние берём из самого события)
  const sendFull = (on) => () => { if (!win.isDestroyed()) win.webContents.send('fullscreen', on); };
  for (const ev of ['enter-full-screen', 'enter-html-full-screen']) win.on(ev, sendFull(true));
  for (const ev of ['leave-full-screen', 'leave-html-full-screen']) win.on(ev, sendFull(false));
  attachWebQuality(win.webContents);
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

// clear_webview_cache: HTTP-кэш + cookies/хранилища сторонних сайтов (веб-плееры); настройки
// и вход приложения (localStorage своего origin) не трогаем. Возвращает размер очищенного кэша в байтах.
ipcMain.handle('clear-web-cache', async () => {
  const ses = session.defaultSession;
  const size = await ses.getCacheSize().catch(() => 0);
  await ses.clearCache();
  await ses.clearStorageData({ storages: ['cookies', 'serviceworkers', 'cachestorage', 'shadercache'] });
  for (const p of [...new Set(BrowserWindow.getAllWindows().map((w) => w.webContents.session))]) if (p !== ses) await p.clearCache();
  return size;
});

// Вход через соцсети: открываем официальную страницу провайдера в модальном окне и ловим redirect_uri
// (обычный способ для встроенных браузеров). Возвращаем перехваченные параметры фронтенду.
// Google во встроенных окнах вход запрещает — он идёт через системный браузер (open-external, social.js).
// UA без «Electron»: с ним провайдеры показывают упрощённые или ошибочные страницы.
const AUTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

trt.register(ipcMain);
updater.register(ipcMain);

// «Назад во вкладку» в окне «Картинка в картинке»: окно приложения — развернуть из панели задач и вперёд
ipcMain.handle('focus-window', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  if (w.isMinimized()) w.restore();
  w.show(); w.focus();
  return true;
});

ipcMain.handle('open-external', (_e, url) => {
  if (!/^https?:\/\//.test(String(url))) return false;
  shell.openExternal(url);
  return true;
});

let cancelAuth = null; // закрыть открытое окно входа («Отмена» в приложении)
ipcMain.handle('social-auth-cancel', () => { if (cancelAuth) cancelAuth(); return true; });

ipcMain.handle('social-auth', (_e, req) => new Promise((resolve) => {
  const authSession = session.fromPartition(`auth-${Date.now()}`); // чистые куки на каждый вход
  authSession.setUserAgent(AUTH_UA);
  const w = new BrowserWindow({
    parent: win, modal: true, width: 520, height: 680, title: 'Вход', backgroundColor: '#fff', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, partition: authSession.partition, nodeIntegration: false },
  });
  w.webContents.setUserAgent(AUTH_UA);
  // Страницы входа (VK ID) вешают beforeunload — Electron тогда молча отменяет закрытие окна. Закрываем всегда.
  w.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  let done = false;
  const finish = (value) => { if (done) return; done = true; cancelAuth = null; if (!w.isDestroyed()) w.destroy(); resolve(value); };
  cancelAuth = () => finish({ ok: false, error: 'canceled' });

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
    const code = get('code');
    if (code) { finish({ ok: true, params: { code, device_id: get('device_id') || '', state: get('state') || '' } }); return true; }
    if (get('error')) { finish({ ok: false, error: get('error_description') || get('error') }); return true; }
    return false;
  };

  // Ссылки на приложения (tg://resolve… — «Open in Telegram») окно Electron само не открывает — отдаём системе;
  // страница провайдера тем временем ждёт подтверждения и потом сама уходит на redirect_uri
  const openApp = (u) => {
    if (!/^tg:/i.test(String(u))) return false;
    shell.openExternal(u).catch(() => {});
    return true;
  };
  w.webContents.setWindowOpenHandler(({ url }) => { if (!openApp(url) && /^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  for (const ev of ['will-redirect', 'will-navigate']) {
    w.webContents.on(ev, (e, u) => { if (openApp(u) || check(u)) e.preventDefault(); });
  }
  // Редирект на кастомную схему (vk<clientId>://) ловят will-redirect/will-navigate выше; фильтр webRequest
  // такую схему не принимает («Wrong scheme type»), поэтому здесь — только запасной перехват blank.html
  if (req.redirectScheme) {
    authSession.webRequest.onBeforeRequest({ urls: ['*://*/blank.html*'] }, (d, cb) => {
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
app.on('second-instance', (_e, argv) => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); } openLink(linkIn(argv)); });

// Приглашение в совместный просмотр: ссылка anixdesktop://watch/<код> открывает приложение (или уже открытое окно)
// и предлагает войти в комнату (party/ui.js). Схему регистрирует установщик (build.protocols в package.json);
// запуск из исходников реестр не трогает.
const PROTOCOL = 'anixdesktop';
if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
const linkIn = (argv) => (argv || []).find((a) => String(a).startsWith(`${PROTOCOL}://`)) || null;
let pendingLink = linkIn(process.argv);
function openLink(url) {
  if (!url) return;
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('deep-link', url);
  else pendingLink = url;
}
ipcMain.handle('deep-link-pending', () => { const u = pendingLink; pendingLink = null; return u; });

app.whenReady().then(() => {
  // Разрешаем полноэкранный режим для плеера (iframe/HTML5 video)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['fullscreen', 'clipboard-sanitized-write'].includes(permission)));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { app.quit(); });
