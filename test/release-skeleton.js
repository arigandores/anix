require('./_failfast');
// Скелетон страницы аниме совпадает с настоящей страницей: те же кнопки в шапке (три кнопки, «Смотреть» и «Смотреть
// вместе» — и на узком окне так же переносится), секции до низа (раньше — одна карточка слева и две справа, ниже
// пустота), блок сведений и левая колонка — близкой высоты. Ответ релиза задержан, пока меряем скелетон.
// Ширина 1280 и 820. Запуск: npx electron test/release-skeleton.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// геометрия страницы: кнопки шапки, ряд «Смотреть», карточки колонок, высоты
const MEASURE = `(() => {
  const s = document.querySelector('#viewport .screen:last-child');
  const r = (el) => el ? el.getBoundingClientRect() : null;
  const actions = s.querySelector('.rel-actions'); const wrow = s.querySelector('.watch-row');
  const wkids = wrow ? [...wrow.children].map(r) : [];
  const cols = [...s.querySelectorAll('.rel-body > div')];
  return {
    actions: actions ? actions.children.length : 0,
    watch: wkids.length, watchWrap: wkids.length > 1 && wkids[1].top > wkids[0].top + 10,
    left: cols[0] ? cols[0].querySelectorAll(':scope > .card').length : 0, right: cols[1] ? cols[1].querySelectorAll(':scope > .card').length : 0,
    infoH: Math.round(r(cols[0]?.querySelector(':scope > .card'))?.height || 0), leftH: Math.round(r(cols[0])?.height || 0),
    infoRows: cols[0]?.querySelector(':scope > .card .info-rows')?.children.length || 0,
  };
})()`;

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 860, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await settle(js, 5000);
  // для каждой ширины — своё аниме: второй заход на то же открылся бы из памяти, без скелетона
  // bare — заход без данных списка (серые полоски), list — из строки списка (как открывают обычно: preload — объект
  // списка, в нём почти все поля, кроме типа и статуса) — блок сведений совпадает с пришедшим до пикселя
  for (const [W, id, mode] of [[1280, 21, 'bare'], [820, 30, 'bare'], [1280, 22, 'list'], [820, 31, 'list']]) {
    win.setContentSize(W, 860); await sleep(300);
    await js(`(async () => { const { A } = await import('/js/api.js'); window.__pre = (await A.release(${id}, true)).release; window.__id = ${id}; window.__hold = true;
      if (!window.__wrapped) { window.__wrapped = true; const of = window.fetch; window.fetch = async (u, o) => { if (window.__hold && String(u.url || u).split('?')[0].endsWith('release/' + window.__id)) while (window.__hold) await new Promise((ok) => setTimeout(ok, 50)); return of(u, o); }; }
      const p = window.__pre; (await import('/js/router.js')).navigate('release', { id: ${id}, preload: ${mode === 'list' ? '{ ...p, category: undefined, status: undefined }' : '{ id: p.id, image: p.image, title_ru: p.title_ru, title_original: p.title_original }'} }); })()`);
    await sleep(1200);
    const sk = await js(MEASURE);
    if (!sk.leftH || !(await js(`!!document.querySelector('#viewport .screen:last-child .rel-body.skeleton')`))) check(false, `${W}px: скелетон не показан — замер недействителен`);
    await js('window.__hold = false'); await sleep(300); await settle(js, 8000); await sleep(800);
    const real = await js(MEASURE);
    check(sk.actions === real.actions, `${W}px: кнопок в шапке — как на странице (${sk.actions} и ${real.actions})`);
    check(sk.watch === real.watch && sk.watchWrap === real.watchWrap, `${W}px: «Смотреть» и «Смотреть вместе» — как на странице (${sk.watch}/${sk.watchWrap ? 'перенос' : 'в ряд'} и ${real.watch}/${real.watchWrap ? 'перенос' : 'в ряд'})`);
    check(sk.left >= real.left && sk.right >= real.right, `${W}px: секции до низа — карточек слева ${sk.left} (на странице ${real.left}), справа ${sk.right} (${real.right})`);
    // раньше допуск был 15% — и скелетон на 20–25 px ниже настоящего проходил (строки 20 px вместо 21, описание короче)
    if (mode === 'list') check(sk.infoH === real.infoH && sk.infoRows === real.infoRows, `${W}px, из списка: блок сведений — как пришедший (высота ${sk.infoH} и ${real.infoH}, строк ${sk.infoRows} и ${real.infoRows})`);
    else check(Math.abs(sk.infoH - real.infoH) <= 20, `${W}px: блок сведений близкой высоты — строки и описание в размерах настоящих (${sk.infoH} и ${real.infoH})`);
    check(sk.leftH / real.leftH > 0.7, `${W}px: левая колонка — не меньше 70% настоящей (${sk.leftH} и ${real.leftH})`);
    await js('history.back()'); await sleep(900);
  }
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
