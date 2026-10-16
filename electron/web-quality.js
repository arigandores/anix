'use strict';
// Веб-плеер: качество по настройке «Приоритет качества», а не то, что задал сайт. Плеер AniLibria (Playerjs) сам
// включает 720p (в странице default_quality:"720p"), хотя есть 1080p. Когда во вложенном окне веб-плеера загрузилась
// страница с Playerjs, переключаем его качество через его API — как встроенный плеер выбирает при запуске серии.
// Только Windows-приложение: в браузере чужие фреймы недоступны. Плеер сайта изменится — просто останется его выбор.
const { webFrameMain } = require('electron');

// В рамке сайта: ждём плеер (до 10 с), выбираем по настройке (0 — максимальное, 1–2 — минимальное, 3–7 — 480p…2160p
// или ближайшее меньшее), переключаем, если надо. Возвращает выбранное качество или null
const pickInFrame = (pref) => `(async (pref) => {
  const h = (q) => parseInt(q, 10) || 0;
  for (let i = 0; i < 40; i++) {
    if (i >= 4 && typeof Playerjs === 'undefined') return null; // не Playerjs (реклама, другой сайт) — не ждём
    const p = typeof player !== 'undefined' && player && typeof player.api === 'function' ? player : null;
    let list = null;
    try { list = p && p.api('qualities'); } catch (e) { return null; }
    if (Array.isArray(list) && list.length > 1) {
      const byH = list.map((q, i) => ({ q, i, h: h(q) })).filter((x) => x.h > 0).sort((a, b) => a.h - b.h);
      if (!byH.length) return null;
      let want;
      if (!pref) want = byH[byH.length - 1];
      else if (pref === 1 || pref === 2) want = byH[0];
      else { const target = [480, 720, 1080, 1440, 2160][Math.min(pref, 7) - 3]; want = byH.filter((x) => x.h <= target).pop() || byH[0]; }
      if (p.api('quality') !== want.q) p.api('quality', want.i);
      return want.q;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
})(${JSON.stringify(pref)})`;

function attachWebQuality(wc, { onPicked } = {}) {
  wc.on('did-frame-finish-load', async (_e, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (!frame || !/^https?:/.test(frame.url)) return;
    try {
      // настройка — из хранилища приложения (главный фрейм окна)
      const raw = await wc.executeJavaScript(`localStorage.getItem('anixart.pref.SELECTED_VIDEO_QUALITY_V2')`);
      const pref = raw == null ? 0 : Number(JSON.parse(raw)) || 0;
      const q = await frame.executeJavaScript(pickInFrame(pref));
      if (q && onPicked) onPicked(q, frame.url);
    } catch { /* фрейм ушёл или не наш плеер — оставляем как есть */ }
  });
}

module.exports = { attachWebQuality };
