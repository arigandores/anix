'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Своя шапка окна (electron/main.js, js/titlebar.js). Обычный экран: кнопки окна — в строке шапки экрана (63 px),
// у шапки справа место под них, за её пустое место и название окно перетаскивают, а всё нажимаемое в ней —
// нажимается (кнопки, поиск, и не кнопки тоже); боковая панель и логотип — до верха. Диалог: кнопки окна темнеют,
// шапка и логотип окно не тянут. Просмотр картинки и плеер: полоса 32 px их цвета над ними, на всю ширину, сами —
// под ней, логотип под «Назад» плеера окно не тянет. Мини-плеер — снова в строке шапки. Во весь экран места под
// кнопки нет. Узкое окно — полоса 32 px. Тёмная и светлая тема. Окно без своей шапки (браузер, тесты) — как раньше.
// Цвета и высота кнопок окна — по вызовам titlebar-colors.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (js, cond, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(cond)) return true; await sleep(150); } return false; };

const calls = []; // цвета и высота системных кнопок окна, которые просила страница
ipcMain.handle('titlebar-colors', (_e, o) => { calls.push(o); return true; });
app.on('window-all-closed', () => {}); // окна закрываем сами — тест идёт дальше, а не завершается молча

app.whenReady().then(async () => {
  const srv = await start(0);
  const fails = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
  const make = (titlebar) => new BrowserWindow({ width: 1280, height: 800, show: false,
    webPreferences: { offscreen: true, partition: titlebar ? undefined : 'titlebar-plain', sandbox: true, contextIsolation: true, preload: path.join(ROOT, 'electron', 'preload.js'),
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required', additionalArguments: titlebar ? ['--anix-titlebar'] : [] } });
  const win = make(true);
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`localStorage.clear(); localStorage.setItem('anixart.theme','dark'); localStorage.setItem('anixart.pref.SELECTED_PLAYER','2'); localStorage.setItem('anixart.pref.ON_EPISODE_DISCLAIMER','true'); 1`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await until(js, '!!document.querySelector("#viewport > .screen:last-child .appbar")', 8000);
  const geo = () => js(`(() => {
    const r = (s) => { const e = typeof s === 'string' ? document.querySelector(s) : s; if (!e || !e.offsetParent && getComputedStyle(e).position !== 'fixed') return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
    const reg = (e) => { if (!e) return null; const c = getComputedStyle(e); return c.appRegion || c.webkitAppRegion; };
    const tb = document.getElementById('titlebar'); const bar = document.querySelector('#viewport > .screen:last-child .appbar');
    // нажимаемое в шапке: кнопки, поле, поиск, картинки и всё с курсором-рукой — не должно тянуть окно
    const press = bar ? [...bar.querySelectorAll('*')].filter((e) => e.matches('button, a, input, img, .searchbar') || getComputedStyle(e).cursor === 'pointer') : [];
    return { tb: getComputedStyle(tb).display === 'none' ? null : r(tb), bg: getComputedStyle(tb).backgroundColor, drag: reg(tb), logoDrag: reg(document.querySelector('#rail .logo')),
      bar: bar && { ...r(bar), pr: parseFloat(getComputedStyle(bar).paddingRight), cr: Math.round(innerWidth - bar.getBoundingClientRect().right + parseFloat(getComputedStyle(bar).paddingRight)), sep: getComputedStyle(bar, '::after').content !== 'none' && getComputedStyle(bar, '::after').height, endsWithButtons: !!bar.lastElementChild && [bar.lastElementChild, ...bar.lastElementChild.querySelectorAll('button')].some((b) => b.matches('button') && b.getClientRects().length > 0), drag: reg(bar), title: reg(bar.querySelector('.title, .grow')), press: press.length, pressDrag: press.filter((e) => reg(e) !== 'no-drag').map((e) => e.className || e.tagName) },
      // что видно под кнопками окна (138 px + разделитель справа, высотой в шапку) — кроме самой шапки и её обёрток
      under: (() => { const zh = document.documentElement.classList.contains('tb-inline') ? 64 : 0; if (!zh) return [];
        // видимая часть: обрезанное родителем (overflow: hidden — фон героя страницы аниме на 40 px шире блока) не в счёт
        const seen = (e) => { const b = e.getBoundingClientRect(); let t = b.top; let bt = b.bottom; let l = b.left; let rt = b.right;
          for (let p = e.parentElement; p && p.id !== 'viewport'; p = p.parentElement) { if (getComputedStyle(p).overflow === 'visible') continue; const q = p.getBoundingClientRect(); t = Math.max(t, q.top); bt = Math.min(bt, q.bottom); l = Math.max(l, q.left); rt = Math.min(rt, q.right); }
          return { t, bt, l, rt }; };
        return [...document.querySelectorAll('#viewport *')].filter((e) => { if (bar && (e === bar || e.contains(bar))) return false; const v = seen(e);
          return v.rt > v.l && v.bt > v.t && v.rt > innerWidth - 147 && v.t < zh && v.bt > 0 && getComputedStyle(e).visibility !== 'hidden'; }).slice(0, 4).map((e) => e.className || e.tagName); })(),
      viewport: r('#viewport'), rail: r('#rail'), player: r('.player-overlay'), iv: r('.iv'), cls: document.documentElement.className, H: innerHeight, W: innerWidth }; })()`);
  const lastCall = () => calls[calls.length - 1] || {};
  const callIs = async (color, symbolColor, height) => { for (let i = 0; i < 20; i++) { const c = lastCall(); if (c.color === color && c.symbolColor === symbolColor && c.height === height) return true; await sleep(100); } return false; };
  // cr — от края окна до значков шапки: кнопки окна (138) + разделитель + 8 px, на любом экране одинаково (длинном и коротком)
  // sep — разделитель перед кнопками окна: есть, только если справа в шапке свои кнопки
  const inlineOk = (g) => g.tb && g.tb.h === 0 && g.viewport.t === 0 && g.bar && g.bar.t === 0 && g.bar.h === 64 && g.bar.cr === 138 + 9 && g.bar.sep === (g.bar.endsWithButtons ? '24px' : false);

  // обычный экран, тёмная тема: кнопки окна — в строке шапки экрана
  let g = await geo();
  check(/\btb-inline\b/.test(g.cls) && inlineOk(g) && g.rail.t === 0 && g.rail.h === g.H && await callIs('#121212', '#9e9e9e', 63),
    `главная: кнопки окна в строке шапки (${JSON.stringify(lastCall())}), шапка от верха (${JSON.stringify(g.bar)}), отдельной полосы нет (${g.tb && g.tb.h}), боковая панель до верха`);
  check(g.bar.drag === 'drag' && g.bar.title !== 'no-drag' && g.logoDrag === 'drag', `за пустое место шапки, название и логотип окно перетаскивается (${g.bar.drag}, ${g.bar.title}, ${g.logoDrag})`);
  check(g.bar.press > 0 && !g.bar.pressDrag.length, `всё нажимаемое в шапке нажимается, а не тянет окно: ${g.bar.press} шт., тянут ${JSON.stringify(g.bar.pressDrag)}`);
  // шапки других экранов: AI, профиль, закладки
  // без входа «Профиль», «Закладки», «Лента», AI — заглушка «Войдите» без шапки: тогда полоса 32 px, за неё и тянут
  for (const tab of ['discover', 'ai', 'profile', 'bookmarks', 'feed']) {
    await js(`(async () => (await import('/js/router.js')).switchTab('${tab}'))(); 1`);
    await sleep(1200); g = await geo();
    if (g.bar) check(inlineOk(g) && g.bar.drag === 'drag' && !g.bar.pressDrag.length && lastCall().height === 63, `вкладка ${tab}: шапка от верха с местом под кнопки окна (${JSON.stringify(g.bar)})`);
    else check(g.tb && g.tb.h === 32 && g.viewport.t === 32 && g.drag === 'drag' && lastCall().height === 32, `вкладка ${tab} без шапки экрана: полоса 32 px (${JSON.stringify(g.tb)}), экран под ней (${g.viewport.t}), кнопки окна ${JSON.stringify(lastCall())}`);
  }
  await js(`(async () => (await import('/js/router.js')).switchTab('home'))(); 1`); await sleep(400);
  // все экраны (как в transitions-audit): шапка от верха, значки в одном месте от края окна (и на коротких экранах
  // без полосы прокрутки), разделитель — только когда справа видна своя кнопка (у «Назад + название» и у шапок,
  // где справа лишь скрытая «Смотреть вместе», его нет), под кнопками окна ничего, всё нажимаемое в шапке нажимается;
  // экран без шапки — полоса 32 px
  const SCREENS = [
    ['release', '{ id: 40 }'], ['search', '{ query: "Мастер Муси" }'], ['profile', '{ id: 1 }'], ['profile-lists', '{ profile: { id: 1 } }'],
    ['profile-comments', '{ profile: { id: 1 } }'], ['profile-votes', '{ profile: { id: 1 } }'], ['friends', '{ profile: { id: 1 } }'],
    ['profile-collections', '{ profileId: 1 }'], ['collections', '{}'], ['top', '{}'], ['watching', '{}'], ['recommendations', '{}'],
    ['schedule', '{}'], ['notifications', '{}'], ['settings', '{}'], ['filter', '{}'], ['channels', '{}'],
    ['comments', '{ kind: "release", id: 40 }'], ['release-collections', '{ release: { id: 40 } }'], ['feed-search', '{}'],
    ['auth', '{}'], ['signup', '{}'], ['restore', '{}'],
  ];
  const cid = await js(`import('/js/api.js').then((m) => m.A.releaseCollections(40, 0, 1)).then((r) => r.content?.[0]?.id ?? null).catch(() => null)`);
  if (cid) SCREENS.push(['collection', `{ id: ${cid} }`]);
  let seps = 0; let noSeps = 0;
  for (const [n, p] of SCREENS) {
    await js(`import('/js/router.js').then((m) => m.navigate('${n}', ${p})); 1`);
    await until(js, `!document.querySelector('#viewport > .screen:last-child .sk-root, #viewport > .screen:last-child .skeleton')`, 6000); await sleep(500);
    g = await geo();
    const scrolls = await js(`(() => { const v = document.getElementById('viewport'); return v.scrollHeight > v.clientHeight; })()`);
    if (g.bar) {
      if (g.bar.endsWithButtons) seps++; else noSeps++;
      check(inlineOk(g) && !g.under.length && !g.bar.pressDrag.length && lastCall().height === 63,
        `${n}: шапка ${g.bar.t}/${g.bar.h}, значки в ${g.bar.cr} px от края окна (прокрутка: ${scrolls}), разделитель ${g.bar.sep || 'нет'} (кнопки справа: ${g.bar.endsWithButtons}), под кнопками окна ${JSON.stringify(g.under)}, тянут окно ${JSON.stringify(g.bar.pressDrag)}`);
    } else check(g.tb && g.tb.h === 32 && g.viewport.t === 32 && lastCall().height === 32, `${n} без шапки экрана: полоса 32 px (${JSON.stringify(g.tb)}), экран под ней (${g.viewport.t})`);
    await js(`history.back(); 1`); await sleep(500);
  }
  check(seps > 0 && noSeps > 0, `экраны с разделителем (${seps}) и без него (${noSeps}) — оба вида проверены`);

  // диалог: кнопки окна темнеют, как экран под затемнением; шапка и логотип окно не тянут; закрыли — обратно
  await js(`(async () => { const { dialog } = await import('/js/ui.js'); window.__dlg = dialog({ title: 'Проверка', actions: [{ label: 'OK' }] }); })(); 1`);
  check(await callIs('#0a0a0a', '#575757', 63), `открыт диалог — кнопки окна затемнены: ${JSON.stringify(lastCall())}`);
  g = await geo();
  check(g.logoDrag !== 'drag' && g.bar.drag !== 'drag', `под диалогом шапка и логотип окно не тянут (${g.bar.drag}, ${g.logoDrag})`);
  await js(`window.__dlg.close(); 1`);
  check(await callIs('#121212', '#9e9e9e', 63), `диалог закрыт — кнопки окна снова цвета экрана: ${JSON.stringify(lastCall())}`);

  // светлая тема
  await js(`localStorage.setItem('anixart.theme','light'); (async () => (await import('/js/store.js')).applyTheme())(); 1`);
  check(await callIs('#ffffff', '#616161', 63), `светлая тема: кнопки окна ${JSON.stringify(lastCall())}`);

  // просмотр картинки: полоса 32 px его цвета на всю ширину, сам — под ней
  await js(`(async () => { (await import('/js/screens/common.js')).imageViewer('/icon.png'); })(); 1`);
  await until(js, '!!document.querySelector(".iv")', 3000); await sleep(200); g = await geo();
  check(g.iv && g.iv.t === 32 && g.tb.l === 0 && g.tb.w === g.W && g.tb.h === 32 && await callIs('#09090b', '#9e9e9e', 32), `просмотр картинки: под полосой (${g.iv && g.iv.t}), полоса на всю ширину (${JSON.stringify(g.tb)}), кнопки окна ${JSON.stringify(lastCall())}`);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  await until(js, '!document.querySelector(".iv")', 3000);
  check(await callIs('#ffffff', '#616161', 63), `просмотр закрыт — кнопки окна снова в строке шапки: ${JSON.stringify(lastCall())}`);
  await js(`localStorage.setItem('anixart.theme','dark'); (async () => (await import('/js/store.js')).applyTheme())(); 1`);

  // плеер: полоса 32 px чёрная на всю ширину, плеер — под ней; мини-плеер — кнопки снова в строке шапки
  await js(`(async () => { const { A } = await import('/js/api.js');
    const types = (await A.types(2487)).types; const ty = types.find((x) => x.name === 'Studio Band') || types[0];
    const so = (await A.sources(2487, ty.id)).sources.find((s) => /kodik/i.test(s.name));
    (await import('/js/router.js')).navigate('episodes', { release: { id: 2487, title_ru: 'Атака титанов 3' }, type: ty, source: so }); })(); 1`);
  if (await until(js, `[...document.querySelectorAll('#viewport .screen:last-child .ep-row')].some((r) => !r.closest('.skeleton, .sk-root'))`, 15000)) {
    g = await geo();
    check(inlineOk(g) && !g.bar.pressDrag.length, `список серий: шапка с «Назад» и названием — в строке с кнопками окна (${JSON.stringify(g.bar)})`);
    await js(`[...document.querySelectorAll('#viewport .screen:last-child .ep-row')].find((r) => !r.closest('.skeleton, .sk-root')).click(); 1`);
    await until(js, `(document.querySelectorAll('.backdrop').forEach((b) => b.querySelector('.sheet-item')?.click()), !!document.querySelector('.player-overlay'))`, 15000);
    await sleep(300); g = await geo();
    check(g.player && g.player.t === 32 && g.player.h === g.H - 32 && g.tb.l === 0 && g.tb.h === 32 && g.bg === 'rgb(0, 0, 0)' && await callIs('#000000', '#9e9e9e', 32), `плеер: под полосой (${JSON.stringify(g.player)}), полоса чёрная на всю ширину (${JSON.stringify(g.tb)}, ${g.bg}), кнопки окна ${JSON.stringify(lastCall())}`);
    // область перетаскивания Windows ловит нажатия поверх страницы: логотип под «Назад» плеера тянул окно
    check(g.logoDrag !== 'drag' && g.drag === 'drag', `в плеере логотип под «Назад» окно не тянет (${g.logoDrag}), полоса — тянет (${g.drag})`);
    await js(`document.querySelector('.player-overlay').mini(true); 1`);
    await sleep(200); g = await geo();
    check(inlineOk(g) && await callIs('#121212', '#9e9e9e', 63), `мини-плеер: кнопки окна снова в строке шапки (${JSON.stringify(lastCall())}, шапка ${JSON.stringify(g.bar)})`);
    await js(`document.querySelector('.player-overlay').mini(false); 1`);
    check(await callIs('#000000', '#9e9e9e', 32), `развернули — снова чёрная полоса: ${JSON.stringify(lastCall())}`);
    win.webContents.send('fullscreen', true); await sleep(200); g = await geo();
    check(/\bfs\b/.test(g.cls) && g.tb.h === 0 && g.player.t === 0 && g.player.h === g.H, `во весь экран места под кнопки нет: полоса ${g.tb.h}, плеер ${JSON.stringify(g.player)}`);
    win.webContents.send('fullscreen', false); await sleep(200); g = await geo();
    check(!/\bfs\b/.test(g.cls) && g.tb.h === 32 && g.player.t === 32, `вышли из полного экрана — полоса снова есть (${g.tb.h}, плеер ${g.player.t})`);
    await js(`document.querySelector('.player-overlay').mini(true); 1`);
    await js(`document.querySelector('.mini-bar [title="Закрыть"]').click(); 1`);
    await until(js, '!document.querySelector(".player-overlay")', 4000);
    g = await geo();
    check(inlineOk(g) && await callIs('#121212', '#9e9e9e', 63), `плеер закрыт — кнопки окна снова в строке шапки: ${JSON.stringify(lastCall())}`);
  } else check(false, 'список серий открылся');

  // узкое окно: боковой панели нет, шапке не хватает ширины — полоса 32 px на всю ширину
  win.setSize(600, 800); await sleep(400); g = await geo();
  check(g.tb.l === 0 && g.tb.w === g.W && g.tb.h === 32 && g.viewport.t === 32 && g.bar.pr < 40 && await callIs('#121212', '#9e9e9e', 32), `узкое окно: полоса на всю ширину (${JSON.stringify(g.tb)}), экран под ней (${g.viewport.t}), кнопки окна ${JSON.stringify(lastCall())}`);
  win.setSize(1280, 800); await sleep(400); g = await geo();
  check(inlineOk(g) && await callIs('#121212', '#9e9e9e', 63), `окно снова широкое — кнопки окна в строке шапки (${JSON.stringify(lastCall())})`);
  win.destroy();
  await sleep(300);

  // окно без своей шапки (браузер, тесты): ничего не меняется
  const plain = make(false);
  await plain.loadURL(srv.url);
  const pj = (c) => plain.webContents.executeJavaScript(c, true);
  await until(pj, '!!document.querySelector("#viewport .appbar")', 8000);
  const p = await pj(`(() => { const b = document.querySelector('#viewport .appbar'); const c = getComputedStyle(b); return { cls: document.documentElement.className, tb: getComputedStyle(document.getElementById('titlebar')).display, top: Math.round(document.getElementById('viewport').getBoundingClientRect().top), pr: parseFloat(c.paddingRight), drag: c.appRegion || c.webkitAppRegion }; })()`);
  check(!/\btb\b/.test(p.cls) && p.tb === 'none' && p.top === 0 && p.pr === 12 && p.drag !== 'drag', `без своей шапки — как раньше: ${JSON.stringify(p)}`);
  srv.server.close();
  app.exit(fails.length ? 1 : 0);
});
