'use strict';
// Чат не «зависает», если во время ответа уйти с экрана: помощник открывает релиз (open_release),
// пользователь переключается на другую вкладку, потом возвращается — ответ дорисован, спиннеров нет.
// Нужен вход в Claude. Запуск: npx electron test/ai-away.js
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
  const waitFor = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(cond)) return true; await sleep(300); } return false; };
  await js('localStorage.clear()');
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(3000);
  await js(`(async () => { const { auth } = await import('/js/api.js'); auth.save('test-token', { id: 999999999, login: 'tester' }); })()`);
  await sleep(500);
  const tab = (t) => js(`document.querySelector('#rail .nav-item[data-tab="${t}"]').click()`);
  await tab('ai');
  await waitFor(`!!document.querySelector('.ai-chat')`, 20000);
  await js(`(() => { const ta = document.querySelector('.ai-composer textarea'); ta.value = 'Сначала открой релиз id 21 инструментом open_release, потом найди через search_releases «Наруто» и напиши по три предложения о каждом.'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check('помощник открыл релиз посреди ответа', await waitFor(`document.querySelector('#viewport .screen').dataset.screen === 'release'`, 60000));
  await tab('home'); // ушли на другую вкладку, пока ответ продолжается
  await sleep(30000);
  await tab('ai');
  await sleep(500);
  if (await js(`document.querySelector('#viewport .screen').dataset.screen === 'release'`)) { await js('history.back()'); await sleep(800); }
  const done = await waitFor(`!!document.querySelector('.ai-chat') && document.querySelector('.ai-send[title="Отправить"]').style.display !== 'none'`, 90000);
  check('после возврата ответ завершён (нет «Стоп»)', done);
  const r = await js(`(() => { const m = [...document.querySelectorAll('.ai-msg.assistant')].pop(); return { spinners: m.querySelectorAll('.ai-tool.run, .ai-typing').length, text: m.querySelector('.ai-md:last-of-type')?.innerText.length || 0, tools: [...m.querySelectorAll('.ai-tool')].map(t => t.innerText) }; })()`);
  check('нет висящих спиннеров, текст ответа на месте', r.spinners === 0 && r.text > 100, JSON.stringify(r));
  await js('localStorage.clear()');
  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  srv.server.close();
  app.exit(fails ? 1 : 0);
});
