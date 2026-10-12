'use strict';
// Память и история бесед вживую (нужен вход в Claude): «запомни» → запись в memories.md → новый чат знает об этом
// из системного промпта → «История» → возврат к первой беседе, агент помнит её контекст.
// Вход в Anixart фиктивный (id 999999999), память этого id в конце удаляется. Запуск: npx electron test/ai-memory.js [папка]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(out, { recursive: true });
const PID = 999999999;
const MEM = path.join(os.homedir(), '.anixart-desktop', 'ai', 'memories', `${PID}.md`);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails++; };

app.whenReady().then(async () => {
  try { fs.unlinkSync(MEM); } catch { /* нет */ }
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const shot = async (n) => { await win.webContents.capturePage(); await sleep(200); fs.writeFileSync(path.join(out, `${n}.png`), (await win.webContents.capturePage()).toPNG()); };
  const waitFor = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(cond)) return true; await sleep(300); } return false; };
  const ask = async (text) => {
    await js(`(() => { const ta = document.querySelector('.ai-composer textarea'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await sleep(800);
    await waitFor(`document.querySelector('.ai-send[title="Отправить"]').style.display !== 'none'`, 120000);
    return js(`[...document.querySelectorAll('.ai-msg.assistant')].pop().innerText`);
  };
  await js(`localStorage.clear(); localStorage.setItem('anixart.theme','dark')`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(3000);
  await js(`(async () => { const { auth } = await import('/js/api.js'); auth.save('test-token', { id: ${PID}, login: 'tester' }); })()`);
  await sleep(500);
  await js(`document.querySelector('#rail .nav-item[data-tab="ai"]').click()`);
  await waitFor(`!!document.querySelector('.ai-chat')`, 20000);

  // 1. запомнить
  const a1 = await ask('Запомни: я смотрю только с русской озвучкой, субтитры не люблю. И ещё моё кодовое слово — «пингвин». Ответь коротко.');
  console.log('   ответ 1:', JSON.stringify(a1.slice(0, 200)));
  const mem = fs.existsSync(MEM) ? fs.readFileSync(MEM, 'utf8') : '';
  check('запись в memories.md', /озвучк/i.test(mem), mem.split('\n').filter((l) => l.startsWith('- ')).join(' | '));
  check('в чате видна отметка «Запоминаю»', await js(`[...document.querySelectorAll('.ai-tool')].some(t => t.innerText.startsWith('Запоминаю'))`));
  // окно «Память»
  await js(`document.querySelector('.icon-btn[title="Память помощника"]').click()`); await sleep(800);
  check('окно «Память» показывает записи', await js(`document.querySelectorAll('.ai-mem-row').length > 0`));
  await shot('ai-memory-dialog');
  await js(`document.querySelectorAll('.backdrop').forEach(b => b.remove())`);

  // 2. новый чат: память из системного промпта
  await js(`document.querySelector('.icon-btn[title="Новый чат"]').click()`); await sleep(500);
  const a2 = await ask('Не вызывая инструментов: в каком формате я смотрю аниме? Одной фразой.');
  console.log('   ответ 2:', JSON.stringify(a2.slice(0, 200)));
  check('новый чат знает о предпочтении', /озвучк/i.test(a2));

  // 3. история: вернуться к первой беседе и продолжить её
  await js(`document.querySelector('.icon-btn[title="История бесед"]').click()`); await sleep(500);
  const rows = await js(`[...document.querySelectorAll('.ai-hist-row .ellipsis')].map(e => e.textContent)`);
  check('в истории 2 беседы', rows.length === 2, JSON.stringify(rows));
  await shot('ai-history');
  await js(`[...document.querySelectorAll('.ai-hist-row')].find(r => r.innerText.includes('Запомни')).click()`); await sleep(800);
  check('первая беседа на экране', await js(`document.querySelector('.ai-msg.user .bubble').textContent.startsWith('Запомни')`));
  const a3 = await ask('Какое кодовое слово я назвал выше в этом разговоре? Одним словом.');
  console.log('   ответ 3:', JSON.stringify(a3.slice(0, 120)));
  check('агент помнит контекст первой беседы', /пингвин/i.test(a3));

  try { fs.unlinkSync(MEM); } catch { /* ignore */ }
  await js(`localStorage.clear()`);
  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  srv.server.close();
  app.exit(fails ? 1 : 0);
});
