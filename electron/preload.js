'use strict';
// Мост для фронтенда: вход через соцсети, системный браузер, очистка веб-кэша, обновление, ускорение апскейла (TensorRT)
const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

// Ускорение апскейла: главный процесс один раз на сеанс присылает кольцо общих текстур (electron/trt.js),
// по каждому кадру окно получает номер слота и берёт из текстуры VideoFrame
const textures = new Map(); // `${сеанс}:${слот}` -> SharedTextureImported
let trtOk = false;
try {
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, meta) => {
    const key = `${meta.session}:${meta.slot}`;
    const old = textures.get(key); if (old) old.release();
    textures.set(key, importedSharedTexture);
  });
  trtOk = true;
} catch { /* старый Electron или нет sharedTexture — ускорения не будет */ }
const releaseTextures = () => { for (const t of textures.values()) t.release(); textures.clear(); };

contextBridge.exposeInMainWorld('anixartNative', {
  socialAuth: (req) => ipcRenderer.invoke('social-auth', req),
  cancelSocialAuth: () => ipcRenderer.invoke('social-auth-cancel'),
  // Открыть ссылку в системном браузере (вход через Google)
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // «Очистить кэш веб-плееров» (clear_webview_cache): HTTP-кэш и данные сайтов, кроме localStorage приложения
  clearWebCache: () => ipcRenderer.invoke('clear-web-cache'),
  // Окно приложения — развернуть и вперёд (возврат из «Картинки в картинке»)
  focusWindow: () => ipcRenderer.invoke('focus-window'),
  // Приглашения anixdesktop://watch/<код> (electron/main.js): та, с которой запустили приложение, и новые
  pendingDeepLink: () => ipcRenderer.invoke('deep-link-pending'),
  onDeepLink: (cb) => { ipcRenderer.on('deep-link', (_e, url) => cb(url)); },
  // Обновление приложения (electron/updater.js): проверка, текст релиза, скачивание с прогрессом, установка с перезапуском
  update: {
    check: () => ipcRenderer.invoke('update-check'),
    notes: (version) => ipcRenderer.invoke('update-notes', version),
    download: () => ipcRenderer.invoke('update-download'),
    cancel: () => ipcRenderer.invoke('update-cancel'),
    install: () => ipcRenderer.invoke('update-install'),
    onProgress: (cb) => { const f = (_e, p) => cb(p); ipcRenderer.on('update-progress', f); return () => ipcRenderer.removeListener('update-progress', f); },
  },
  trt: trtOk ? {
    status: () => ipcRenderer.invoke('trt-status'),
    install: () => ipcRenderer.invoke('trt-install'),
    onProgress: (cb) => { const f = (_e, p) => cb(p); ipcRenderer.on('trt-progress', f); return () => ipcRenderer.removeListener('trt-progress', f); },
    open: (o) => { releaseTextures(); return ipcRenderer.invoke('trt-open', o); },
    // кадр видео (VideoFrame) -> слот готов; затем frame(session, slot) — VideoFrame с результатом.
    // Кадр копируется здесь, в родном формате декодера (NV12 — в 2,7 раза меньше RGBA, без перевода на процессоре);
    // цвета в RGB переводит anix-trt по colorSpace кадра. Необычные форматы (10 бит и т. п.) — через RGBA.
    run: async ({ session, slot, frame }) => {
      const native = ['NV12', 'I420', 'RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(frame.format);
      const opts = native ? undefined : { format: 'RGBA', colorSpace: 'srgb' };
      const buf = new Uint8Array(frame.allocationSize(opts));
      const planes = await frame.copyTo(buf, opts);
      const cs = frame.colorSpace || {};
      const r = frame.visibleRect;
      return ipcRenderer.invoke('trt-frame', {
        session, slot, w: r.width, h: r.height, fmt: native ? frame.format : 'RGBA', data: buf,
        o0: planes[0].offset, s0: planes[0].stride, o1: planes[1]?.offset || 0, s1: planes[1]?.stride || 0, o2: planes[2]?.offset || 0, s2: planes[2]?.stride || 0,
        matrix: cs.matrix || 'bt709', full: cs.fullRange ? 1 : 0,
      });
    },
    frame: (session, slot) => { const t = textures.get(`${session}:${slot}`); return t ? t.getVideoFrame() : null; },
    // закрыть свой сеанс (чужой — например, бенчмарка — не трогает); без номера — любой текущий
    close: (session) => {
      for (const [k, t] of textures) if (!session || k.startsWith(`${session}:`)) { t.release(); textures.delete(k); }
      return ipcRenderer.invoke('trt-close', { session });
    },
  } : null,
});
