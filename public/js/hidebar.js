// Шапка прячется при прокрутке вниз и возвращается при прокрутке вверх (телефон, как в Anixart — scroll|enterAlways):
// уезжает только .appbar, прилипшее под ней (вкладки, чипы, поле комментария — top: --stick-top) поднимается на её место
// (android.css .bar-hidden). У верха экрана шапка видна
// всегда; прыжки прокрутки (возврат на экран, «наверх») — не жест, шапку не трогают
export function hideBarOnScroll(viewport) {
  let last = 0; let hidden = false;
  const set = (on) => { if (on !== hidden) { hidden = on; document.documentElement.classList.toggle('bar-hidden', on); } };
  viewport.addEventListener('scroll', () => {
    const y = viewport.scrollTop; const d = y - last; last = y;
    if (y < 80) set(false);
    else if (Math.abs(d) > 300) { /* прыжок */ }
    else if (d > 4) set(true);
    else if (d < -4) set(false);
  }, { passive: true });
  // новый экран — с шапкой (router.js render)
  return () => { last = viewport.scrollTop; set(false); };
}
