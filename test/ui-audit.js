'use strict';
// UI-аудит в Electron (окно не показывается): обход экранов и диалогов, поиск непереведённых
// ключей строк (snake_case в тексте/атрибутах) и скриншоты ключевых мест в тёмной теме.
// Запуск: npx electron test/ui-audit.js [папка-для-скриншотов]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');

const out = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SCAN = `(() => {
  const KEY = /\\b[a-z]{2,}(?:_[a-z0-9]+)+\\b/g; const hits = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = w.nextNode())) {
    const p = n.parentElement; if (!p || p.closest('script,style,.desc-text,.msg,.article .content')) continue;
    for (const k of (n.nodeValue.match(KEY) || [])) hits.add(k);
  }
  for (const el of document.querySelectorAll('[title],[placeholder]')) for (const a of ['title', 'placeholder']) {
    for (const k of ((el.getAttribute(a) || '').match(KEY) || [])) hits.add(k + '@' + a);
  }
  return [...hits];
})()`;

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`localStorage.setItem('anixart.theme','dark')`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(3500);
  const shot = async (name) => { await sleep(300); fs.writeFileSync(path.join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  const report = {};
  const visit = async (label, code, wait = 2200) => {
    await js(`(async () => { document.querySelectorAll('.backdrop').forEach(b => b.remove()); const r = await import('/js/router.js'); ${code} })()`);
    await sleep(wait);
    const hits = await js(SCAN);
    if (hits.length) report[label] = hits;
  };
  const screens = [
    ['home', "r.switchTab('home')", 3500], ['discover', "r.switchTab('discover')", 4500], ['bookmarks', "r.switchTab('bookmarks')"],
    ['feed', "r.switchTab('feed')"], ['profile-tab', "r.switchTab('profile')"], ['release', "r.navigate('release',{id:21})", 4000],
    ['episodes', "r.navigate('episodes',{release:{id:1,title_ru:'T'}})", 3000], ['search', "r.navigate('search',{query:'наруто'})", 3500],
    ['filter', "r.navigate('filter',{})"], ['schedule', "r.navigate('schedule',{})", 3000], ['top', "r.navigate('top',{})", 3000],
    ['collections', "r.navigate('collections',{sort:1})", 3000], ['collection', "r.navigate('collection',{id:1})", 3000],
    ['profile', "r.navigate('profile',{id:1})", 3000], ['comments', "r.navigate('comments',{kind:'release',id:21})", 3000],
    ['notifications', "r.navigate('notifications',{})"], ['auth', "r.navigate('auth',{})"], ['signup', "r.navigate('signup',{})"],
    ['restore', "r.navigate('restore',{})"], ['settings', "r.navigate('settings',{})"], ['notif-settings-guest', "r.navigate('watching',{})", 3000],
  ];
  for (const [label, code, wait] of screens) await visit(label, code, wait);

  // все диалоги-выборы на экране настроек
  await visit('settings', "r.navigate('settings',{})");
  const items = await js(`document.querySelectorAll('.menu-item').length`);
  for (let i = 0; i < items; i++) {
    await js(`document.querySelectorAll('.backdrop').forEach(b => b.remove()); document.querySelectorAll('.menu-item')[${i}]?.click(); 1`);
    await sleep(350);
    const isPrompt = await js(`!!document.querySelector('.backdrop input.input')`);
    const hits = await js(SCAN);
    if (hits.length) report[`settings-dialog-${i}`] = hits;
    if (i === 3) await shot('audit-settings-player');
    if (isPrompt) await js(`document.querySelectorAll('.backdrop').forEach(b => b.remove()); 1`);
  }
  await js(`document.querySelectorAll('.backdrop').forEach(b => b.remove()); 1`);

  // скриншоты: главная (пилюля анонса), полоса вкладок, релиз с цветным статусом, меню статусов
  await js(`(async () => { const r = await import('/js/router.js'); r.switchTab('home'); })()`);
  await sleep(1500);
  const clicked = await js(`(() => { const tabs = [...document.querySelectorAll('.tab')]; const ann = tabs.find(t => t.textContent.trim() === 'Анонсы'); if (ann) ann.click(); return { found: !!ann, active: document.querySelector('.tab.active')?.textContent }; })()`);
  console.log('announces tab:', JSON.stringify(clicked));
  await sleep(4000);
  await shot('audit-home-announces');
  await js(`(() => { const of = window.fetch; window.fetch = async (u, o) => { const res = await of(u, o); if (String(u).includes('/api/release/21')) { const j = await res.clone().json(); j.release.profile_list_status = 3; j.release.is_favorite = true; return new Response(JSON.stringify(j)); } return res; }; })()`);
  await js(`(async () => { const r = await import('/js/router.js'); r.navigate('release', {id: 21}); })()`);
  await sleep(4500);
  await shot('audit-release-status');
  await js(`(async () => { const { sheet } = await import('/js/ui.js'); const c = await import('/js/screens/common.js'); const { t } = await import('/js/store.js'); sheet(t('title_choose_watch_status'), c.LIST_NAMES.map((k, i) => ({ label: t(k), checked: i === 3, dot: c.STATUS_COLORS[i] }))); })()`);
  await sleep(600);
  await shot('audit-status-sheet');

  console.log('UNTRANSLATED:', Object.keys(report).length ? JSON.stringify(report, null, 1) : 'none');
  console.log('CONSOLE ERRORS:', errors.length ? errors.slice(0, 10).join('\n') : 'none');
  srv.server.close();
  app.exit(0);
});
