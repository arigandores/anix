'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Экран серий: чипы озвучки, источника и плеера прилипают под шапкой — прокрутили список вниз, они на месте,
// поверх строк (строки уходят под них) и нажимаются (открывается выбор озвучки). Узкое окно — тоже, одной строкой
// с прокруткой вбок (а не в три строки), последний чип достаётся и нажимается. Тёмная и светлая тема: фон чипов —
// фон экрана.
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');
const RID = 21; // «Мастер Муси»: 26 серий
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const srv = await start(0);
  const fails = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
  const win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const scr = `document.querySelector('#viewport > .screen:last-child')`;
  for (const theme of ['dark', 'light']) {
    await js(`localStorage.clear(); localStorage.setItem('anixart.theme','${theme}'); 1`);
    await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
    await settle(js, 6000);
    // озвучка с Kodik запомнена — экран серий сразу с чипами и списком
    const ok = await js(`(async () => {
      const { A } = await import('/js/api.js'); const { db } = await import('/js/store.js');
      for (const ty of (await A.types(${RID})).types) {
        const so = (await A.sources(${RID}, ty.id)).sources.find((s) => /kodik/i.test(s.name));
        if (so) { db.setChoice(${RID}, { typeId: ty.id, sourceId: so.id, typeName: ty.name, sourceName: so.name }); return true; }
      }
      return false;
    })()`);
    if (!ok) { check(false, 'нашлась озвучка с Kodik'); break; }
    await js(`import('/js/router.js').then((m) => m.navigate('episodes', { release: { id: ${RID}, title_ru: 'Мастер Муси' } })); 1`);
    for (let i = 0; i < 60 && !(await js(`${scr}.querySelectorAll('.ep-row').length > 20 && !${scr}.querySelector('.sk-root')`)); i++) await sleep(250);
    await sleep(800);
    const at = () => js(`(() => {
      const c = ${scr}.querySelector('.wchips'); const b = c.getBoundingClientRect(); const bar = ${scr}.querySelector('.appbar').getBoundingClientRect();
      const top = document.elementFromPoint(b.left + 6, b.top + b.height / 2); // край полосы чипов, не сам чип
      return { top: Math.round(b.top), h: Math.round(b.height), barBottom: Math.round(bar.bottom), over: !!top && !!top.closest('.wchips'), bg: getComputedStyle(c).backgroundColor,
        screenBg: getComputedStyle(document.body).backgroundColor, scrolled: document.getElementById('viewport').scrollTop, H: innerHeight };
    })()`);
    await js(`document.getElementById('viewport').scrollTop = 0; 1`); await sleep(200);
    const s0 = await at();
    await js(`document.getElementById('viewport').scrollTop = 1200; 1`); await sleep(300);
    const s1 = await at();
    check(s1.scrolled > 600 && s1.top === s1.barBottom && s1.over, `${theme}: прокрутили на ${s1.scrolled} px — чипы под шапкой (${s1.top}, шапка до ${s1.barBottom}), поверх строк: ${s1.over}`);
    check(s0.top >= s0.barBottom && s1.bg === s1.screenBg, `${theme}: фон чипов — фон экрана (${s1.bg} / ${s1.screenBg})`);
    // нажимаются и после прокрутки: выбор озвучки открывается
    await js(`${scr}.querySelector('.wchips .wchip-dub').click(); 1`); await sleep(500);
    check(await js(`!!document.querySelector('.popover')`), `${theme}: после прокрутки чип озвучки открывает выбор`);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`); await sleep(300);
    // узкое окно: чипы в две строки, списку — больше половины высоты
    win.setSize(420, 800); await sleep(500);
    await js(`document.getElementById('viewport').scrollTop = 1200; 1`); await sleep(300);
    const n = await at();
    const one = await js(`(() => { const c = ${scr}.querySelector('.wchips'); const cs = [...c.querySelectorAll('.wchip')].map((x) => Math.round(x.getBoundingClientRect().top)); return { rows: new Set(cs).size, scroll: c.scrollWidth > c.clientWidth }; })()`);
    check(n.top === n.barBottom && n.over && n.h <= 60 && one.rows === 1, `${theme}, узкое окно: чипы под шапкой (${n.top}) одной строкой (строк ${one.rows}, вбок листается: ${one.scroll}), высота ${n.h} px`);
    // последний чип (плеер) — достать прокруткой вбок и нажать
    await js(`(() => { const c = ${scr}.querySelector('.wchips'); c.scrollLeft = c.scrollWidth; c.querySelector('.wchip:last-of-type, .wchip-player')?.click(); })(); 1`); await sleep(500);
    check(await js(`!!document.querySelector('.popover')`), `${theme}, узкое окно: чип плеера в конце строки нажимается`);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`); await sleep(300);
    win.setSize(1280, 800); await sleep(300);
  }
  srv.server.close();
  app.exit(fails.length ? 1 : 0);
});
