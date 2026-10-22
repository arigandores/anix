// Шапка прячется при прокрутке вниз и возвращается при прокрутке вверх (телефон, как в Anixart — scroll|enterAlways):
// уезжает только .appbar, прилипшее под ней (вкладки, чипы, поле комментария — top: --stick-top) поднимается на её место
// (android.css .bar-hidden). У верха экрана шапка видна
// всегда; прыжки прокрутки (возврат на экран, «наверх», своя прокрутка вкладки — viewport.__jump, ui.js tabs) — не жест,
// шапку не трогают
// Движение — одно на шапку и прилипшее (FLIP: были здесь → встали на новое место → едут оттуда), и только transform.
// Переход top у прилипшего считался на основном потоке, а сдвиг шапки — на компоновщике: при прокрутке полоса вкладок
// отставала на кадр-другой, и между ней и шапкой мелькала щель, в которой просвечивал постер
const MOVING = '.appbar, .tabbar:not(.static), .comment-input.top.sticky, .settings-nav, .wchips';
const MOVE = { duration: 200, easing: 'cubic-bezier(.4, 0, .2, 1)', composite: 'add', id: 'bar-move' }; // --ease-std

export function hideBarOnScroll(viewport) {
  let last = 0; let hidden = false;
  const set = (on, animate = true) => {
    if (on === hidden) return;
    hidden = on;
    const els = animate && !document.documentElement.classList.contains('economy')
      ? [...viewport.querySelectorAll(MOVING)].filter((e) => e.getClientRects().length) : [];
    const was = els.map((e) => e.getBoundingClientRect().top); // с текущим сдвигом (движение могло не доехать)
    for (const e of els) for (const a of e.getAnimations()) if (a.id === MOVE.id) a.cancel();
    document.documentElement.classList.toggle('bar-hidden', on);
    els.forEach((e, i) => {
      const dy = was[i] - e.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) e.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], MOVE);
    });
  };
  viewport.addEventListener('scroll', () => {
    const y = viewport.scrollTop; const d = y - last; last = y;
    if (viewport.__jump) { viewport.__jump = false; return; }
    if (y < 80) set(false);
    else if (Math.abs(d) > 300) { /* прыжок */ }
    else if (d > 4) set(true);
    else if (d < -4) set(false);
  }, { passive: true });
  // новый экран — с шапкой, сразу (router.js render)
  return () => { last = viewport.scrollTop; set(false, false); };
}
