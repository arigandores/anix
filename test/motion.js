require('./_failfast');
// Анимации второго батча: жест иконки навигации — только при смене вкладки; полоска вкладок переезжает под
// выбранную; полосы растут один раз (возврат на экран не повторяет); перекат числа — только когда оно сменилось;
// плей ⇄ пауза и «скопировать» → галочка встают в нужные кадры; режим экономии — без откликов.
// Окно offscreen: в скрытом не идут CSS-переходы и анимации. Запуск: npx electron test/motion.js
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
    const until = async (fn, max = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { if (fn()) return true; await sleep(20); } return false; };
    const ui = await import('/js/ui.js'); const L = await import('/js/lottie.js');
    const anim = (el) => window.lottie?.getRegisteredAnimations().find((a) => el.contains(a.wrapper));
    const frame = (el) => Math.round(anim(el).currentFrame + anim(el).firstFrame); // абсолютный кадр (currentFrame — от начала отрезка)
    const out = {};

    // 1. навигация: при запуске жест не играл; переход на «Обзор» — играет на его иконке
    const navIc = (tab) => document.querySelector('#rail .nav-item[data-tab="' + tab + '"] .lt.on');
    await until(() => anim(navIc('home')));
    out.navIdleAtStart = anim(navIc('home')).isPaused;
    document.querySelector('#rail .nav-item[data-tab="discover"]').click();
    await until(() => anim(navIc('discover')));
    await sleep(60);
    out.navPlays = anim(navIc('discover')) && !anim(navIc('discover')).isPaused;
    await until(() => anim(navIc('discover')).isPaused, 2000);
    out.navRest = frame(navIc('discover'));

    // 2. вкладки: полоска под выбранной и переезжает (переход), а не перепрыгивает
    const t = ui.tabs([{ title: 'Один', render: () => ui.h('div') }, { title: 'Второй длинный', render: () => ui.h('div') }, { title: 'Три', render: () => ui.h('div') }]);
    const box = ui.h('div', { style: { position: 'fixed', left: '0', top: '0', width: '600px', zIndex: 999, background: 'var(--bg)' } }, t);
    document.body.append(box);
    await sleep(100);
    const ink = t.querySelector('.tab-ink'); const tabsEl = [...t.querySelectorAll('.tab')];
    out.inkFirst = Math.round(ink.getBoundingClientRect().left - tabsEl[0].getBoundingClientRect().left) === 0 && !ink.classList.contains('ready');
    tabsEl[2].click();
    out.inkAnimated = ink.classList.contains('ready') && getComputedStyle(ink).transitionDuration !== '0s';
    await sleep(450);
    const ib = ink.getBoundingClientRect(); const tb = tabsEl[2].getBoundingClientRect();
    out.inkUnder = Math.abs(ib.left - tb.left) < 1 && Math.abs(ib.width - tb.width) < 1;

    // 3. полосы растут один раз
    const bars = ui.growBars(ui.h('div', { class: 'progress-multi', style: { width: '300px' } }, ui.h('div', { style: { width: '60%', background: 'red' } }), ui.h('div', { style: { width: '30%', background: 'blue' } })));
    box.append(bars);
    await until(() => bars.firstChild.getAnimations().length);
    out.barsGrow = bars.firstChild.getAnimations().length === 1;
    await sleep(900);
    bars.remove(); box.append(bars); await sleep(200);
    out.barsOnce = bars.firstChild.getAnimations().length === 0;

    // 4. перекат числа — только когда сменилось
    const num = ui.h('span', null, '7 137'); box.append(num);
    ui.rollTo(num, '7 137'); out.rollSame = num.getAnimations().length === 0;
    ui.rollTo(num, '7 138', true); out.rollChanged = num.textContent === '7 138' && num.getAnimations().length === 1;

    // 5. плей ⇄ пауза, «скопировать» → галочка
    const pp = L.playPauseIcon(true); const cp = L.copyIcon(); box.append(pp, cp);
    await until(() => anim(pp) && anim(cp));
    pp.set(false); await sleep(50); out.ppPlaying = !anim(pp).isPaused;
    await until(() => anim(pp).isPaused, 1500); out.ppPlayFrame = frame(pp);
    // после отрезка не с нуля — встать в кадр покоя (так делает уход с экрана и снимок): тот же кадр, а не за концом
    pp.show('play'); out.ppShowFrame = frame(pp);
    pp.set(true); await until(() => !anim(pp).isPaused, 500); await until(() => anim(pp).isPaused, 1500); out.ppPauseFrame = frame(pp);
    cp.done(); await sleep(450); out.copyDone = frame(cp);
    await sleep(1400); await until(() => anim(cp).isPaused, 1500); out.copyBack = frame(cp);

    // 6. режим экономии: короткие отклики не играют
    document.documentElement.classList.add('economy');
    out.economyNudge = ui.nudge(num, [{ opacity: 0 }, { opacity: 1 }]) === null;
    ui.rollTo(num, '7 139', true); out.economyRoll = num.getAnimations().length === 0 || num.getAnimations().every((a) => a.playState === 'finished');
    document.documentElement.classList.remove('economy');
    return out;
  })()`);
  check(r.navIdleAtStart, 'навигация: при запуске жест «выбрано» не играет');
  check(r.navPlays, 'навигация: переход на вкладку — жест на её иконке');
  check(r.navRest === 27, `навигация: после жеста — кадр покоя (кадр ${r.navRest})`);
  check(r.inkFirst, 'вкладки: полоска сразу под первой, без перехода');
  check(r.inkAnimated, 'вкладки: при выборе полоска переезжает (переход), а не перепрыгивает');
  check(r.inkUnder, 'вкладки: доехала под выбранную и её ширины');
  check(r.barsGrow && r.barsOnce, 'полосы: растут при первом показе, при возврате — нет');
  check(r.rollSame && r.rollChanged, 'перекат числа: только когда число сменилось');
  check(r.ppPlaying && r.ppPlayFrame === 23 && r.ppPauseFrame === 11, `плей ⇄ пауза: кадры покоя 23 и 11 (${r.ppPlayFrame}, ${r.ppPauseFrame})`);
  check(r.ppShowFrame === 23, `кадр покоя после отрезка не с нуля — тот же, а не за концом (${r.ppShowFrame})`);
  check(r.copyDone === 19 && r.copyBack === 33, `«скопировать»: галочка, потом обратно (кадры ${r.copyDone}, ${r.copyBack})`);
  check(r.economyNudge && r.economyRoll, 'режим экономии: короткие отклики не играют');
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
