'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Путь до серии: «Смотреть» → выбор озвучки на экране серий → чипы озвучки, источника и плеера (выпадающие меню,
// смена на месте) → «Продолжить» на странице аниме (посередине серии, досмотрена, просмотр на другом устройстве)
// → запуск серии сразу с сохранённого места. Скриншоты — в test/shots/watch-*.png (тёмная и светлая темы).
// Запуск: npx electron test/watch-flow.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const settle = require('./_settle');

const RID = 21; // «Мастер Муси»: 8 озвучек, у AniDUB два источника (Sibnet — пустой, Kodik)
const outDir = path.join(__dirname, 'shots');
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = []; const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails.push(name); };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  // скрытое окно не проигрывает анимации появления: меню и диалоги застыли бы прозрачными на первом кадре —
  // на время теста анимации выключены, скриншоты сразу в конечном состоянии
  win.webContents.on('dom-ready', () => win.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }'));
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(`${e.message} @ ${e.sourceId}:${e.lineNumber}`); });
  await win.webContents.session.clearCache(); // картинки из кэша прошлых запусков скрыли бы ошибки загрузки (Referer и т. п.)
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const shot = async (name) => { await settle(js, 4000); fs.writeFileSync(path.join(outDir, `watch-${name}.png`), (await win.webContents.capturePage()).toPNG()); };
  const scr = `document.querySelector('#viewport .screen:last-child')`;
  const nav = (name, params) => js(`import('/js/router.js').then((r) => r.navigate('${name}', ${params}))`);
  const text = (sel) => js(`(${scr}.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const click = (sel) => js(`(() => { const el = ${scr}.querySelector(${JSON.stringify(sel)}) || document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const reset = (theme) => js(`localStorage.clear(); localStorage.setItem('anixart.theme', '${theme}'); location.reload(); 1`);

  let kodik;
  for (const theme of ['dark', 'light']) {
    await reset(theme); await sleep(2500); await js(settle.INSTALL); await settle(js, 4000);
    const T = theme === 'dark' ? '' : ' (светлая)';

    // 0. Аниме 18+ открывается сразу, без вопроса о возрасте (профиль чистый)
    if (theme === 'dark') {
      await nav('release', `{ id: 20643 }`);
      for (let i = 0; i < 60 && !(await js(`!!${scr}.querySelector('.rel-title') || document.body.innerText.includes('Возрастное ограничение')`)); i++) await sleep(250);
      const adult = await js(`({ gate: document.body.innerText.includes('Возрастное ограничение'), title: ${scr}.querySelector('.rel-title')?.innerText, watch: !!${scr}.querySelector('.watch') })`);
      check('18+ — без вопроса о возрасте', !adult.gate && !!adult.title && adult.watch, JSON.stringify(adult));
      await js(`history.back(); 1`); await settle(js, 3000);
    }

    // 1. Не смотрели: «Смотреть», официальных площадок нет
    await nav('release', `{ id: ${RID} }`); await settle(js, 6000);
    const watch = await text('.watch');
    check(`страница аниме: «Смотреть»${T}`, /^Смотреть/.test(watch), watch);
    check('нет пункта «Онлайн просмотр»', !(await js(`document.body.innerText.includes('Онлайн просмотр')`)));
    check('в шапке страницы аниме — «Смотреть вместе» (вне комнаты)', await js(`(() => { const b = ${scr}.querySelector('.appbar .party-btn'); return !!b && getComputedStyle(b).display !== 'none' && b.offsetWidth > 0; })()`));
    if (theme === 'dark') await shot('1-release-new');

    // 2. «Смотреть» → экран серий с выбором озвучки на месте
    await click('.watch .btn-watch'); await settle(js, 6000);
    check(`экран серий открылся${T}`, await js(`${scr}.dataset.screen === 'episodes'`));
    check('выбор озвучки на экране серий', /Выберите озвучку/.test(await text('.pick-head')));
    const typeRows = await js(`${scr}.querySelectorAll('.type-row').length`);
    check('озвучки списком', typeRows > 1, `${typeRows}`);
    await shot(`2-pick-${theme}`);

    // 3. Выбрали AniDUB → чипы, источник получше выбран сам (у пустого Sibnet 0 серий), список серий
    await js(`[...${scr}.querySelectorAll('.type-row')].find((r) => r.innerText.includes('AniDUB')).click(); 1`);
    await settle(js, 6000);
    check('чип озвучки', /AniDUB/.test(await text('.wchip-dub')));
    const src = await text('.wchip-src');
    check('чип источника: Kodik · 720p', /Kodik/.test(src) && /720p/.test(src), src);
    check('чип плеера: встроенный', /Встроенный/.test(await text('.wchip-player')));
    const rows = await js(`${scr}.querySelectorAll('.ep-row').length`);
    check('список серий', rows === 26, `${rows}`);
    check('выбор запомнен', await js(`JSON.parse(localStorage.getItem('anixart.db.choice') || '{}')[${RID}]?.sourceName === 'Kodik'`));
    await shot(`3-chips-${theme}`);

    // 4. Меню озвучки: поиск, текущая отмечена; смена на месте — экран тот же, список перерисован
    await click('.wchip-dub'); await sleep(300);
    const items = await js(`document.querySelectorAll('.popover .pop-item').length`);
    check('меню озвучек', items === typeRows, `${items}`);
    check('в меню есть поиск', await js(`!!document.querySelector('.popover .pop-search')`));
    await shot(`4-dub-menu-${theme}`);
    await js(`(() => { const s = document.querySelector('.popover .pop-search'); s.value = 'shiza'; s.dispatchEvent(new Event('input')); })(); 1`); await sleep(150);
    check('поиск озвучки', await js(`document.querySelectorAll('.popover .pop-item').length === 1`));
    await js(`document.querySelector('.popover .pop-item').click(); 1`); await settle(js, 6000);
    check('озвучка сменилась на месте', /SHIZA/.test(await text('.wchip-dub')) && await js(`${scr}.dataset.screen === 'episodes'`));
    check('источник один — чип всё равно виден, с качеством', /Kodik/.test(await text('.wchip-src')) && /720p/.test(await text('.wchip-src')));
    await click('.wchip-src'); await sleep(300);
    check('в меню единственного источника — пояснение', await js(`document.querySelectorAll('.popover .pop-item').length === 1 && /Другого источника/.test(document.querySelector('.popover').innerText)`));
    await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`); await sleep(250);

    // 5. Меню плееров: от лучшего к худшему, с качеством
    await click('.wchip-player'); await sleep(300);
    const players = await js(`[...document.querySelectorAll('.popover .pop-item .pop-title')].map((x) => x.innerText)`);
    check('плееры: встроенный → сторонний → веб', players.join('|') === 'Встроенный плеер|Сторонний плеер|Веб-плеер', players.join(' | '));
    check('качество у встроенного: 720p → 4K', /720p → 4K/.test(await js(`document.querySelector('.popover .pop-item').innerText`)));
    await shot(`5-player-menu-${theme}`);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); 1`); await sleep(250);
    check('Esc закрывает меню', !(await js(`!!document.querySelector('.popover:not(.closing)')`)));

    // 6. Начали 5-ю серию (AniDUB, Kodik), остановились на 12:40 из 24:10: «Продолжить», заливка, «⏭ 6 серия»
    kodik = await js(`fetch('/api/episode/${RID}/1').then((r) => r.json()).then((j) => j.sources.find((s) => s.name === 'Kodik').id)`);
    await js(`(async () => {
      const { db } = await import('/js/store.js');
      db.addLastWatched(${RID}, 1, ${kodik}, 5, { typeName: 'AniDUB', sourceName: 'Kodik' });
      for (const p of [1, 2, 4]) db.putEpisode(${RID}, ${kodik}, p, { isWatched: true, playbackPosition: -1 });
      db.putEpisode(${RID}, ${kodik}, 3, { isWatched: true, playbackPosition: 600000, duration: 1450000 }); // бросили на 10:00
      db.putEpisode(${RID}, ${kodik}, 5, { isWatched: true, playbackPosition: 760000, duration: 1450000, endingStart: 1340000 });
    })()`);
    await js(`history.back(); 1`); await settle(js, 5000);
    const cont = await text('.watch');
    check(`«Продолжить · 5 серия»${T}`, /Продолжить · 5 серия/.test(cont), cont);
    check('остаток в кнопке', /ещё 12 мин/.test(cont));
    check('подпись: озвучка и время', /AniDUB • Kodik • остановились на 12:40 из 24:10/.test(cont));
    check('заливка прогресса', await js(`(() => { const b = ${scr}.querySelector('.btn-watch.resume'); return !!b && b.style.getPropertyValue('--p') === '52.4%'; })()`));
    check('кнопка «⏭ 6 серия»', /6 серия/.test(await text('.btn-next')));
    await shot(`6-continue-${theme}`);

    // 7. Отметки общие для аниме: в другой озвучке 1–4 тоже просмотрены, 5-я — предлагаемая
    await click('.watch .btn-tonal:not(.btn-next):not(.btn-party)'); await settle(js, 6000);
    const marks = await js(`[...${scr}.querySelectorAll('.ep-row')].slice(0, 6).map((r) => r.classList.contains('watched') ? 'w' : r.classList.contains('current') ? 'c' : '-').join('')`);
    check('отметки: 1–4 просмотрены, 5 — текущая (в другой озвучке тоже)', marks === 'wwwwc-', marks);
    check('строка текущей: время и остаток', /Остановились на 12:40 из 24:10 • осталось 12 мин/.test(await text('.ep-row.current')));
    const wsub = await js(`[...${scr}.querySelectorAll('.ep-row')].slice(0, 3).map((r) => r.querySelector('.ep-sub').innerText + (r.querySelector('.ep-progress') ? ' [' + r.querySelector('.ep-progress span').style.width + ']' : ''))`);
    check('просмотренные: «до конца» и «остановились на 10:00 из 24:10» с полоской', /Просмотрена • до конца \[100(\.0)?%\]/.test(wsub[0]) && /Просмотрена • остановились на 10:00 из 24:10 \[41\.4%\]/.test(wsub[2]), wsub.join(' | '));
    await shot(`7-marks-${theme}`);
    await js(`history.back(); 1`); await settle(js, 4000);

    // 8. Вышли на эндинге — «Смотреть 6 серию»
    await js(`import('/js/store.js').then(({ db }) => { db.putEpisode(${RID}, ${kodik}, 5, { playbackPosition: 1370000 }); window.dispatchEvent(new CustomEvent('watch-changed', { detail: { releaseId: ${RID} } })); })`);
    await sleep(300);
    const fin = await text('.watch');
    check(`досмотрена до эндинга → «Смотреть 6 серию»${T}`, /Смотреть 6 серию/.test(fin) && /5 серия досмотрена/.test(fin), fin);
    check('без «⏭», когда серия досмотрена', !(await js(`!!${scr}.querySelector('.btn-next')`)));
    await shot(`8-finished-${theme}`);
  }

  // 9. Просмотр на другом устройстве новее локального: серия и озвучка с сервера
  await js(`(async () => {
    const { db } = await import('/js/store.js');
    const { lastOf, resumeOf } = await import('/js/screens/episodes.js');
    const rel = { id: ${RID}, last_view_timestamp: Math.floor(Date.now() / 1000) + 3600,
      last_view_episode: { position: 8, source: { id: 999, name: 'Kodik', type: { id: 34, name: 'Люб. Двухголосый' } } } };
    window.__remote = { last: lastOf(rel), resume: resumeOf(rel) };
  })()`);
  const remote = await js('window.__remote');
  check('серия с другого устройства', remote.last.position === 8 && remote.last.remote && remote.last.typeName === 'Люб. Двухголосый', JSON.stringify(remote.last));
  check('с другого устройства — «Продолжить», минут нет', remote.resume.target === 8 && !remote.resume.finished && !remote.resume.progress);

  // 10. «Продолжить» запускает плеер сразу с сохранённого места, без вопроса «Продолжить?»
  await js(`(async () => {
    const { db } = await import('/js/store.js');
    db.putEpisode(${RID}, ${kodik}, 5, { playbackPosition: 760000, duration: 1450000, endingStart: 1340000, finished: false });
    window.dispatchEvent(new CustomEvent('watch-changed', { detail: { releaseId: ${RID} } }));
  })()`);
  await sleep(400);
  await click('.watch .btn-watch');
  let st = null;
  for (let i = 0; i < 40 && !(st && st.t > 0); i++) {
    await sleep(500);
    st = await js(`(() => { const v = document.querySelector('.player-overlay video'); return v ? { t: v.currentTime, rs: v.readyState, ask: !!document.querySelector('.backdrop .dialog-title') } : null; })()`);
  }
  check('плеер открылся', !!st, JSON.stringify(st));
  check('с 12:40, без вопроса «Продолжить?»', !!st && st.t >= 755 && st.t < 800 && !st.ask, JSON.stringify(st));
  check('заголовок плеера — 5 серия', /5 серия/.test(await js(`document.querySelector('.player-top .ttl')?.innerText || ''`)));
  await js(`document.querySelector('.player-overlay video')?.pause(); 1`);
  fs.writeFileSync(path.join(outDir, 'watch-9-player.png'), (await win.webContents.capturePage()).toPNG());

  // 11. Переключатели в плеере: озвучка, серия, плеер — слева сверху
  const pchips = await js(`[...document.querySelectorAll('.player-top .p-chip .lbl')].map((x) => x.innerText)`);
  check('переключатели в плеере', pchips.join('|') === 'AniDUB|5 серия|Встроенный', pchips.join(' | '));
  let logo = false;
  for (let i = 0; i < 20 && !(logo = await js(`!!document.querySelector('.player-top .p-dub .p-logo')`)); i++) await sleep(250);
  check('логотип озвучки на чипе — сразу, без открытия меню', logo);
  const poke = () => js(`document.querySelector('.player-overlay').dispatchEvent(new MouseEvent('mousemove', { clientX: Math.random() * 500, clientY: 40 })); 1`);
  await poke(); await js(`document.querySelector('.player-top .p-eps').click(); 1`); await sleep(400);
  const grid = await js(`[...document.querySelectorAll('.popover .p-ep')].map((b) => b.classList.contains('w') ? 'w' : b.classList.contains('cur') ? 'c' : '-').join('')`);
  check('сетка серий: 1–4 просмотрены, 5 — сейчас', grid.startsWith('wwwwc-') && grid.length === 26, grid);
  fs.writeFileSync(path.join(outDir, 'watch-10-player-eps.png'), (await win.webContents.capturePage()).toPNG());
  await js(`[...document.querySelectorAll('.popover .p-ep')][5].click(); 1`);
  for (let i = 0; i < 30; i++) { await sleep(500); if (/6 серия/.test(await js(`document.querySelector('.player-top .ttl')?.innerText || ''`)) && await js(`(document.querySelector('.player-overlay video')?.readyState || 0) >= 1`)) break; }
  check('из сетки — 6 серия', /6 серия/.test(await js(`document.querySelector('.player-top .ttl')?.innerText || ''`)));
  check('5 серия отмечена просмотренной', await js(`import('/js/store.js').then(({ db }) => db.watchedOfRelease(${RID}).has(5))`));
  // смена озвучки — та же серия с того же места
  for (let i = 0; i < 30; i++) { await sleep(500); if (await js(`(document.querySelector('.player-overlay video')?.readyState || 0) >= 2`)) break; }
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.currentTime = 300; v.pause(); })(); 1`); await sleep(800);
  await poke(); await js(`document.querySelector('.player-top .p-dub').click(); 1`); await sleep(1500);
  const dubItems = await js(`document.querySelectorAll('.popover .pop-item').length`);
  check('меню озвучек в плеере', dubItems === 8, `${dubItems}`);
  fs.writeFileSync(path.join(outDir, 'watch-11-player-dub.png'), (await win.webContents.capturePage()).toPNG());
  await js(`[...document.querySelectorAll('.popover .pop-item')].find((b) => b.innerText.includes('Люб. Двухголосый')).click(); 1`);
  let sw = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    sw = await js(`(() => { const v = document.querySelector('.player-overlay video'); return { dub: document.querySelector('.player-top .p-dub .lbl')?.innerText, ttl: document.querySelector('.player-top .ttl')?.innerText.replace(/\\s+/g, ' '), t: v?.currentTime, rs: v?.readyState }; })()`);
    if (sw.dub === 'Люб. Двухголосый' && sw.rs >= 1 && sw.t > 0) break;
  }
  check('озвучка сменилась в плеере', sw.dub === 'Люб. Двухголосый', JSON.stringify(sw));
  check('та же серия с того же места', /6 серия/.test(sw.ttl) && sw.t >= 295 && sw.t < 330, JSON.stringify(sw));
  // меню плеера; Esc закрывает меню, а не плеер
  await poke(); await js(`document.querySelector('.player-top .p-player').click(); 1`); await sleep(1200);
  check('меню плееров в плеере', await js(`document.querySelectorAll('.popover .pop-item').length === 3`));
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`); await sleep(300); // как настоящая клавиша: через window (захват)
  check('Esc закрыл меню, плеер открыт', !(await js(`!!document.querySelector('.popover:not(.closing)')`)) && await js(`!!document.querySelector('.player-overlay')`));

  // 12. Из плеера — в сторонний: без вопроса о качестве, то же качество и та же секунда; чип на экране серий — «Сторонний»
  await js(`window.__p0 = 1; (() => { const v = document.querySelector('.player-overlay video'); v.currentTime = 200; v.pause(); })(); 1`); await sleep(1500);
  await js(`(() => { const of = window.fetch; window.__ext = null; window.fetch = (u, o) => { if (String(u) === '/external') { window.__ext = JSON.parse(o.body); return Promise.resolve(new Response('{"ok":true}')); } return of(u, o); }; })(); 1`);
  await nav('episodes', `{ release: { id: ${RID}, title_ru: 'Мастер Муси' } }`); await sleep(500);
  await poke(); await js(`document.querySelector('.player-top .p-player').click(); 1`); await sleep(1200);
  await js(`[...document.querySelectorAll('.popover .pop-item')].find((b) => b.innerText.includes('Сторонний')).click(); 1`); await sleep(1500);
  const ext = await js('window.__ext');
  check('сторонний: без вопроса о качестве', !(await js(`!!document.querySelector('.backdrop .dialog')`)));
  check('сторонний: качество из встроенного, с той же секунды', !!ext && /720/.test(ext.url) && ext.start >= 199 && ext.start < 210, JSON.stringify(ext && { start: ext.start, url: ext.url.slice(-40) }));
  check('встроенный закрылся', !(await js(`!!document.querySelector('.player-overlay')`)));
  await settle(js, 4000);
  check('чип на экране серий — «Сторонний плеер»', /Сторонний/.test(await text('.wchip-player')), await text('.wchip-player'));
  await js(`localStorage.setItem('anixart.pref.SELECTED_PLAYER', '2'); 1`);

  // 13. У 2-й серии осталась старая позиция 2:03 (смотрели раньше). «Продолжить · 1 серия» → «⏭ 2 серия» запускает
  // 2-ю с начала; закрыли в первые секунды (позиция пишется после 5 с) — «Продолжить» не должна звать на старые 2:03
  await js(`(async () => {
    const { db } = await import('/js/store.js');
    db.addLastWatched(${RID}, 1, ${kodik}, 1, { typeName: 'AniDUB', sourceName: 'Kodik' });
    db.putEpisode(${RID}, ${kodik}, 1, { isWatched: true, playbackPosition: 138000, duration: 1420000, endingStart: 0, finished: false });
    db.putEpisode(${RID}, ${kodik}, 2, { isWatched: true, playbackPosition: 123000, duration: 1420100, endingStart: 0, finished: false });
  })()`);
  await nav('release', `{ id: ${RID} }`); await settle(js, 6000);
  check('перед «⏭»: «Продолжить · 1 серия»', /Продолжить · 1 серия/.test(await text('.watch')), await text('.watch'));
  await click('.watch .btn-next');
  for (let i = 0; i < 60; i++) { await sleep(250); if (/2 серия/.test(await js(`document.querySelector('.player-top .p-eps .lbl')?.textContent || ''`))) break; }
  await sleep(800);
  await js(`document.querySelector('.player-top [title^="Закрыть"]').click(); 1`); await settle(js, 4000);
  const after13 = await text('.watch');
  check('после «⏭» и быстрого закрытия: «Продолжить · 2 серия» без старых 2:03', /Продолжить · 2 серия/.test(after13) && !/2:03/.test(after13) && !(await js(`!!${scr}.querySelector('.btn-watch.resume')`)), after13);
  check('1-я осталась досмотренной', await js(`import('/js/store.js').then(({ db }) => db.progress(${RID}, ${kodik}, 1)?.finished === true)`));

  // 14. Длинное аниме («Наруто», 220 серий): «Все серии» сразу показывают серию, на которой остановились
  const NAR = 609;
  const nar = await js(`(async () => {
    for (const ty of (await (await fetch('/api/episode/${NAR}')).json()).types) {
      const s = (await (await fetch('/api/episode/${NAR}/' + ty.id)).json()).sources.find((x) => x.episodes_count >= 200);
      if (s) return { typeId: ty.id, typeName: ty.name, sourceId: s.id, sourceName: s.name };
    }
  })()`);
  const visibleRow = async (n) => {
    let last = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const r = await js(`(() => { const s = ${scr}; if (s.dataset.screen !== 'episodes') return { screen: s.dataset.screen, rows: 0 }; if (!s.querySelector('.ep-row')) return { screen: 'episodes', rows: 0, text: s.innerText.slice(0, 120) }; const row = [...s.querySelectorAll('.ep-row')].find((x) => x.querySelector('.num')?.innerText.trim() === '${n}'); if (!row) return null; const b = row.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), vh: innerHeight, scroll: document.querySelector('#viewport').scrollTop }; })()`);
      last = r;
      if (r && r.scroll > 0 && r.top > 0 && r.bottom < r.vh) return r;
    }
    console.log('    видно:', JSON.stringify(last));
    return null;
  };
  // а) остановились на 150-й (своя история)
  await js(`(async () => {
    const { db } = await import('/js/store.js');
    db.addLastWatched(${NAR}, ${nar.typeId}, ${nar.sourceId}, 150, { typeName: ${JSON.stringify(nar.typeName)}, sourceName: ${JSON.stringify(nar.sourceName)} });
    for (let p = 1; p < 150; p++) db.putEpisode(${NAR}, ${nar.sourceId}, p, { isWatched: true, playbackPosition: -1 });
    db.putEpisode(${NAR}, ${nar.sourceId}, 150, { isWatched: true, playbackPosition: 300000, duration: 1380000 });
  })()`);
  await nav('release', `{ id: ${NAR} }`);
  // ждём, пока кнопка дорисуется по загруженному списку (блок перерисовывается — старая кнопка уходит со страницы)
  for (let i = 0; i < 60 && !/Продолжить · 150 серия/.test(await text('.watch')); i++) await sleep(250);
  await settle(js, 4000);
  await js(`[...${scr}.querySelectorAll('.watch .btn-tonal')].find((b) => b.innerText.includes('Все серии')).click(); 1`);
  const v150 = await visibleRow(150);
  check('«Наруто», 150-я начата: «Все серии» сразу на 150-й', !!v150, JSON.stringify(v150));
  // б) только отметки 1–149 (например, с сервера), последней серии нет — к первой непросмотренной
  await js(`(async () => {
    localStorage.removeItem('anixart.db.lastWatched'); localStorage.removeItem('anixart.db.choice');
    const { db } = await import('/js/store.js');
    db.setChoice(${NAR}, { typeId: ${nar.typeId}, sourceId: ${nar.sourceId}, typeName: ${JSON.stringify(nar.typeName)}, sourceName: ${JSON.stringify(nar.sourceName)} });
    db.putEpisode(${NAR}, ${nar.sourceId}, 150, { isWatched: false, playbackPosition: 0, duration: 0 });
  })()`);
  await nav('episodes', `{ release: { id: ${NAR}, title_ru: 'Наруто' } }`);
  const v150b = await visibleRow(150);
  check('только отметки 1–149: список сразу на 150-й', !!v150b, JSON.stringify(v150b));
  // в) с телефона: сервер знает серию, но не озвучку — «Продолжить» всё равно с неё
  const rem = await js(`import('/js/screens/episodes.js').then(({ resumeOf }) => resumeOf({ id: 424242, last_view_timestamp: 1e10, last_view_episode: { position: 150, source: 77 } }))`);
  check('серия с телефона без озвучки', rem && rem.target === 150 && rem.last.remote && rem.last.sourceId === 77, JSON.stringify(rem));

  // 15. «Пропускать филлеры» («Наруто»: 101–106 — филлеры): досмотрели 100-ю → «Смотреть 107 серию», в плеере
  // «следующая» со 100-й — сразу 107-я с уведомлением; выключили в шестерёнке — снова 101-я; переключатель в настройках
  await js(`(async () => {
    localStorage.setItem('anixart.pref.SKIP_FILLERS', 'true');
    const { db } = await import('/js/store.js');
    db.addLastWatched(${NAR}, ${nar.typeId}, ${nar.sourceId}, 100, { typeName: ${JSON.stringify(nar.typeName)}, sourceName: ${JSON.stringify(nar.sourceName)} });
    db.putEpisode(${NAR}, ${nar.sourceId}, 100, { isWatched: true, playbackPosition: -1 });
  })()`);
  await nav('release', `{ id: ${NAR} }`);
  for (let i = 0; i < 60 && !/107/.test(await text('.watch')); i++) await sleep(250);
  const fw = await text('.watch');
  check('филлеры: «Смотреть 107 серию» и «пропустим 6 филлеров»', /Смотреть 107 серию/.test(fw) && /пропустим 6 филлеров/.test(fw), fw);
  await settle(js, 3000);
  await js(`[...${scr}.querySelectorAll('.watch .btn-tonal')].find((b) => b.innerText.includes('Все серии')).click(); 1`);
  const v107 = await visibleRow(107);
  check('филлеры: в списке предлагается 107-я', !!v107 && await js(`${scr}.querySelector('.ep-row.current')?.dataset.pos === '107'`), JSON.stringify(v107));
  // плеер со 100-й → «следующая»
  await js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/${NAR}/${nar.typeId}/${nar.sourceId}?sort=1')).json();
    window.__p = openBuiltinPlayer({ release: { id: ${NAR}, title_ru: 'Наруто' }, episodes: r.episodes, index: r.episodes.findIndex((e) => e.position === 100), sort: 1, typeId: ${nar.typeId}, dub: ${JSON.stringify(nar.typeName)}, startAt: 0 });
  })()`);
  const epLbl = () => js(`document.querySelector('.player-top .p-eps .lbl')?.textContent || ''`);
  for (let i = 0; i < 60 && !/100 серия/.test(await epLbl()); i++) await sleep(250);
  await js(`document.querySelector('.player-controls [title^="Следующая серия"]').click(); 1`);
  let toastText = '';
  for (let i = 0; i < 60; i++) { await sleep(250); toastText = await js(`document.getElementById('toast')?.textContent || ''`); if (/107 серия/.test(await epLbl()) && /Пропущено/.test(toastText)) break; }
  check('филлеры: «следующая» со 100-й — 107-я', /107 серия/.test(await epLbl()), await epLbl());
  check('филлеры: уведомление в плеере', /Пропущено 6 филлеров — сейчас 107 серия/.test(toastText), toastText);
  // выключили в шестерёнке — со 107-й назад: «предыдущая» — 106-я (филлер, не пропускается)
  await js(`document.querySelector('.player-controls .gear').click(); 1`); await sleep(300);
  check('«Пропуски» в шестерёнке: «Филлеры»', /Пропуски\s*Филлеры/.test(await js(`[...document.querySelectorAll('.player-menu .pm-row')].find((x) => x.innerText.includes('Пропуски'))?.innerText || ''`)));
  await js(`[...document.querySelectorAll('.player-menu .pm-row')].find((x) => x.innerText.includes('Пропуски')).click(); 1`); await sleep(300);
  check('в «Пропусках» филлеры — первые', await js(`/Пропускать филлеры/.test(document.querySelector('.player-menu .pm-row')?.innerText || '')`));
  const swF = await js(`(() => { const l = [...document.querySelectorAll('.player-menu .pm-row')].find((x) => x.innerText.includes('Пропускать филлеры')); if (!l) return null; const cb = l.querySelector('input'); const was = cb.checked; cb.click(); return { was, now: cb.checked }; })()`);
  check('филлеры: переключатель в шестерёнке (был вкл.)', swF && swF.was === true && swF.now === false, JSON.stringify(swF));
  check('филлеры: выключен и в настройке', await js(`localStorage.getItem('anixart.pref.SKIP_FILLERS') === 'false'`));
  await js(`document.querySelector('.player-controls [title^="Предыдущая серия"]').click(); 1`);
  for (let i = 0; i < 60 && !/106 серия/.test(await epLbl()); i++) await sleep(250);
  check('филлеры выключены: «предыдущая» со 107-й — 106-я', /106 серия/.test(await epLbl()), await epLbl());
  await js(`window.__p?.close(); 1`);
  await nav('settings', `{ section: 'playback' }`); await sleep(800); // настройки по разделам: филлеры — в «Воспроизведении»
  check('филлеры: переключатель в настройках', await js(`[...document.querySelectorAll('.menu-item')].some((e) => e.textContent.includes('Пропускать филлеры'))`));

  // 16. Веб-плеер: кнопка «во весь экран» включает и выключает полноэкранный режим (раньше — только включала)
  await js(`import('/js/player.js').then(({ openWebPlayer }) => openWebPlayer({ url: 'about:blank', iframe: false, name: 'тест' }, { title_ru: 'Тест' }))`);
  await sleep(500);
  const fsBtn = `document.querySelector('.player-overlay .player-top button[title^="Во весь экран"]')`;
  await js(`${fsBtn}.click(); 1`); await sleep(1200);
  check('веб-плеер: во весь экран', await js(`!!document.fullscreenElement`));
  await js(`${fsBtn}.click(); 1`); await sleep(1200);
  check('веб-плеер: повторное нажатие — выход из полноэкранного', await js(`!document.fullscreenElement`));
  await js(`document.querySelector('.player-overlay .player-top button[title="Назад"]')?.click(); 1`);

  // 17. Качество: после серии Kodik (до 720p) серия Liberty (до 1080p) в том же плеере — в 1080p, а не «перетекшие» 720p;
  // выбранное вручную в меню держится на следующей серии. «Пожалуйста, простите моих младших братьев»: AniLiberty —
  // Kodik (412) и Liberty (413)
  const qOf = () => js(`(() => { const r = [...document.querySelectorAll('.player-menu .pm-row')].find((x) => x.innerText.includes('Качество')); return r ? r.querySelector('.val').innerText : null; })()`);
  const openGear = async () => { await js(`document.querySelector('.player-menu') || document.querySelector('.player-controls .gear').click(); 1`); await sleep(300); };
  const closeGear = () => js(`document.querySelector('.player-menu') && document.querySelector('.player-controls .gear').click(); 1`);
  const waitReady = async (pos) => { for (let i = 0; i < 40; i++) { await sleep(250); if (await js(`(document.querySelector('.player-overlay video')?.readyState || 0) >= 1 && /${pos} серия/.test(document.querySelector('.player-top .p-eps .lbl')?.textContent || '')`)) return true; } return false; };
  await js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/20592/365/412?sort=1')).json();
    window.__q = openBuiltinPlayer({ release: { id: 20592, title_ru: 'Братья' }, episodes: r.episodes, index: 0, sort: 1, typeId: 365, dub: 'AniLiberty', startAt: 0 });
  })()`);
  await waitReady(1); await openGear();
  const qKodik = await qOf(); await closeGear();
  await js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/20592/365/413?sort=1')).json();
    openBuiltinPlayer({ release: { id: 20592, title_ru: 'Братья' }, episodes: r.episodes, index: 1, sort: 1, typeId: 365, dub: 'AniLiberty', startAt: 0 });
  })()`);
  await waitReady(2); await openGear();
  const qLib = await qOf();
  check('качество: Kodik — 720p, затем Liberty в том же плеере — 1080p', qKodik === '720p' && qLib === '1080p', `${qKodik} → ${qLib}`);
  // вручную 480p → следующая серия тоже в 480p
  await js(`[...document.querySelectorAll('.player-menu .pm-row')].find((x) => x.innerText.includes('Качество')).click(); 1`); await sleep(300);
  await js(`[...document.querySelectorAll('.player-menu .pm-opt')].find((x) => x.innerText.trim() === '480p').click(); 1`); await sleep(500);
  await js(`document.querySelector('.player-controls [title^="Следующая серия"]').click(); 1`);
  await waitReady(3); await openGear();
  check('качество: выбранное вручную (480p) — и на следующей серии', (await qOf()) === '480p', await qOf());
  await closeGear(); await js(`window.__q?.close(); 1`);

  // 18. Видео аниме в сетке (раздел с категорией): карточки не налезают друг на друга (раньше — фиксированные 260px
  // в колонках по 150px, карточки и подписи накладывались)
  const vcat = await js(`fetch('/api/video/release/20592').then((r) => r.json()).then((j) => { const b = (j.blocks || []).find((x) => x.category); return b && { id: b.category.id, name: b.category.name }; })`);
  await nav('release-videos', `{ release: { id: 20592 }, categoryId: ${vcat.id}, categoryName: ${JSON.stringify(vcat.name)} }`);
  for (let i = 0; i < 40 && !(await js(`${scr}.querySelectorAll('.grid .release-card').length > 3 && !${scr}.querySelector('.sk-root')`)); i++) await sleep(250);
  const vres = await js(`(() => {
    const cards = [...${scr}.querySelectorAll('.grid .release-card')].map((c) => c.getBoundingClientRect());
    let overlaps = 0;
    for (let i = 0; i < cards.length; i++) for (let k = i + 1; k < cards.length; k++) {
      const a = cards[i]; const b = cards[k];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++;
    }
    return { cards: cards.length, overlaps };
  })()`);
  check(`видео в сетке «${vcat.name}» не налезают`, vres.cards > 3 && vres.overlaps === 0, JSON.stringify(vres));
  // значок хостинга (YouTube — на imgur, с чужим Referer отвечает 403) загрузился
  let icons = null;
  for (let i = 0; i < 20; i++) { await sleep(250); icons = await js(`(() => { const im = [...${scr}.querySelectorAll('.grid .release-card .poster > img:not(:first-child)')]; return { all: im.length, ok: im.filter((x) => x.complete && x.naturalWidth > 0).length, done: im.every((x) => x.complete) }; })()`); if (icons.done) break; }
  check('значки хостинга на карточках видео загрузились', icons.all > 0 && icons.ok === icons.all, JSON.stringify(icons));

  // 19. Плитки видео на странице аниме («Трейлеры», «Превью») ведут к видео — курсор-указатель, а не лупа кадров
  await nav('release', `{ id: 20643 }`);
  for (let i = 0; i < 60 && !(await js(`!!${scr}.querySelector('.screens .vb img') && ${scr}.querySelectorAll('.screens img').length > 3`)); i++) await sleep(250);
  const curs = await js(`(() => { const v = ${scr}.querySelector('.screens .vb img'); const s = [...${scr}.querySelectorAll('.screens img')].find((x) => !x.closest('.vb')); return { tile: v && getComputedStyle(v).cursor, shot: s && getComputedStyle(s).cursor }; })()`);
  check('плитки видео — указатель, кадры — лупа', curs.tile === 'pointer' && curs.shot === 'zoom-in', JSON.stringify(curs));

  // 20. Просмотр кадров: с 3-го — «3 / 8», крупнее исходника (600px), но не больше вдвое; → — «4 / 8», миниатюра
  // отмечена; Esc закрывает только просмотр; постер — одна картинка, без стрелок и счётчика
  await js(`[...${scr}.querySelectorAll('.screens > img')][2].click(); 1`);
  for (let i = 0; i < 40 && !(await js(`(document.querySelector('.iv-img')?.naturalWidth || 0) > 0`)); i++) await sleep(150);
  await sleep(300);
  const iv1 = await js(`(() => { const im = document.querySelector('.iv-img'); const r = im.getBoundingClientRect(); return { count: document.querySelector('.iv-count')?.innerText, w: Math.round(r.width), nat: im.naturalWidth, title: document.querySelector('.iv-title b')?.innerText }; })()`);
  const total = await js(`${scr}.querySelectorAll('.screens > img').length`);
  check('кадры: открыт 3-й, счётчик', iv1.count === `3 / ${total}` && iv1.title === 'Свадьба светлячков', JSON.stringify(iv1));
  check('кадры: крупнее исходника, но не больше вдвое', iv1.w > iv1.nat && iv1.w <= iv1.nat * 2, JSON.stringify(iv1));
  fs.writeFileSync(path.join(outDir, 'watch-12-viewer.png'), (await win.webContents.capturePage()).toPNG());
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); 1`); await sleep(300);
  const iv2 = await js(`({ count: document.querySelector('.iv-count')?.innerText, on: [...document.querySelectorAll('.iv-thumb')].findIndex((t) => t.classList.contains('on')) })`);
  check('кадры: → листает, миниатюра отмечена', iv2.count === `4 / ${total}` && iv2.on === 3, JSON.stringify(iv2));
  // одинарный клик по картинке — ×2, ещё клик — обратно; просмотр не закрывается
  const clickAt = async () => {
    const r = await js(`(() => { const b = document.querySelector('.iv-img').getBoundingClientRect(); return { x: Math.round(b.left + b.width * 0.3), y: Math.round(b.top + b.height * 0.4) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(400);
    return js(`({ zoomed: document.querySelector('.iv').classList.contains('zoomed'), tr: document.querySelector('.iv-img').style.transform, open: !!document.querySelector('.iv') })`);
  };
  const z1 = await clickAt();
  check('кадры: клик по картинке — увеличение ×2 к месту клика', z1.open && z1.zoomed && /scale\(2\)/.test(z1.tr) && /translate\((?!0px, 0px)/.test(z1.tr), JSON.stringify(z1));
  const z2 = await clickAt();
  check('кадры: ещё клик — обратно, просмотр открыт', z2.open && !z2.zoomed, JSON.stringify(z2));
  await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`); await sleep(400);
  check('кадры: Esc закрыл только просмотр', !(await js(`!!document.querySelector('.iv')`)) && await js(`${scr}.dataset.screen === 'release'`));
  await js(`${scr}.querySelector('.rel-hero .poster').click(); 1`); await sleep(500);
  const iv3 = await js(`({ open: !!document.querySelector('.iv'), nav: document.querySelectorAll('.iv-nav').length, count: !!document.querySelector('.iv-count'), thumbs: !!document.querySelector('.iv-thumbs') })`);
  check('постер: одна картинка, без стрелок, счётчика и миниатюр', iv3.open && !iv3.nav && !iv3.count && !iv3.thumbs, JSON.stringify(iv3));
  await js(`document.querySelector('.iv-stage').click(); 1`); await sleep(400);
  check('клик мимо картинки закрывает', !(await js(`!!document.querySelector('.iv')`)));

  // 21. Анонс без серий (у сервера is_play_disabled): на странице — «Анонс», а не «Недоступно»
  await nav('release', `{ id: 20752 }`);
  for (let i = 0; i < 40 && !(await js(`/Приговор/.test(${scr}.querySelector('.rel-title')?.innerText || '')`)); i++) await sleep(250); // новый экран, а не прежний
  const anons = await js(`${scr}.querySelector('.rel-hero .head').innerText`);
  check('анонс: «Анонс», не «Недоступно»', /Анонс/.test(anons) && !/Недоступно/.test(anons), anons.split('\n').filter((l) => /Анонс|Недоступно/.test(l)).join(' | '));

  // 22. Шапка аниме со светлым постером (тёмная тема): кнопки и бейджи на плотной подложке — скриншот для глаз
  await js(`localStorage.setItem('anixart.theme', 'dark'); import('/js/store.js').then((m) => m.applyTheme())`); await sleep(400);
  fs.writeFileSync(path.join(outDir, 'watch-13-hero-light-poster.png'), (await win.webContents.capturePage()).toPNG());
  // подложка плотная, без размытия: backdrop-filter под экраном с въездом после анимации менял цвет (CLAUDE.md)
  const heroBg = await js(`(() => { const b = ${scr}.querySelector('.rel-hero .list-btn:not(.tag)'); if (!b) return null; const cs = getComputedStyle(b); const c = cs.backgroundColor; const alpha = c.includes('/') ? parseFloat(c.split('/')[1]) : c.startsWith('rgba') ? parseFloat(c.split(',')[3]) : 1; return { blur: cs.backdropFilter, alpha, c }; })()`);
  check('шапка: кнопки на плотной подложке, без размытия', !!heroBg && heroBg.blur === 'none' && heroBg.alpha >= 0.5, JSON.stringify(heroBg));

  // 23. Написать комментарий — над комментариями: на странице аниме и на экране «Комментарии»
  const above = (sel) => js(`(() => { const s = ${scr}; const c = s.querySelector('${sel} .comment-input'); const first = s.querySelector('${sel} .comment'); return !!c && (!first || !!(c.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)); })()`);
  await nav('release', `{ id: 20643 }`);
  for (let i = 0; i < 60 && !(await js(`/Свадьба/.test(${scr}.querySelector('.rel-title')?.innerText || '') && !!${scr}.querySelector('.comment-input')`)); i++) await sleep(250);
  check('страница аниме: «Ваш комментарий» над комментариями', await above(''));
  await nav('comments', `{ kind: 'release', id: 20643 }`);
  for (let i = 0; i < 60 && !(await js(`${scr}.dataset.screen === 'comments' && !!${scr}.querySelector('.comment') && !${scr}.querySelector('.sk-root')`)); i++) await sleep(250);
  check('«Комментарии»: поле ввода вверху, над списком', await above(''));

  // 24. Видео не с YouTube, закрытые для страны (Sibnet вне России отвечает 403): вместо сломанного превью — название
  // сайта, по клику — объяснение, а не белая страница «403 Forbidden». YouTube открывается как раньше
  const opCat = await js(`fetch('/api/video/release/609').then((r) => r.json()).then((j) => { const b = (j.blocks || []).find((x) => /Опенинг/i.test(x.category?.name || '')); return b && b.category.id; })`);
  await nav('release-videos', `{ release: { id: 609 }, categoryId: ${opCat}, categoryName: 'Опенинги' }`);
  for (let i = 0; i < 60 && !(await js(`${scr}.querySelectorAll('.grid .release-card').length > 10 && !${scr}.querySelector('.sk-root')`)); i++) await sleep(250);
  await sleep(2500); // превью догружаются (или не загружаются)
  const sib = await js(`(() => { const c = [...${scr}.querySelectorAll('.grid .vid-poster')].find((p) => /sibnet/i.test(p.dataset.host || '')); return c && { host: c.dataset.host, failed: !!c.querySelector('img.noimg') }; })()`);
  const sibProbe = await js(`fetch('/probe?url=' + encodeURIComponent('http://video.sibnet.ru/shell.php?videoid=4528815')).then((r) => r.json())`);
  if (sibProbe.status === 403) {
    check('Sibnet: вместо сломанного превью — «sibnet.ru»', !!sib && sib.failed && sib.host === 'sibnet.ru', JSON.stringify(sib));
    await js(`[...${scr}.querySelectorAll('.grid .release-card')].find((c) => /sibnet/i.test(c.querySelector('.vid-poster')?.dataset.host || '')).click(); 1`);
    for (let i = 0; i < 40 && !(await js(`!!document.querySelector('.backdrop .dialog')`)); i++) await sleep(250);
    const dlg = await js(`({ text: document.querySelector('.backdrop .dialog')?.innerText || '', player: !!document.querySelector('.player-overlay') })`);
    check('Sibnet: по клику — объяснение, плеер не открыт', /не пускает из вашей страны/.test(dlg.text) && !dlg.player, JSON.stringify(dlg).slice(0, 160));
    await js(`document.querySelectorAll('.backdrop').forEach((b) => b.remove()); 1`);
  } else console.log(`     (Sibnet доступен из этой сети: ${sibProbe.status} — проверка закрытого сайта пропущена)`);
  await js(`[...${scr}.querySelectorAll('.grid .release-card')].find((c) => /YouTube/.test(c.querySelector('.vid-poster')?.dataset.host || '')).click(); 1`);
  for (let i = 0; i < 20 && !(await js(`!!document.querySelector('.player-overlay iframe')`)); i++) await sleep(250);
  check('YouTube: открылся веб-плеер', await js(`!!document.querySelector('.player-overlay iframe') && !document.querySelector('.backdrop .dialog')`));
  await js(`document.querySelector('.player-overlay .player-top button[title="Назад"]')?.click(); 1`);

  // 25. «Вы не вошли в аккаунт» (закладки) и «Сначала войдите в Anixart» (AI) — посередине экрана по вертикали
  const gateMid = async (tabName) => {
    await js(`import('/js/router.js').then((r) => r.switchTab('${tabName}'))`);
    for (let i = 0; i < 40 && !(await js(`!!document.querySelector('#viewport .screen:last-child .center-gate')`)); i++) await sleep(250);
    await sleep(300);
    return js(`(() => { const g = document.querySelector('#viewport .screen:last-child .center-gate'); if (!g) return null; const kids = [...g.children].map((c) => c.getBoundingClientRect()); const top = Math.min(...kids.map((r) => r.top)); const bottom = Math.max(...kids.map((r) => r.bottom)); const vp = document.querySelector('#viewport').getBoundingClientRect(); return { mid: Math.round((top + bottom) / 2), vpMid: Math.round((vp.top + vp.bottom) / 2), vh: Math.round(vp.height) }; })()`);
  };
  for (const tabName of ['bookmarks', 'ai']) {
    const g = await gateMid(tabName);
    // оптический центр — чуть выше середины (centerEmpties в ui.js, CLAUDE.md)
    check(`«${tabName}» без входа: блок посередине по вертикали (чуть выше)`, !!g && g.vpMid - g.mid >= 0 && g.vpMid - g.mid < g.vh * 0.08, JSON.stringify(g));
    if (tabName === 'bookmarks') {
      const lc = await js(`(() => { const i = document.querySelector('#viewport .screen:last-child .center-gate .ic.brand'); const t = document.createElement('div'); t.style.color = 'var(--carmine)'; document.body.append(t); const want = getComputedStyle(t).color; t.remove(); return { got: i && getComputedStyle(i).color, want }; })()`);
      check('«Вы не вошли»: логотип фирменного цвета, не серый', lc.got && lc.got === lc.want, JSON.stringify(lc));
    }
  }
  await js(`import('/js/router.js').then((r) => r.switchTab('home'))`);

  console.log(`\nFAILED: ${fails.length ? fails.join('; ') : 'none'}`);
  console.log('ERRORS:', errors.length ? `\n${errors.join('\n')}` : 'none');
  srv.server.close();
  app.exit(fails.length || errors.length ? 1 : 0);
});
