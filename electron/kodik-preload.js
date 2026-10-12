'use strict';
// Страница рекламы Kodik ждёт JS-интерфейс "KodikInterface" с методом advertEnded()
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('KodikInterface', {
  advertEnded: () => ipcRenderer.send('kodik-ad-ended'),
});
