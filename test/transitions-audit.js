require('./_failfast');
// Аудит переходов по всем экранам: вкладки снизу, переходы вперёд и назад, повторный заход (из памяти).
// Покадрово (каждый кадр отрисовки) проверяет то, на что жаловались по отдельности:
//  - шапка и прилипающая к ней полоса вкладок — сразу целиком и на месте (не мигают, не едут);
//  - одна анимация на переход: кроме въезда экрана — никаких своих проявлений контента и повторного въезда;
//  - въезд вперёд/назад — не с нуля (без пустого кадра);
//  - после въезда контент не тускнеет снова (блик при приходе данных или фоновом обновлении).
// Окно offscreen (в нём идут анимации). Запуск: npx electron test/transitions-audit.js [экран…]
const { app, BrowserWindow, nativeTheme } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.js'));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await settle(js, 6000);
  await js(`(async () => {
    const router = await import('/js/router.js');
    const raf = () => new Promise((ok) => requestAnimationFrame(ok));
    const vis = (el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
    const HEAD = '.appbar, .tabbar:not(.static)';
    const IGNORE = /^(sk-|lt-|spin|ai-dot|fade|pop|pm-in|bubble|seek)/;
    // снимает переход: kick() — действие, ms — сколько смотреть
    window.__watch = async (kick, ms = 1400, { same = false } = {}) => {
      const before = same ? null : document.querySelector('#viewport .screen:last-child');
      const r = { hdr: 1, hdrMove: 0, enterMin: 1, dip: 1, extra: new Set(), reenter: false, dir: null };
      const navAt = performance.now(); kick();
      let hx = null; let entered = false; let full = false; let enterStart = null;
      while (performance.now() - navAt < ms) {
        await raf();
        const s = document.querySelector('#viewport .screen:last-child');
        if (!s || s === before) continue;
        const since = performance.now() - navAt;
        for (const b of s.querySelectorAll(HEAD)) {
          if (!b.getClientRects().length) continue;
          r.hdr = Math.min(r.hdr, vis(b));
          const x = b.getBoundingClientRect().left; if (hx === null) hx = x; r.hdrMove = Math.max(r.hdrMove, Math.abs(x - hx));
        }
        const anims = s.getAnimations({ subtree: true }).filter((a) => !(a instanceof CSSTransition) && a.playState === 'running');
        let entering = false;
        for (const a of anims) {
          const t = a.effect?.target; const name = a.id || a.animationName || '';
          if (/^screen-/.test(a.id || '')) { // въезд — только Web Animations из enterScreen/joinEnter (CSS screen-* — вторая)
            entering = true; r.dir = r.dir || name;
            // подхват въезда (joinEnter) идёт с того же места — то же начало; другое начало — въезд заново
            if (a.pending) continue; // ещё не стартовала: время начала не известно
            const st = document.timeline.currentTime - Number(a.currentTime);
            if (enterStart === null) enterStart = st; else if (Math.abs(st - enterStart) > 40) r.reenter = true;
            continue;
          }
          if (IGNORE.test(name) || a.effect?.getTiming().iterations === Infinity) continue;
          if (t?.closest?.('.lt, .sk-root, .skeleton, .spinner, .spinner-wrap, .tab-ink')) continue;
          // полосы рейтинга и «в списках» дорастают до значения (growBars) — эффект внутри карточки, не проявление
          if (a.effect?.getKeyframes?.().some((k) => 'width' in k)) continue;
          // следующая страница бесконечного списка (первая влезла в окно — догружается сразу): новые строки ниже
          // уже показанных проявляются — это подгрузка, а не повторное появление экрана
          if (name === 'content-in' && t?.parentElement?.firstElementChild !== t && !t.parentElement.firstElementChild.getAnimations().some((x) => x.animationName === 'content-in')) continue;
          // картинка проявляется, когда загрузилась (img в ui.js)
          if (t?.tagName === 'IMG') continue;
          const cls = (el) => el ? el.tagName.toLowerCase() + ((el.className?.baseVal ?? el.className) ? '.' + String(el.className?.baseVal ?? el.className).trim().split(' ').filter(Boolean).join('.') : '') : '?';
          r.extra.add((name || 'WAAPI') + ' @' + cls(t?.parentElement) + ' > ' + cls(t));
        }
        // контент под шапкой: видимость самого прозрачного из верхних блоков
        const root = s.firstElementChild;
        const blocks = root ? [...root.querySelectorAll(':scope > *:not(.appbar), :scope > .tabs > .tabbody')].filter((el) => el.getClientRects().length && !el.matches('.tabs')) : [];
        const min = blocks.length ? Math.min(...blocks.map(vis)) : 1;
        if (entering && /forward|back/.test(r.dir || '')) r.enterMin = Math.min(r.enterMin, min);
        if (!entering && since > 60) entered = true;
        if (same && since < 260) continue; // переключение вкладки: проявление (одно) — его не считаем потускнением
        if (entered) { if (min >= 0.99) full = true; if (full) r.dip = Math.min(r.dip, min); }
      }
      return { ...r, extra: [...r.extra] };
    };
  })()`);

  const P1 = '{ id: 1 }';
  const prof = '{ profile: { id: 1 } }';
  const FWD = [
    ['release', '{ id: 40 }'], ['search', '{ query: "Мастер Муси" }'], ['profile', P1], ['profile-lists', prof],
    ['profile-comments', prof], ['profile-votes', prof], ['friends', prof], ['profile-collections', '{ profileId: 1 }'],
    ['collections', '{}'], ['top', '{}'], ['watching', '{}'], ['recommendations', '{}'], ['schedule', '{}'],
    ['notifications', '{}'], ['settings', '{}'], ['filter', '{}'], ['channels', '{}'],
    ['comments', '{ kind: "release", id: 40 }'], ['release-collections', '{ release: { id: 40 } }'], ['feed-search', '{}'],
    ['auth', '{}'], ['signup', '{}'], ['restore', '{}'],
  ].filter(([n]) => !ONLY.length || ONLY.includes(n));
  const TABS = ['discover', 'bookmarks', 'feed', 'profile', 'ai', 'home'].filter((n) => !ONLY.length || ONLY.includes(n) || ONLY.includes('tabs'));

  const report = (label, r, { slide }) => {
    const bad = [];
    if (r.hdr < 0.95) bad.push(`шапка мигает (видимость ${r.hdr.toFixed(2)})`);
    if (r.hdrMove > 1) bad.push(`шапка едет (${r.hdrMove.toFixed(0)}px)`);
    if (r.reenter) bad.push('въезд начался заново');
    if (r.extra.length) bad.push(`вторая анимация: ${r.extra.join(', ')}`);
    if (slide && r.enterMin < 0.3) bad.push(`въезд с нуля (видимость ${r.enterMin.toFixed(2)})`);
    if (r.dip < 0.9) bad.push(`после въезда контент тускнеет (видимость ${r.dip.toFixed(2)})`);
    check(!bad.length, `${label}${bad.length ? ": " + bad.join("; ") : ""} [${r.dir || "без въезда"}, мин. ${r.enterMin.toFixed(2)}]`);
  };
  const watch = (kick, ms) => js(`window.__watch(() => { ${kick} }, ${ms || 1400})`);
  const R = `(await import('/js/router.js'))`;
  const nav = (n, p) => `import('/js/router.js').then((m) => m.navigate('${n}', ${p}))`;

  for (const t of TABS) report(`вкладка ${t}`, await watch(`import('/js/router.js').then((m) => m.switchTab('${t}'))`), { slide: false });
  // коллекция — по настоящему id (первая из коллекций с релизом)
  if (!ONLY.length || ONLY.includes('collection')) {
    const cid = await js(`import('/js/api.js').then((m) => m.A.releaseCollections(40, 0, 1)).then((r) => r.content?.[0]?.id ?? null)`);
    if (cid) FWD.push(['collection', `{ id: ${cid} }`]);
  }
  // вкладки внутри экрана: переключение — одно проявление содержимого, полоса вкладок и шапка на месте
  if (!ONLY.length || ONLY.includes('profile-lists')) {
    await js(`import('/js/router.js').then((m) => m.navigate('profile-lists', { profile: { id: 1 }, status: 1 }))`);
    await js(`new Promise((ok) => setTimeout(ok, 1500))`);
    for (const i of [1, 2, 0]) {
      const r = await js(`window.__watch(() => document.querySelector('#viewport .screen:last-child .tabs').select(${i}), 900, { same: true })`);
      r.extra = r.extra.filter((x) => !/^WAAPI @div\.tabbody > /.test(x)); // само проявление вкладки (одно)
      report(`списки просмотра: вкладка ${i + 1}`, r, { slide: false });
    }
    await watch('history.back()', 700);
  }
  for (const [n, p] of FWD) {
    report(`${n}: вперёд`, await watch(nav(n, p)), { slide: true });
    report(`${n}: назад`, await watch('history.back()', 900), { slide: true });
    report(`${n}: повторно (из памяти)`, await watch(nav(n, p)), { slide: true });
    await watch('history.back()', 700);
  }
  void R;
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
