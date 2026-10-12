'use strict';
// Мост для фронтенда: показ рекламы Kodik в отдельном окне
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('anixartNative', {
  showKodikAd: (url) => ipcRenderer.invoke('kodik-ad', url),
  socialAuth: (req) => ipcRenderer.invoke('social-auth', req),
  // «Очистить кэш веб-плееров» (clear_webview_cache): HTTP-кэш и данные сайтов, кроме localStorage приложения
  clearWebCache: () => ipcRenderer.invoke('clear-web-cache'),
});
