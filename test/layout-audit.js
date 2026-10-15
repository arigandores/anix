'use strict';
// Аудит вёрстки: экраны и типовые диалоги на нескольких ширинах окна. Ищет горизонтальный скролл страницы,
// элементы, вылезающие за границы родителя (кроме лент с прокруткой), и текст, выходящий за свой блок.
// Ширины проверяются одновременно, каждая в своём окне; экран считается загруженным, когда закончились запросы
// и пропали скелетоны (_settle.js), а пауза из списка — лишь верхняя граница.
// Запуск: npx electron test/layout-audit.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDTHS = (process.env.WIDTHS || '1280,820,420').split(',').map(Number);

// Выполняется в странице: возвращает список нарушений внутри #viewport и диалогов
const CHECK = require('./layout-check');

app.whenReady().then(async () => {
  const srv = await start(0);
  let total = 0;
  await Promise.all(WIDTHS.map((width) => auditWidth(srv, width).then((n) => { total += n; })));
  console.log(total ? `ISSUES: ${total}` : 'ISSUES: none');
  app.exit(0);
});

async function auditWidth(srv, width) {
  const win = new BrowserWindow({ width, height: 860, useContentSize: true, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  // В скрытом окне анимации стоят на первом кадре (диалог остаётся с opacity 0) — для проверки вёрстки выключаем их
  win.webContents.on('dom-ready', () => win.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }'));
  await win.loadURL(srv.url);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await js(settle.INSTALL);
  const nav = (screen, params = '{}') => js(`import('/js/router.js').then(m => m.navigate('${screen}', ${params}))`);
  const tab = (t) => js(`import('/js/router.js').then(m => m.switchTab('${t}'))`);
  const closeDialogs = () => js(`document.querySelectorAll('.backdrop').forEach(b => b.remove()); 1`);
  // Типовые диалоги с реальными текстами из strings.json
  const dialogs = {
    'dlg-alt-connection': `const { t } = await import('/js/store.js'); dialog({ title: t('alternative_connection'), content: h('p', null, t('alternative_connection_enable_text')), actions: [{ label: t('cancel') }, { label: 'Включить и перезапустить', primary: true }] });`,
    'dlg-too-many': `const { t } = await import('/js/store.js'); dialog({ title: 'Ошибка', content: h('p', null, t('error_too_many_registrations')), actions: [{ label: 'OK', primary: true }] });`,
    'dlg-search-video': `const { t } = await import('/js/store.js'); dialog({ title: t('search_video_title'), content: h('p', null, t('search_video_desc')), actions: [{ label: t('cancel') }, { label: t('search_video'), primary: true }] });`,
    'dlg-wait': `dialog({ title: 'Вход через ВКонтакте', content: h('div', { class: 'wait-row' }, h('div', { class: 'spinner sm' }), h('span', null, 'Продолжите вход в открывшемся браузере — приложение подхватит его само.')), actions: [{ label: 'Открыть снова' }, { label: 'Отмена' }] });`,
    'dlg-sheet': `const { sheet } = await import('/js/ui.js'); sheet('Выберите статус просмотра', ['Смотрю', 'В планах', 'Просмотрено', 'Отложено', 'Брошено', 'Удалить из списка «Просмотрено» и всех других'].map((l) => ({ label: l })));`,
  };
  const screens = [
    ['home', () => tab('home'), 5000],
    ['discover', () => tab('discover'), 6000],
    ['feed', () => tab('feed'), 5000],
    ['bookmarks', () => tab('bookmarks'), 2000],
    ['ai', () => tab('ai'), 3000],
    ['release', async () => { await tab('home'); await nav('release', '{id: 21}'); }, 5000],
    ['release-scroll', () => js('document.querySelector("#viewport").scrollTop = 1200'), 1200],
    ['episodes', () => nav('episodes', '{release: {id: 1, title_ru: "Тест"}}'), 5000],
    ['search', () => nav('search', '{query: "наруто"}'), 5000],
    ['filter', () => nav('filter', '{}'), 2500],
    ['schedule', () => nav('schedule'), 4000],
    ['top', () => nav('top'), 4000],
    ['collections', () => nav('collections', '{sort: 1}'), 4000],
    ['profile', async () => { await tab('discover'); await nav('profile', '{id: 1}'); }, 4000],
    ['auth', () => nav('auth'), 1500],
    ['signup', () => nav('signup'), 1200],
    ['restore', () => nav('restore'), 1200],
    ['settings', () => nav('settings'), 1500],
  ];
  let total = 0;
  {
    await sleep(800);
    const report = async (label) => {
      const issues = await js(CHECK);
      const seen = new Set();
      for (const i of issues) {
        const key = `${i.kind}|${i.el}|${i.text || ''}`;
        if (seen.has(key)) continue;
        seen.add(key); total++;
        console.log(`[${width}] ${label}: ${i.kind} ${i.el}${i.parent ? ` in ${i.parent}` : ''} +${i.px}px${i.text ? ` «${i.text}»` : ''}`);
      }
    };
    for (const [label, go, wait] of screens) {
      try { await go(); await sleep(150); await settle(js, wait); await report(label); } catch (e) { console.log(`[${width}] ${label}: ERROR ${e.message}`); }
    }
    await nav('settings'); await settle(js, 1000);
    for (const [label, code] of Object.entries(dialogs)) {
      await js(`(async () => { const { h, dialog } = await import('/js/ui.js'); ${code} })()`);
      await sleep(150);
      await report(label);
      await closeDialogs();
    }
  }
  win.destroy();
  return total;
}
