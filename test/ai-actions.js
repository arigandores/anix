'use strict';
// Действия помощника без подтверждений: закладки и коллекции (создать, убрать релиз).
// Помощник настоящий (нужен вход в Claude), а ответы бекенда на изменяющие запросы подменены — аккаунт не трогается.
// Запуск: npx electron test/ai-actions.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PID = 999999999;
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails++; };

const MOCK = `(() => {
  window.__calls = []; window.__dialogs = 0;
  new MutationObserver(() => { if (document.querySelector('.dialog-title')?.textContent === 'Подтвердите действие') window.__dialogs++; }).observe(document.body, { childList: true, subtree: true });
  const of = window.fetch;
  const ok = (j) => new Response(JSON.stringify(j), { headers: { 'Content-Type': 'application/json' } });
  let col = null;
  window.fetch = async (u, o = {}) => {
    const p = new URL(String(u), location.href).pathname.replace(/^\\/api\\//, '');
    const body = o.body ? JSON.parse(o.body) : undefined;
    if (/^(profile\\/list\\/|favorite\\/|release\\/vote\\/|collectionMy\\/)/.test(p)) window.__calls.push({ p, body });
    if (/^profile\\/list\\/(add|delete)\\//.test(p)) return ok({ code: 0 });
    if (p === 'collectionMy/create') { col = { id: 777, title: body.title, description: body.description, is_private: body.is_private, creator: { id: ${PID}, login: 'tester' }, releases: body.releases }; return ok({ code: 0, collection: col }); }
    if (p === 'collection/777') return ok({ code: 0, collection: col });
    if (p === 'collectionMy/777/releases') return ok({ code: 0, content: (col?.releases || []).map((id) => ({ id })) });
    if (p.startsWith('collectionMy/edit/777')) { col = { ...col, title: body.title, releases: body.releases }; return ok({ code: 0, collection: col }); }
    if (p.startsWith('collection/all/profile/')) return ok({ code: 0, content: col ? [col] : [], total_count: col ? 1 : 0 });
    return of(u, o);
  };
})()`;

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const waitFor = async (cond, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(cond)) return true; await sleep(300); } return false; };
  const ask = async (text) => {
    await js(`(() => { const ta = document.querySelector('.ai-composer textarea'); ta.value = ${JSON.stringify(text)}; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await sleep(800);
    await waitFor(`document.querySelector('.ai-send[title="Отправить"]').style.display !== 'none'`, 150000);
    return js(`[...document.querySelectorAll('.ai-msg.assistant')].pop().innerText`);
  };
  const calls = () => js('window.__calls');
  await js('localStorage.clear()');
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(3000);
  await js(MOCK);
  await js(`(async () => { const { auth } = await import('/js/api.js'); auth.save('test-token', { id: ${PID}, login: 'tester' }); })()`);
  await sleep(500);
  await js(`document.querySelector('#rail .nav-item[data-tab="ai"]').click()`);
  await waitFor(`!!document.querySelector('.ai-chat')`, 20000);

  const a1 = await ask('Добавь «Мастер Муси» (id 21) в мой список «В планах».');
  let c = await calls();
  check('закладка: запрос ушёл без подтверждения', c.some((x) => x.p === 'profile/list/add/2/21'), JSON.stringify(c.map((x) => x.p)));
  console.log('   ответ:', JSON.stringify(a1.slice(0, 160)));

  const a2 = await ask('Создай приватную коллекцию «Лучшее про ёкаев и духов» и добавь туда «Мастер Муси» (id 21).');
  c = await calls();
  const create = c.find((x) => x.p === 'collectionMy/create');
  check('коллекция создана', !!create && create.body.is_private === true && create.body.releases.includes(21) && create.body.title.length >= 10, JSON.stringify(create && create.body));
  console.log('   ответ:', JSON.stringify(a2.slice(0, 160)));

  const a3 = await ask('Убери «Мастер Муси» из этой коллекции.');
  c = await calls();
  const edit = c.find((x) => x.p === 'collectionMy/edit/777');
  check('релиз убран из коллекции', !!edit && Array.isArray(edit.body.releases) && !edit.body.releases.includes(21), JSON.stringify(edit && edit.body));
  console.log('   ответ:', JSON.stringify(a3.slice(0, 160)));

  check('ни одного диалога подтверждения', (await js('window.__dialogs')) === 0);
  await js('localStorage.clear()');
  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  srv.server.close();
  app.exit(fails ? 1 : 0);
});
