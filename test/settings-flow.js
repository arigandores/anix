'use strict';
require('./_failfast');
// Разделы настроек (боковое меню, узкое окно); «Альтернативное соединение» / «Режим экономии» и их эффект; «Смотреть» — сразу к сериям.
// Запуск: npx electron test/settings-flow.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails++; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const reload = async () => { await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); }); await sleep(3500); };
  const go = (code) => js(`(async () => { document.querySelectorAll('.backdrop').forEach(b => b.remove()); const r = await import('/js/router.js'); ${code} })()`);
  await js(`localStorage.clear(); localStorage.setItem('anixart.pref.IS_ADULT','true')`);
  await reload();

  // 1. Разделы настроек: боковое меню, пункты — в своих разделах
  await go(`r.navigate('settings', {})`); await sleep(800);
  const SCR = `document.querySelector('#viewport .screen:last-child')`;
  const section = (id) => js(`(async () => {
    ${SCR}.querySelector('.settings-tab[data-section="${id}"]').click();
    await new Promise((ok) => setTimeout(ok, 300));
    const b = ${SCR}.querySelector('.settings-body > .menu-list');
    return { id: b?.dataset.section, title: b?.querySelector('.settings-title')?.textContent, labels: [...b.querySelectorAll('.menu-item .grow > div:first-child')].map((e) => e.textContent) };
  })()`);
  const tabs = await js(`[...${SCR}.querySelectorAll('.settings-tab')].map((b) => b.dataset.section)`);
  check('разделы по порядку', tabs.join() === 'look,playback,picture,discord,ai,advanced,account,about', tabs.join());
  const WANT = {
    look: ['Тёмная тема', 'Вкладка Главной по умолчанию', 'Вкладка в закладках по умолчанию'],
    playback: ['Запоминать вариант и источник', 'Скорость воспроизведения', 'Пропускать опенинг', 'Пропускать эндинг', 'Пропускать филлеры'],
    picture: ['Улучшение картинки', 'Выравнивать громкость'],
    discord: ['Статус в Discord'],
    ai: ['Модель'],
    advanced: ['Альтернативное соединение', 'Режим экономии ресурсов'],
    account: ['Авторизация'],
    about: ['Исходный код'],
  };
  const all = [];
  for (const id of tabs) {
    const r = await section(id);
    all.push(...r.labels);
    check(`раздел «${r.title}»: ${WANT[id].join(', ')}`, r.id === id && WANT[id].every((l) => r.labels.includes(l)), r.labels.join(' | '));
  }
  check('пункты не повторяются в разных разделах', new Set(all).size === all.length);
  check('настройки: нет «Непроверенные источники»', !all.includes('Непроверенные источники'));
  // выбранный раздел подсвечен, стрелка вниз — следующий раздел
  await section('ai');
  await js(`${SCR}.querySelector('.settings-tab.active').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); 1`);
  check('стрелка вниз → «Дополнительно»', await js(`${SCR}.querySelector('.settings-tab.active')?.dataset.section === 'advanced' && ${SCR}.querySelector('.settings-body > .menu-list').dataset.section === 'advanced'`));
  // «Пропускать опенинг» — та же настройка, что в шестерёнке плеера ('auto' / 'watch')
  await section('playback');
  await js(`[...${SCR}.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('Пропускать опенинг')).querySelector('input').click(); 1`);
  check('«Пропускать опенинг» → SKIP_OPENING = auto', await js(`localStorage.getItem('anixart.pref.SKIP_OPENING')`) === '"auto"', await js(`localStorage.getItem('anixart.pref.SKIP_OPENING')`));
  // повторный заход — в тот же раздел; section — сразу нужный
  await js(`history.back(); 1`); await sleep(500);
  await go(`r.navigate('settings', {})`); await sleep(800);
  check('повторный заход — в прежний раздел', await js(`${SCR}.querySelector('.settings-tab.active')?.dataset.section`) === 'playback');
  await js(`history.back(); 1`); await sleep(500);
  await go(`r.navigate('settings', { section: 'account' })`); await sleep(800);
  check('section: account — сразу «Аккаунт»', await js(`${SCR}.querySelector('.settings-body > .menu-list')?.dataset.section`) === 'account');
  // узкое окно: разделы — полосой под шапкой, без заголовка раздела
  const geo = () => js(`(() => { const n = ${SCR}.querySelector('.settings-nav'); const b = ${SCR}.querySelector('.settings-body'); const t = ${SCR}.querySelector('.settings-title');
    const nr = n.getBoundingClientRect(), br = b.getBoundingClientRect(); return { dir: getComputedStyle(n).flexDirection, side: nr.right <= br.left + 1, above: nr.bottom <= br.top + 1, title: !!t.offsetParent, over: document.getElementById('viewport').scrollWidth > document.getElementById('viewport').clientWidth }; })()`);
  let g = await geo();
  check('широкое окно: меню слева, заголовок раздела', g.dir === 'column' && g.side && g.title, JSON.stringify(g));
  win.setContentSize(520, 800); await sleep(400);
  g = await geo();
  check('узкое окно: разделы полосой сверху, без прокрутки вбок', g.dir === 'row' && g.above && !g.title && !g.over, JSON.stringify(g));
  win.setContentSize(1280, 860); await sleep(300);
  await js(`history.back(); localStorage.removeItem('anixart.pref.SKIP_OPENING'); 1`); await sleep(500);

  // 2. Официальных площадок нет: «Смотреть» сразу ведёт к сериям, в меню аниме нет «Онлайн просмотр»
  await go(`r.navigate('release', { id: 21 })`); await sleep(2500);
  await js(`document.querySelector('#viewport .screen:last-child .btn-watch').click()`); await sleep(1800);
  check('«Смотреть» → сразу серии', await js(`document.querySelector('#viewport .screen:last-child').dataset.screen === 'episodes'`));
  await go(`r.navigate('release', { id: 21 })`); await sleep(2500);
  await js(`document.querySelector('#viewport .screen:last-child .appbar .actions [aria-label="Ещё"]').click()`); await sleep(400);
  check('в меню аниме нет «Онлайн просмотр»', await js(`![...document.querySelectorAll('.sheet-item')].some((b) => b.textContent.includes('Онлайн просмотр'))`));
  await js(`document.querySelectorAll('.backdrop').forEach((b) => b.remove())`);

  // 3. Альтернативное соединение: картинки и адреса из toggles — на зеркалах
  await js(`localStorage.setItem('anixart.pref.FORCE_SHOULD_USE_MIRROR_URLS', 'true')`);
  await reload();
  await go(`r.navigate('release', { id: 21 })`); await sleep(3500);
  const m = await js(`(() => { const im = document.querySelector('.rel-hero .poster img'); return { src: im?.src, w: im?.naturalWidth, base: window.__toggles?.baseUrl, iframe: localStorage.getItem('anixart.pref.IFRAME_EMBED_URL') }; })()`);
  check('постер с зеркала и загрузился', /\/\/mirror-[^/]*anixmirai\.com\//.test(m.src || '') && m.w > 0, `${m.src} w=${m.w}`);
  check('BASE_URL / IFRAME_EMBED_URL на зеркале', /mirror/.test(m.base || '') && /mirror/.test(m.iframe || ''), `${m.base} ${m.iframe}`);
  await js(`localStorage.removeItem('anixart.pref.FORCE_SHOULD_USE_MIRROR_URLS')`);

  // 4. Режим экономии
  await js(`localStorage.setItem('anixart.pref.ECONOMY_MODE', 'true')`);
  await reload();
  check('режим экономии: класс economy', await js(`document.documentElement.classList.contains('economy')`));
  await js(`localStorage.clear()`);

  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  srv.server.close();
  app.exit(fails ? 1 : 0);
});
