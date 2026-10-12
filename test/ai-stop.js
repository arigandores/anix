'use strict';
// «Стоп» сразу возвращает чат в рабочее состояние и после него можно задать следующий вопрос.
// Нужен вход в Claude. Запуск: npx electron test/ai-stop.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails++; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const waitFor = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(cond)) return true; await sleep(200); } return false; };
  const idle = `document.querySelector('.ai-send[title="Отправить"]').style.display !== 'none'`;
  const send = (text) => js(`(() => { const ta = document.querySelector('.ai-composer textarea'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await js('localStorage.clear()');
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(3000);
  await js(`(async () => { const { auth } = await import('/js/api.js'); auth.save('test-token', { id: 999999999, login: 'tester' }); })()`);
  await sleep(500);
  await js(`document.querySelector('#rail .nav-item[data-tab="ai"]').click()`);
  await waitFor(`!!document.querySelector('.ai-chat')`, 20000);

  await send('Найди в каталоге «Наруто», «Блич» и «Ван-Пис» и подробно опиши каждый в пяти абзацах.');
  await waitFor(`!(${idle})`, 5000);
  await sleep(3000);
  const t0 = Date.now();
  await js(`document.querySelector('.ai-send[title="Остановить"]').click()`);
  const back = await waitFor(idle, 1000);
  check('после «Стоп» чат сразу снова готов', back, `${Date.now() - t0} мс`);
  check('нет висящих спиннеров', (await js(`document.querySelectorAll('.ai-msg.assistant:last-child .ai-tool.run, .ai-msg.assistant:last-child .ai-typing').length`)) === 0);
  await sleep(2000);
  await send('Ответь одним словом: работает?');
  await waitFor(`!(${idle})`, 5000);
  const answered = await waitFor(idle, 120000);
  const last = await js(`[...document.querySelectorAll('.ai-msg.assistant')].pop().innerText`);
  check('следующий вопрос получил ответ', answered && last.trim().length > 0, JSON.stringify(last.slice(0, 80)));
  await js('localStorage.clear()');
  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  srv.server.close();
  app.exit(fails ? 1 : 0);
});
