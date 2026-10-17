require('./_failfast');
// Колесо над чатом в окне «Смотреть вместе»: пока чату нечего листать (пустой или короткий), прокрутка уходит
// панели — раньше overscroll-behavior: contain на чате глушил колесо, и панель над чатом не листалась;
// длинный чат листается сам, а панель стоит (containScroll в ui.js). Настоящая комната (публичные MQTT-брокеры,
// как в party.js), окно узкое — панель выше окна. Запуск: npx electron test/chat-scroll.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 340, height: 780, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const ready = await js(`(async () => {
    const until = async (fn, max) => { const t0 = Date.now(); while (Date.now() - t0 < max) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
    const { party } = await import('/js/party/room.js'); const { partyDialog } = await import('/js/party/ui.js');
    await party.create(); partyDialog();
    return until(() => document.querySelector('.party-popover .party-chat'), 8000);
  })()`);
  if (!ready) { check(false, 'окно комнаты с чатом не открылось'); app.exit(1); return; }
  await sleep(300);
  const view = '.party-popover .party-view'; const chat = '.party-popover .party-chat';
  const center = () => js(`(() => { const b = document.querySelector('${chat}').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
  const wheel = async (dy) => {
    const p = await center();
    for (let i = 0; i < 3; i++) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: dy, canScroll: true }); await sleep(80); }
    await sleep(400);
  };

  const [st, sh, ch] = await js(`(() => { const v = document.querySelector('${view}'); v.scrollTop = 1e5; return [v.scrollTop, v.scrollHeight, v.clientHeight]; })()`);
  check(sh > ch && st > 0, `панель выше окна и прокручена вниз (${st} из ${sh - ch})`);
  await wheel(120);
  const after = await js(`document.querySelector('${view}').scrollTop`);
  check(after < st, `пустой чат: колесо над ним листает панель (${st} → ${after})`);

  // длинный чат: листается он сам, панель стоит
  await js(`(async () => { const { sendChat } = await import('/js/party/room.js'); for (let i = 0; i < 30; i++) sendChat('сообщение ' + i); })()`);
  await sleep(500);
  const [v0, c0, over] = await js(`(() => { const v = document.querySelector('${view}'); const c = document.querySelector('${chat}'); v.scrollTop = 1e5; return [v.scrollTop, c.scrollTop, c.scrollHeight > c.clientHeight]; })()`);
  await wheel(120);
  const [v1, c1] = await js(`[document.querySelector('${view}').scrollTop, document.querySelector('${chat}').scrollTop]`);
  check(over && c1 < c0 && v1 === v0, `длинный чат: листается чат (${c0} → ${c1}), панель стоит (${v0} → ${v1})`);
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
