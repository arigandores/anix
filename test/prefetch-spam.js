'use strict';
// Предзагрузка при наведении не спамит: быстрый проход курсором по списку и прокрутка колесом — 0 запросов,
// остановка курсора на карточке — 1 запрос, повторное наведение на неё же — 0.
// Скрытое окно склеивает sendInputEvent-движения мыши, поэтому курсор эмулируется в странице
// (mousemove/mouseleave по elementFromPoint, :hover — по текущему элементу под «курсором»).
// Запуск: npx electron test/prefetch-spam.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `(() => {
  window.__rel = [];
  const of = window.fetch;
  window.fetch = (u, o) => { if (String(u).includes('/api/release/')) window.__rel.push(String(u)); return of(u, o); };
  let under = null; // элемент под «курсором»
  const om = Element.prototype.matches;
  Element.prototype.matches = function (sel) { return sel === ':hover' ? !!under && this.contains(under) : om.call(this, sel); };
  const card = (el) => el && el.closest('.release-row, .release-card');
  window.__move = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const prev = card(under); const next = card(el);
    if (prev && prev !== next) prev.dispatchEvent(new MouseEvent('mouseleave'));
    under = el;
    el && el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
  };
  window.__wheel = () => window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 }));
})()`;

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await sleep(5000);
  await js(SETUP);
  const count = () => js('window.__rel.length');
  const move = (x, y) => js(`window.__move(${x}, ${y})`);
  const away = () => move(1250, 60); // панель сверху

  // 1. быстрый проход курсором сверху вниз по списку (~1 px/мс)
  await away(); await sleep(300);
  for (let y = 200; y < 820; y += 20) { await move(600, y); await sleep(20); }
  await away(); await sleep(600);
  const sweep = await count();
  // 2. прокрутка колесом: курсор стоит, а карточки проезжают под ним
  for (let i = 0; i < 12; i++) { await js('window.__wheel()'); await move(600, 300 + (i % 2)); await sleep(80); }
  await away(); await sleep(600);
  const wheel = (await count()) - sweep;
  // 3. курсор остановился на карточке
  await move(600, 300); await sleep(500); await away(); await sleep(300);
  const dwell = (await count()) - sweep - wheel;
  // 4. повторно на ту же карточку
  await move(600, 300); await sleep(500); await away(); await sleep(300);
  const again = (await count()) - sweep - wheel - dwell;

  console.log(JSON.stringify({ sweep, wheel, dwell, again }));
  console.log(sweep === 0 && wheel === 0 && dwell === 1 && again === 0 ? 'ALL OK' : 'FAILED');
  srv.server.close();
  app.exit(0);
});
