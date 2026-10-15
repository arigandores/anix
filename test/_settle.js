'use strict';
// Ожидание «экран загрузился» вместо фиксированных пауз: запросы к API завершились, скелетонов и спиннеров
// в активном экране нет — и так держится quiet мс. max — верхняя граница (прежняя пауза теста).
//   const settle = require('./_settle');  await settle(js, 5000);
// Счётчик запросов ставится в странице один раз (обёртка над fetch); после перезагрузки — заново, сам.
const INSTALL = `(() => {
  if (window.__inflight != null) return;
  window.__inflight = 0;
  const of = window.fetch;
  window.fetch = function (...a) {
    window.__inflight++;
    return of.apply(this, a).finally(() => { window.__inflight--; });
  };
})(); 1`;
const BUSY = `(() => {
  const scr = document.querySelector('#viewport .screen:last-child') || document;
  if (window.__inflight > 0 || scr.querySelector('.sk-root, .sk, .spinner-wrap, .load-reveal')) return true;
  // проявление (картинок, контента) ещё идёт — бесконечные анимации вроде спиннеров не ждём
  if (document.getAnimations().some((a) => a.playState === 'running' && a.effect && a.effect.getTiming().iterations !== Infinity)) return true;
  // картинки грузятся не через fetch: ждём те, что в видимой области (ленивые ниже экрана не начнут грузиться)
  return [...scr.querySelectorAll('img')].some((i) => {
    if (i.complete) return false;
    const r = i.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  });
})()`;

module.exports = async function settle(js, max = 5000, quiet = 300) {
  await js(INSTALL);
  const t0 = Date.now(); let calm = 0;
  while (Date.now() - t0 < max) {
    await new Promise((r) => setTimeout(r, 100));
    if (await js(BUSY)) calm = 0; else if ((calm += 100) >= quiet) return Date.now() - t0;
  }
  return max;
};
module.exports.INSTALL = INSTALL;
