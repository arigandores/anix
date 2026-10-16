// Прокрутка перетаскиванием мышью, как пальцем в мобильном приложении: зажатая ЛКМ двигает
// вертикальный список экрана или горизонтальные карусели, с инерцией после отпускания.
// Текст при этом не выделяется (см. user-select в app.css); поля ввода работают как обычно.

const H_SCROLLERS = '.hscroll, .banners, .screens, .tabbar.scrollable';
// .sortable — элементы, которые перетаскивают сами (очередь совместного просмотра, party/ui.js)
const IGNORE = 'input, textarea, select, [contenteditable], .player-overlay, .seek, input[type=range], .iv, .sortable';
const THRESHOLD = 6;

function scrollerFor(target, axis) {
  if (axis === 'x') {
    const el = target.closest(H_SCROLLERS);
    if (el && el.scrollWidth > el.clientWidth) return el;
    return null;
  }
  let el = target;
  while (el && el !== document.body) {
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return document.getElementById('viewport');
}

export function initDragScroll() {
  let drag = null;
  let suppressClick = false;

  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target.closest(IGNORE)) return;
    drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, axis: null, el: null, t: performance.now(), vx: 0, vy: 0, id: e.pointerId, target: e.target };
  }, true);

  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.startX; const dy = e.clientY - drag.startY;
    if (!drag.axis) {
      if (Math.abs(dx) < THRESHOLD && Math.abs(dy) < THRESHOLD) return;
      const horizontal = Math.abs(dx) > Math.abs(dy);
      drag.axis = horizontal ? 'x' : 'y';
      drag.el = scrollerFor(drag.target, drag.axis) || (horizontal ? null : document.getElementById('viewport'));
      if (!drag.el) { drag = null; return; }
      drag.el.classList.add('dragging');
      try { drag.el.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }
    const now = performance.now();
    const ddx = e.clientX - drag.x; const ddy = e.clientY - drag.y;
    const dt = Math.max(1, now - drag.t);
    if (drag.axis === 'x') { drag.el.scrollLeft -= ddx; drag.vx = 0.8 * (-ddx / dt) + 0.2 * drag.vx; }
    else { drag.el.scrollTop -= ddy; drag.vy = 0.8 * (-ddy / dt) + 0.2 * drag.vy; }
    drag.x = e.clientX; drag.y = e.clientY; drag.t = now;
    e.preventDefault();
  }, { capture: true, passive: false });

  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    if (!d.axis || !d.el) return;
    suppressClick = true;
    // инерция: затухание скорости; scroll-snap включается обратно по её окончании
    let v = d.axis === 'x' ? d.vx : d.vy;
    if (performance.now() - d.t > 80) v = 0;
    let last = performance.now();
    const step = (now) => {
      const dt = now - last; last = now;
      if (Math.abs(v) < 0.02) { d.el.classList.remove('dragging'); return; }
      if (d.axis === 'x') d.el.scrollLeft += v * dt; else d.el.scrollTop += v * dt;
      v *= Math.pow(0.995, dt);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);

  // после перетаскивания не срабатывает «клик» по карточке под курсором
  window.addEventListener('click', (e) => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }, true);
  window.addEventListener('pointerdown', () => { suppressClick = false; }, true);
  // картинки не перетаскиваются как файлы
  window.addEventListener('dragstart', (e) => { if (e.target.tagName === 'IMG' || e.target.closest('a')) e.preventDefault(); }, true);
}
