'use strict';
// Модель и effort помощника: по умолчанию Sonnet/medium; смена в настройках применяется к текущей беседе.
// Нужен вход в Claude. Запуск: npx electron test/ai-config.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails++; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true).catch((e) => { console.log("JS FAIL:", c.slice(0, 120)); throw e; });
  const waitFor = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(cond)) return true; await sleep(300); } return false; };
  const ask = async (text) => {
    await js(`(() => { const ta = document.querySelector('.ai-composer textarea'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await sleep(800);
    await waitFor(`document.querySelector('.ai-send[title="Отправить"]').style.display !== 'none'`, 120000);
  };
  const log = async () => (await (await fetch(`${srv.url}ai/log`)).json()).filter((l) => l.includes('config ')).map((l) => l.split(' ').pop());
  await js(`localStorage.clear()`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(3000);
  await js(`(async () => { const { auth } = await import('/js/api.js'); auth.save('test-token', { id: 999999999, login: 'tester' }); })()`);
  await sleep(500);
  await js(`document.querySelector('#rail .nav-item[data-tab="ai"]').click()`);
  await waitFor(`!!document.querySelector('.ai-chat')`, 20000);
  check('подпись в шапке', await js(`document.querySelector('.ai-sub').textContent.includes('Sonnet 5.5')`), await js(`document.querySelector('.ai-sub').textContent`));
  await ask('Ответь одним словом: привет');
  let l = await log();
  check('по умолчанию Sonnet / medium', l.includes('model=sonnet') && l.includes('effort=medium'), l.join(', '));
  // пункты в настройках
  await js(`(async () => { const r = await import('/js/router.js'); r.navigate('settings', {}); })()`); await sleep(800);
  const items = await js(`[...document.querySelectorAll('.menu-item')].map(e => e.textContent.trim()).filter(t => /Модель|Глубина/.test(t))`);
  check('в настройках есть «Модель» и «Глубина рассуждений»', items.length === 2, JSON.stringify(items));
  await js(`localStorage.setItem('anixart.pref.AI_MODEL', '"opus"'); localStorage.setItem('anixart.pref.AI_EFFORT', '"high"'); history.back()`); await sleep(800);
  await ask('Ответь одним словом: пока');
  l = await log();
  check('смена применилась к текущей беседе', l.includes('model=opus') && l.includes('effort=high'), l.join(', '));
  await js(`localStorage.clear()`);
  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  srv.server.close();
  app.exit(fails ? 1 : 0);
});
