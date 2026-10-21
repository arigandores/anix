// Шапка окна в приложении для Windows (electron/main.js). Системные кнопки окна стоят:
//  · на обычном экране — в строке шапки экрана (.appbar), на одной линии с её кнопками; за пустое место шапки
//    окно перетаскивают (класс .tb-inline, отдельной полосы нет);
//  · над плеером и просмотром картинки, в узком окне и на экране без шапки — на полосе 32 px сверху (её рисует
//    #titlebar): у плеера свои кнопки справа сверху, в узком окне шапке не хватает ширины, а без шапки не за что тянуть.
// Кнопки — в цвет того, что под ними: фон темы, тёмный фон плеера и просмотра; открыт диалог — темнеют, как экран
// под затемнением. Во весь экран кнопок окна нет — и места под них нет (класс .fs). В браузере шапки нет вовсе.
const nat = window.anixartNative && window.anixartNative.titlebar;

const STRIP_H = 32; // полоса над плеером, просмотром и в узком окне (--tb-h в app.css)
const INLINE_H = 63; // в строке шапки экрана: 64 px без её нижней линии (у .appbar.bordered она видна и под кнопками)
const NARROW = '(max-width: 720px)'; // как в app.css: боковой панели нет
const DIM = 0.45; // затемнение диалога (.backdrop в app.css)
const PLAYER_BG = '#000000';
const VIEWER_BG = '#09090b'; // .iv: rgba(8,8,10,.94) поверх экрана
const SYMBOL = { dark: '#9e9e9e', light: '#616161' }; // значки кнопок окна: --text2 тёмной темы; в светлой — темнее (контраст)

const dim = (c) => `#${[1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * (1 - DIM)).toString(16).padStart(2, '0')).join('')}`;
const narrow = matchMedia(NARROW);

// ширина кнопок окна — из Window Controls Overlay (зависит от системы), иначе три по 46 px
function controlsWidth() {
  const r = navigator.windowControlsOverlay && navigator.windowControlsOverlay.getTitlebarAreaRect();
  const w = r && r.width ? Math.round(innerWidth - r.x - r.width) : 0;
  return w > 40 && w < 400 ? w : 138;
}

let last = '';
function paint() {
  const root = document.documentElement;
  const over = document.querySelector('.iv:not(.closing)') ? VIEWER_BG
    : document.querySelector('.player-overlay:not(.mini):not(.pip)') ? PLAYER_BG : null;
  // у экрана нет шапки («Войдите» на вкладках без входа) — не за что тянуть окно: полоса
  const screen = document.querySelector('#viewport > .screen:last-child');
  const inline = !over && !narrow.matches && !!(screen && screen.querySelector('.appbar'));
  const bg = over || getComputedStyle(root).getPropertyValue('--bg').trim().toLowerCase();
  const symbol = over || root.dataset.theme !== 'light' ? SYMBOL.dark : SYMBOL.light;
  const dialog = !!document.querySelector('.backdrop:not(.closing)');
  root.classList.toggle('tb-over', !!over);
  root.classList.toggle('tb-inline', inline);
  root.classList.toggle('tb-dialog', dialog);
  root.style.setProperty('--tb-bg', bg);
  root.style.setProperty('--wc-w', `${controlsWidth()}px`);
  const o = { color: dialog ? dim(bg) : bg, symbolColor: dialog ? dim(symbol) : symbol, height: inline ? INLINE_H : STRIP_H };
  const key = `${o.color}${o.symbolColor}${o.height}`;
  if (key === last || !/^#[0-9a-f]{6}$/.test(bg)) return;
  last = key;
  nat.setColors(o).catch(() => {});
}

export function initTitlebar() {
  if (!nat) return;
  const root = document.documentElement;
  root.classList.add('tb'); // index.html ставит его до отрисовки; здесь — на случай, если тот скрипт не сработал
  nat.onFullscreen((on) => root.classList.toggle('fs', !!on));
  // плеер, мини-плеер, диалоги и просмотр картинки появляются и меняют вид где угодно в документе
  new MutationObserver(paint).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  narrow.addEventListener('change', paint);
  if (navigator.windowControlsOverlay) navigator.windowControlsOverlay.addEventListener('geometrychange', paint);
  paint();
}
