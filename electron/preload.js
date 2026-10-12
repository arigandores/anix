'use strict';
// Мост для фронтенда: показ рекламы Kodik в отдельном окне
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('anixartNative', {
  showKodikAd: (url) => ipcRenderer.invoke('kodik-ad', url),
  socialAuth: (req) => ipcRenderer.invoke('social-auth', req),
  cancelSocialAuth: () => ipcRenderer.invoke('social-auth-cancel'),
  // Открыть ссылку в системном браузере (вход через Google)
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // «Очистить кэш веб-плееров» (clear_webview_cache): HTTP-кэш и данные сайтов, кроме localStorage приложения
  clearWebCache: () => ipcRenderer.invoke('clear-web-cache'),
});
