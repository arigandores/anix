require('./_failfast');
// Предзагрузка при наведении не спамит: быстрый проход курсором по списку и прокрутка колесом — 0 запросов,
// остановка курсора на карточке — 1 запрос, повторное наведение на неё же — 0. Нажатие кнопки мыши: держат на
// месте (клик) — 1 запрос сразу, не дожидаясь отпускания; потянули (прокрутка перетаскиванием) — 0.
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
  window.__press = async (x, y, dy, hold) => {
    const el = document.elementFromPoint(x, y);
    const ev = (t, yy) => el.dispatchEvent(new PointerEvent(t, { bubbles: true, button: 0, clientX: x, clientY: yy, pointerType: 'mouse' }));
    ev('pointerdown', y);
    if (dy) for (let i = 1; i <= 5; i++) { ev('pointermove', y + (dy * i) / 5); await new Promise((r) => setTimeout(r, 8)); }
    await new Promise((r) => setTimeout(r, hold));
    ev('pointerup', y + dy);
  };
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

  // карточки по их положению: не та, что уже предзагружена при наведении (под y = 300)
  const spots = await js(`(() => { const used = document.elementFromPoint(600, 300)?.closest('.release-row, .release-card');
    return [...document.querySelectorAll('#viewport .screen:last-child .release-row, #viewport .screen:last-child .release-card')]
      .filter((c) => c !== used && !c.closest('.skeleton')).map((c) => c.getBoundingClientRect()).filter((b) => b.top > 120 && b.bottom < 840)
      .map((b) => [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]); })()`);
  if (spots.length < 2) { console.log('FAIL: нет двух карточек для проверки нажатия'); app.exit(1); return; }
  // 5. нажали и держат на месте (клик) — грузим, не дожидаясь отпускания
  let c0 = await count();
  await js(`window.__press(${spots[0][0]}, ${spots[0][1]}, 0, 90)`); await sleep(300);
  const press = (await count()) - c0;
  // 6. нажали и потянули (прокрутка перетаскиванием) — не грузим
  c0 = await count();
  await js(`window.__press(${spots[1][0]}, ${spots[1][1]}, 40, 120)`); await sleep(300);
  const drag = (await count()) - c0;

  const r = { sweep, wheel, dwell, again, drag, press };
  console.log(JSON.stringify(r));
  const ok = sweep === 0 && wheel === 0 && dwell === 1 && again === 0 && drag === 0 && press === 1;
  console.log(ok ? 'ALL OK' : 'FAIL: предзагрузка — лишние или недостающие запросы');
  srv.server.close();
  app.exit(ok ? 0 : 1);
});
