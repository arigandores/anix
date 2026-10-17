require('./_failfast');
// Быстрые данные — без мелькания скелетона: «Комментарии» со страницы аниме и колокольчик (уведомления) грузят
// первую страницу уже с нажатия кнопки мыши (api.js prefetchRead) — ответ успевает за ожидание перехода; вкладка
// «История» (и другие вкладки закладок) при повторном выборе — из памяти. Раньше в этих местах на долю секунды был
// виден скелетон, хотя ответ приходил почти сразу. Ответы — с точной задержкой (подмена fetch), вход подменён.
// Окно offscreen (анимации скелетона идут). Запуск: npx electron test/press-prefetch.js
const { app, BrowserWindow, nativeTheme } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await settle(js, 6000);
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const raf = () => new Promise((ok) => requestAnimationFrame(ok));
    const router = await import('/js/router.js');
    const { A, auth } = await import('/js/api.js');
    Object.defineProperty(auth, 'loggedIn', { get: () => true, configurable: true });
    // ответы: комментарии — настоящие, заранее полученные; личное (уведомления, история, списки) — пустые страницы;
    // всё — ровно через свою задержку
    const of = window.fetch; const memo = new Map(); window.__delay = {};
    const json = (o) => new Response(typeof o === 'string' ? o : JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
    window.fetch = async (u, o) => {
      const url = String(u.url || u);
      const kind = /\\/notification\\//.test(url) ? 'notif' : /\\/history\\//.test(url) ? 'history' : /\\/(favorite|profile\\/list)\\//.test(url) ? 'list' : /\\/release\\/comment\\/all\\//.test(url) ? 'comments' : null;
      if (!kind) return of(u, o);
      const d = window.__delay[kind] ?? 0;
      if (kind === 'comments') {
        const key = url.split('?')[0];
        if (!memo.has(key)) memo.set(key, await (await of(u, o)).text());
        await sleep(d); return json(memo.get(key));
      }
      await sleep(d); return json({ code: 0, content: [], total_count: 0 });
    };
    // кадры со скелетоном на экране name за ms (видимость — с учётом родителей)
    const skFrames = async (name, ms) => {
      let n = 0; const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        await raf();
        const s = document.querySelector('#viewport .screen:last-child');
        if (!s || (name && s.dataset.screen !== name)) continue;
        const vis = (el) => { let o = 1; for (let x = el; x && x !== s.parentElement; x = x.parentElement) o *= Number(getComputedStyle(x).opacity); return o; };
        if ([...s.querySelectorAll('.sk-root, .sk')].some((el) => el.getClientRects().length && vis(el) > 0.05)) n += 1;
      }
      return n;
    };
    // нажатие как у человека: кнопка мыши вниз, ~90 мс, отпустили (click)
    const press = async (btn) => { btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); await sleep(90); btn.click(); };
    const out = {};

    // 1. страница аниме → «Комментарии» (кнопка в шапке): ответ за 180 мс
    await A.releaseComments(40, 0, 1); // прогрев памяти подмены (первый настоящий запрос — не в счёт)
    window.__delay.comments = 1; await A.releaseComments(40, 0, 1);
    router.navigate('release', { id: 40 });
    for (let i = 0; i < 100 && !document.querySelector('#viewport .screen:last-child .rel-hero .list-btn .ic[style*="ic_comment_outline"]'); i++) await sleep(50);
    await sleep(600);
    window.__delay.comments = 180;
    const cbtn = document.querySelector('#viewport .screen:last-child .rel-hero .list-btn .ic[style*="ic_comment_outline"]')?.closest('button');
    out.commentsBtn = !!cbtn;
    if (cbtn) { await press(cbtn); out.comments = await skFrames('comments', 700); }
    history.back(); await sleep(600); history.back(); await sleep(600);

    // 2. колокольчик → уведомления: ответ за 180 мс
    window.__delay.notif = 180;
    const bell = document.querySelector('#viewport .screen:last-child button[title="Уведомления"]');
    out.bellBtn = !!bell;
    if (bell) { await press(bell); out.notif = await skFrames('notifications', 700); }
    history.back(); await sleep(600);

    // 3. закладки: «История» — первый раз грузится (скелетон можно), повторно — из памяти, даже при ответе за 400 мс
    window.__delay.history = 400; window.__delay.list = 400;
    router.switchTab('bookmarks'); await sleep(900);
    const tb = document.querySelector('#viewport .screen:last-child .tabs');
    out.tabs = !!tb;
    if (tb) {
      tb.select(1); await sleep(900);
      tb.select(0); await sleep(900);
      tb.select(1); out.history = await skFrames(null, 600);
    }
    router.switchTab('home');
    return out;
  })()`);
  check(r.commentsBtn, 'страница аниме: кнопка «Комментарии» в шапке');
  if (r.commentsBtn) check(r.comments === 0, `«Комментарии» при ответе за 180 мс — без скелетона (кадров со скелетоном: ${r.comments})`);
  check(r.bellBtn, 'колокольчик на главной');
  if (r.bellBtn) check(r.notif === 0, `уведомления при ответе за 180 мс — без скелетона (кадров со скелетоном: ${r.notif})`);
  check(r.tabs, 'закладки: вкладки');
  if (r.tabs) check(r.history === 0, `«История» при повторном выборе — из памяти, без скелетона (кадров со скелетоном: ${r.history})`);
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
