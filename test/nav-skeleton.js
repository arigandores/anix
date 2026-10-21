require('./_failfast');
// Переход на экран (поиск, страница аниме), когда данные не успели за ожидание перехода: экран ни на кадр не бывает
// голым — скелетон въезжает вместе с ним, а пришедший контент проявляется поверх (плавно, а не рывком).
// Раньше было два плохих варианта: скелетон мелькал и подменялся рывком; потом — пустой экран на 100–250 мс и
// весь контент разом. Ответы API подменены заранее полученными с точной задержкой. Окно offscreen (CSS-анимации).
// Запуск: npx electron test/nav-skeleton.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await settle(js, 5000);
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const router = await import('/js/router.js');
    // ответы API — заранее полученные настоящие, отдаются ровно через __delay (своя сеть не добавляет времени)
    const of = window.fetch; window.__delay = 0; const memo = new Map();
    window.fetch = async (u, o) => {
      const url = String(u.url || u); const key = url.split('?')[0] + '|' + (typeof o?.body === 'string' ? o.body : ''); // без параметров адреса (подпись меняется)
      if (!window.__delay || !url.includes('/api/')) return of(u, o);
      if (!memo.has(key)) { const res = await of(u, o); memo.set(key, await res.text()); }
      await sleep(window.__delay);
      return new Response(memo.get(key), { headers: { 'content-type': 'application/json' } });
    };
    const { A } = await import('/js/api.js');
    const warm = async (fn) => { window.__delay = 1; try { await fn(); } finally { window.__delay = 0; } };
    await warm(() => A.searchReleases(0, { query: 'Мастер Муси', searchBy: 0 }));
    await warm(() => A.release(40, true));
    // кадры перехода: голый (экран есть, но не видно ни скелетона, ни контента) и вторая анимация — у контента, сменившего
    // скелетон: своё проявление (content-in, swapIn) или въезд заново с начала. Должна быть одна: въезд экрана, который
    // пришедший контент подхватывает с того же места; пришёл после въезда — встаёт без анимации
    const go = async (delay, name, params, ready) => {
      window.__delay = delay;
      router.navigate(name, params);
      let bare = 0; let sk = 0; let second = null; let minOp = 1; let barFaded = false; let bgEarly = false; const t0 = Date.now(); const navAt = performance.now();
      while (Date.now() - t0 < delay + 1500) {
        const s = document.querySelector('#viewport .screen:last-child');
        // въезд экрана — не с нуля (между экранами не мелькает пустой кадр)
        if (s?.dataset.screen === name && s.isConnected) minOp = Math.min(minOp, Number(getComputedStyle(s).opacity));
        // шапка при проявлении контента не тускнеет (это читалось как блик)
        const bar = s?.dataset.screen === name && s.querySelector('.appbar');
        if (bar) { let o = 1; for (let n = bar; n && n !== s; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); if (o < 0.9) barFaded = true; } // с учётом родителей внутри экрана
        // фон за постером — только после загрузки картинки
        const bg = s?.dataset.screen === name && s.querySelector('.rel-hero .bg');
        if (bg && !bg.classList.contains('ready') && Number(getComputedStyle(bg).opacity) > 0.01) bgEarly = true;
        if (s?.dataset.screen === name && Number(getComputedStyle(s).opacity) > 0.3) {
          const vis = (el) => { let o = 1; for (let n = el; n && n !== s; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); return o; };
          const skVis = [...s.querySelectorAll('.sk-root, .sk')].some((el) => el.getClientRects().length && vis(el) > 0.05);
          const content = s.querySelector(ready);
          if (skVis) sk += 1;
          else if (!content) bare += 1;
          if (content && second === null) {
            const anims = s.getAnimations({ subtree: true }).filter((a) => !(a instanceof CSSTransition) && a.playState === 'running'
              && !a.effect?.target?.closest?.('.lt') && !/^(sk-|lt-)/.test(a.animationName || ''));
            const since = performance.now() - navAt;
            second = anims.filter((a) => !/^screen-/.test(a.id || '') || (since > 80 && Number(a.currentTime) < 30)).map((a) => a.id || a.animationName || 'без имени').join(',');
          }
          if (content && !s.querySelector('.sk-root, .sk') && Date.now() - t0 > delay + 300) break;
        }
        await new Promise((ok) => requestAnimationFrame(ok));
      }
      window.__delay = 0; history.back(); await sleep(700);
      return { bare, sk, second, minOp, barFaded, bgEarly };
    };
    // из списка: в предпросмотре уже видны постер и название (данные строки) — при смене скелетона они не тускнеют
    const fromList = async (delay) => {
      const pre = (await A.release(41, true)).release; const preload = { id: pre.id, image: pre.image, title_ru: pre.title_ru, title_original: pre.title_original };
      await warm(() => A.release(41, true));
      window.__delay = delay;
      router.navigate('release', { id: 41, preload });
      let minHero = 1; let entered = false; const t0 = Date.now();
      while (Date.now() - t0 < delay + 1500) {
        const s = document.querySelector('#viewport .screen:last-child');
        if (s?.dataset.screen === 'release') {
          // въехал — анимация въезда (у контента под шапкой) закончилась
          if (!entered && Date.now() - t0 > 60 && !s.getAnimations({ subtree: true }).some((a) => /^screen-/.test(a.id || a.animationName || '') && a.playState === 'running')) entered = true;
          if (entered) for (const el of s.querySelectorAll('.rel-hero .poster, .rel-hero .rel-title')) { let o = 1; for (let n = el; n && n !== s; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); minHero = Math.min(minHero, o); }
          if (s.querySelector('.rel-body .info-rows .info-row:not(.skeleton .info-row)') && !s.querySelector('.sk-root, .sk') && Date.now() - t0 > delay + 300) break;
        }
        await new Promise((ok) => requestAnimationFrame(ok));
      }
      window.__delay = 0; history.back(); await sleep(700);
      return minHero;
    };
    // шапка при переходах — сразу целиком (мигала: экран проявлялся вместе с ней): вкладки и переход вперёд;
    // полоса вкладок под шапкой (.tabbar прилипает к ней) — тоже шапка: «Профиль → Комментарии» она мигала
    const headerMin = async (kick) => {
      const before = document.querySelector('#viewport .screen:last-child');
      kick();
      let min = 1; const t0 = Date.now();
      while (Date.now() - t0 < 700) {
        const s = document.querySelector('#viewport .screen:last-child');
        for (const bar of s && s !== before ? s.querySelectorAll('.appbar, .tabbar:not(.static), .wchips') : []) {
          if (bar.getClientRects().length) { let o = 1; for (let n = bar; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); min = Math.min(min, o); }
        }
        await new Promise((ok) => requestAnimationFrame(ok));
      }
      return min;
    };
    const hdr = {
      tab: (await headerMin(() => router.switchTab('discover'))),
      tabBack: (await headerMin(() => router.switchTab('home'))),
      forward: (await headerMin(() => router.navigate('profile', { id: 1 }))),
    };
    history.back(); await sleep(700);
    hdr.tabbar = await headerMin(() => router.navigate('profile-comments', { profile: { id: 1 } }));
    history.back(); await sleep(700);
    // экран со вкладками (профиль → «Списки просмотра»): содержимое вкладки въезжает вместе с экраном, а не
    // проявляется ещё раз с нуля поверх въезда (блик; во «Вкладках» закладок его не было)
    const tabsEnter = async () => {
      router.navigate('profile-lists', { profile: { id: 1 }, status: 1 });
      let min = 1; let own = false; const t0 = Date.now();
      while (Date.now() - t0 < 700) {
        const s = document.querySelector('#viewport .screen:last-child');
        if (s?.dataset.screen === 'profile-lists') for (const el of s.querySelectorAll('.tabbody > *')) {
          let o = 1; for (let n = el; n && n !== s; n = n.parentElement) o *= Number(getComputedStyle(n).opacity); min = Math.min(min, o);
          if (el.getAnimations().some((a) => !/^screen-/.test(a.id || '') && a.playState === 'running' && !(a instanceof CSSTransition))) own = true;
        }
        await new Promise((ok) => requestAnimationFrame(ok));
      }
      history.back(); await sleep(700);
      return { min, own };
    };
    const tabsIn = await tabsEnter();
    return {
      hdr, tabsIn,
      search: await go(180, 'search', { query: 'Мастер Муси' }, '.release-row:not(.skeleton .release-row)'),
      release: await go(180, 'release', { id: 40 }, '.rel-body .info-rows .info-row:not(.skeleton .info-row)'),
      fromList: await fromList(600), // ответ позже въезда — смена скелетона на въехавшем экране
    };
  })()`);
  for (const [k, v] of Object.entries(r.hdr)) check(v >= 0.95, `шапка при переходе (${k}) — сразу целиком, не мигает (мин. видимость ${v.toFixed(2)})`);
  delete r.hdr;
  check(!r.tabsIn.own && r.tabsIn.min >= 0.3, `списки просмотра: вкладка въезжает вместе с экраном, без своего проявления (мин. видимость ${r.tabsIn.min.toFixed(2)}, своя анимация: ${r.tabsIn.own ? 'да' : 'нет'})`);
  delete r.tabsIn;
  check(r.fromList >= 0.95, `аниме из списка: постер и название из предпросмотра не тускнеют при смене скелетона (мин. видимость ${r.fromList.toFixed(2)})`);
  delete r.fromList;
  for (const [n, v] of Object.entries(r)) {
    check(v.bare <= 1, `${n}: ответ за 180 мс — экран не голый (пустых кадров: ${v.bare}, со скелетоном: ${v.sk})`);
    check(v.sk > 0 && v.second === '', `${n}: одна анимация — контент подхватывает въезд экрана, без своей (вторая: ${v.second || 'нет'})`);
    check(v.minOp >= 0.3, `${n}: экран въезжает не с нуля — без пустого кадра между экранами (мин. видимость ${v.minOp.toFixed(2)})`);
    check(!v.barFaded, `${n}: шапка не тускнеет, когда контент сменяет скелетон`);
    check(!v.bgEarly, `${n}: фон за постером — только после загрузки картинки`);
  }
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
