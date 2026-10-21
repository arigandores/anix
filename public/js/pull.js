// Обновление свайпом вниз (телефон), как в приложении Anixart: экран прокручен до верха — тянешь пальцем вниз,
// из-под шапки выезжает кружок (стрелка крутится по мере натяжения); отпустил дальше порога — экран обновляется
// (router.js refreshCurrent), кружок крутится, пока не готово. Горизонтальный свайп (вкладки), поля ввода, плеер и
// окна — свои, сюда не попадают
import { h, toast } from './ui.js';
import { canRefresh, refreshCurrent } from './router.js';

const PULL_MAX = 110; // кружок дальше не едет
const PULL_GO = 72; // отпустил дальше — обновить
const OWN = 'input, textarea, select, [contenteditable], .player-overlay, .backdrop, .sortable';

export function pullToRefresh(viewport) {
  const ring = h('div', { class: 'ptr-ring' });
  const el = h('div', { class: 'ptr', 'aria-hidden': 'true' }, ring);
  document.body.append(el);
  let start = null; let pull = 0; let busy = false;

  const place = (d, animate) => {
    el.classList.toggle('anim', !!animate);
    el.style.transform = `translate(-50%, ${d - 48}px)`;
    el.style.opacity = String(Math.min(1, d / PULL_GO));
    ring.style.transform = `rotate(${d * 3.2}deg)`;
    ring.classList.toggle('go', d >= PULL_GO);
  };
  // кружок — под шапкой экрана (у каждого экрана своя высота шапки)
  const anchor = () => {
    const bar = viewport.querySelector('.screen .appbar');
    el.style.top = `${(bar || viewport).getBoundingClientRect()[bar ? 'bottom' : 'top']}px`;
  };

  viewport.addEventListener('touchstart', (e) => {
    start = null;
    if (busy || e.touches.length !== 1 || viewport.scrollTop > 0 || e.target.closest(OWN) || !canRefresh()) return;
    start = { x: e.touches[0].clientX, y: e.touches[0].clientY, on: false };
    pull = 0;
  }, { passive: true });

  viewport.addEventListener('touchmove', (e) => {
    if (!start) return;
    const dx = e.touches[0].clientX - start.x; const dy = e.touches[0].clientY - start.y;
    if (!start.on) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // вниз и не вбок, экран всё ещё у верха — наш жест; иначе — прокрутка или свайп вкладок
      if (dy <= 0 || Math.abs(dx) * 1.2 > dy || viewport.scrollTop > 0 || !e.cancelable) { start = null; return; }
      start.on = true; start.y = e.touches[0].clientY;
      anchor();
      el.classList.add('show');
    }
    e.preventDefault(); // не прокрутка и не «резинка» WebView
    pull = Math.min(PULL_MAX, Math.max(0, e.touches[0].clientY - start.y) * 0.55);
    place(pull);
  }, { passive: false });

  const end = async () => {
    if (!start?.on) { start = null; return; }
    start = null;
    if (pull < PULL_GO) { place(0, true); setTimeout(() => { if (!busy) el.classList.remove('show'); }, 220); return; }
    busy = true;
    place(PULL_GO, true);
    ring.classList.add('spin');
    let ok = true;
    try { ok = await refreshCurrent(); } catch { ok = false; }
    if (!ok) toast('Не удалось обновить — проверьте подключение к интернету');
    ring.classList.remove('spin');
    place(0, true);
    setTimeout(() => { el.classList.remove('show'); busy = false; }, 220);
  };
  viewport.addEventListener('touchend', end);
  viewport.addEventListener('touchcancel', end);
}
