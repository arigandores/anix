'use strict';
// Стриминг ответа без мигания: элемент сообщения не пересоздаётся, анимация появления не перезапускается,
// поле ввода не двигается. Нужен вход в Claude на машине. Запуск: npx electron test/ai-stream.js [папка]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(out, { recursive: true });

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`localStorage.clear(); localStorage.setItem('anixart.theme','dark')`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(3000);
  await js(`(async () => { const { auth } = await import('/js/api.js'); auth.save('test-token', { id: 999999999, login: 'tester' }); })()`);
  await sleep(500);
  await js(`document.querySelector('#rail .nav-item[data-tab="ai"]').click()`);
  for (let i = 0; i < 60 && !(await js(`!!document.querySelector('.ai-chat')`)); i++) await sleep(300);
  // наблюдатель: пересоздание сообщений, перезапуск анимаций, положение поля ввода
  await js(`(() => {
    window.__obs = { replaced: 0, anims: 0, tops: new Set(), samples: 0, chunks: 0 };
    const list = document.querySelector('.ai-list');
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.removedNodes) if (n.classList && n.classList.contains('ai-msg')) window.__obs.replaced++; }).observe(list, { childList: true });
    document.addEventListener('animationstart', (e) => { if (!['ai-dot', 'spin'].includes(e.animationName) && e.target.closest && e.target.closest('.ai-msg')) window.__obs.anims++; }, true); // точки «печатает» и спиннер инструмента не считаем
    window.__timer = setInterval(() => { window.__obs.samples++; window.__obs.tops.add(Math.round(document.querySelector('.ai-composer').getBoundingClientRect().top)); }, 100);
  })()`);
  await js(`(() => { const ta = document.querySelector('.ai-composer textarea'); ta.value = 'Без инструментов и без интернета: перечисли 8 известных аниме про спорт, по одному предложению о каждом, списком.'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(1500);
  await win.webContents.capturePage(); await sleep(200);
  for (let i = 0; i < 300; i++) { if (await js(`document.querySelector('.ai-send[title="Отправить"]').style.display !== 'none'`)) break; await sleep(300); }
  fs.writeFileSync(path.join(out, 'ai-stream-done.png'), (await win.webContents.capturePage()).toPNG());
  const r = await js(`(() => { clearInterval(window.__timer); const o = window.__obs; return { replaced: o.replaced, anims: o.anims, composerTops: [...o.tops], samples: o.samples, len: [...document.querySelectorAll('.ai-msg.assistant')].pop().innerText.length }; })()`);
  console.log(JSON.stringify(r));
  // анимация появления — только у двух новых сообщений (вопрос и ответ); поле ввода на одном месте
  const ok = r.replaced === 0 && r.anims <= 2 && r.composerTops.length === 1 && r.len > 200;
  console.log(ok ? 'ALL OK' : 'FAILED');
  await js(`localStorage.clear()`);
  srv.server.close();
  app.exit(ok ? 0 : 1);
});
