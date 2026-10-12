'use strict';
// Прокрутка чата сохраняется при переходе на релиз из ответа и возврате назад (без запросов к Claude:
// беседа подставляется в хранилище). Запуск: npx electron test/ai-scroll.js
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
  const PID = 999999999;
  const para = 'Длинный абзац ответа, чтобы беседа не помещалась на экран. '.repeat(6);
  const messages = [];
  for (let i = 0; i < 6; i++) messages.push({ role: 'user', text: `Вопрос ${i}` }, { role: 'assistant', blocks: [{ kind: 'text', text: `${para}\n\nСовет: [Мастер Муси](anixart://release/21)` }] });
  await js(`localStorage.clear(); localStorage.setItem('anixart.ai.chats.${PID}', ${JSON.stringify(JSON.stringify({ current: 'c1', chats: [{ id: 'c1', title: 'тест', updated: Date.now(), messages }] }))})`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(3000);
  await js(`(async () => { const { auth } = await import('/js/api.js'); auth.save('test-token', { id: ${PID}, login: 'tester' }); })()`);
  await sleep(500);
  await js(`document.querySelector('#rail .nav-item[data-tab="ai"]').click()`);
  for (let i = 0; i < 60 && !(await js(`!!document.querySelector('.ai-scroll .ai-msg')`)); i++) await sleep(300);
  await sleep(1500);
  const sc = `document.querySelector('.ai-scroll')`;
  const pos = () => js(`(() => { const s = ${sc}; return { top: Math.round(s.scrollTop), max: s.scrollHeight - s.clientHeight }; })()`);
  let p = await pos();
  check('беседа длиннее экрана и открыта в конце', p.max > 300 && p.max - p.top < 5, JSON.stringify(p));
  // 1. внизу → релиз → назад: снова внизу
  await js(`[...document.querySelectorAll('a.ai-rel-link')].pop().click()`); await sleep(1500);
  check('открылся релиз', await js(`document.querySelector('#viewport .screen').dataset.screen === 'release'`));
  await js('history.back()'); await sleep(1000);
  p = await pos();
  check('после «Назад» — снова в конце беседы', p.max - p.top < 5, JSON.stringify(p));
  // 2. прокрутили к середине → релиз → назад: та же позиция
  await js(`(() => { const s = ${sc}; s.scrollTop = 400; s.dispatchEvent(new Event('scroll')); })()`); await sleep(300); // скрытое окно не шлёт scroll само
  await js(`document.querySelector('a.ai-rel-link').click()`); await sleep(1500);
  await js('history.back()'); await sleep(1000);
  p = await pos();
  check('после «Назад» — та же позиция в середине', Math.abs(p.top - 400) < 5, JSON.stringify(p));
  await js('localStorage.clear()');
  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  srv.server.close();
  app.exit(fails ? 1 : 0);
});
