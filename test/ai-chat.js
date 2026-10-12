'use strict';
// Вкладка AI вживую (нужен вход в Claude на этой машине): ступень «войдите в Anixart», чат, ответ со ссылкой
// и карточкой релиза (действия без подтверждений — test/ai-actions.js). Вход в Anixart — фиктивный (только для ступени),
// поэтому личные инструменты вернут ошибку, а поиск по каталогу работает.
// Запуск: npx electron test/ai-chat.js [папка-для-скриншотов]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(out, { recursive: true });
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails++; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const shot = async (n) => { await win.webContents.capturePage(); await sleep(200); fs.writeFileSync(path.join(out, `${n}.png`), (await win.webContents.capturePage()).toPNG()); };
  const waitFor = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(cond)) return true; await sleep(300); } return false; };
  await js(`localStorage.clear(); localStorage.setItem('anixart.theme','dark')`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(3000);

  // 1. без входа в Anixart
  check('пункт меню AI', await js(`!!document.querySelector('#rail .nav-item[data-tab="ai"]')`));
  await js(`document.querySelector('#rail .nav-item[data-tab="ai"]').click()`); await sleep(800);
  check('ступень «Сначала войдите в Anixart»', await js(`document.querySelector('.ai-gate .empty-title')?.textContent === 'Сначала войдите в Anixart'`));
  await shot('ai-gate-app');

  // 2. «вход» в Anixart → проверка Claude → чат
  await js(`(async () => { const { auth } = await import('/js/api.js'); auth.save('test-token', { id: 999999999, login: 'tester' }); })()`);
  await sleep(500);
  await js(`document.querySelector('#rail .nav-item[data-tab="ai"]').click()`);
  check('после входа — чат (Claude подключён)', await waitFor(`!!document.querySelector('.ai-chat')`, 20000));
  await shot('ai-chat-empty');

  // 3. вопрос по каталогу
  const t0 = Date.now();
  await js(`(() => { const ta = document.querySelector('.ai-composer textarea'); ta.value = 'Найди в каталоге «Мастер Муси» и одной фразой скажи, что нашёл. Только search_releases, без интернета.'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  check('индикатор инструмента в чате', await waitFor(`!!document.querySelector('.ai-tool')`, 60000));
  const done = await waitFor(`!document.querySelector('.ai-typing') && document.querySelector('.ai-send[title="Отправить"]').style.display !== 'none' && document.querySelectorAll('.ai-msg.assistant .ai-md').length > 0`, 120000);
  check('ответ получен', done, `${Date.now() - t0} мс`);
  const ans = await js(`(() => { const m = [...document.querySelectorAll('.ai-msg.assistant')].pop(); return { text: m.querySelector('.bubble').innerText.slice(0, 300), link: !!m.querySelector('a.ai-rel-link'), cards: m.querySelectorAll('.ai-card').length, tool: m.querySelector('.ai-tool')?.innerText }; })()`);
  console.log('   ответ:', JSON.stringify(ans));
  check('ссылка на релиз и карточка', ans.link && ans.cards > 0);
  await sleep(1500);
  await shot('ai-chat-answer');

  await js(`localStorage.clear()`);
  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  srv.server.close();
  app.exit(fails ? 1 : 0);
});
