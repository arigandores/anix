require('./_failfast');
// Lottie-анимации интерфейса (js/lottie.js, public/lottie/*.json): файлы и их маркеры, сердце «в избранное»
// (проигрывает отрезок и встаёт в конечный кадр), жизненный цикл (вынули из DOM — уничтожена, вернули —
// создана снова), режим экономии (без проигрывания), запасная иконка, если файла нет, тост с галочкой.
// Окно — offscreen: в скрытом окне не идут CSS-анимации, а по ним lottie.js узнаёт о вставке в DOM.
// Запуск: npx electron test/lottie.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');

const MARKERS = { heart: ['on', 'off'], bell: ['ring'], star: ['pop'], check: ['draw'], 'empty-ghost': ['intro', 'loop'],
  'empty-search': ['intro', 'loop'], 'empty-bell': ['intro', 'loop'], 'empty-comment': ['intro', 'loop'], 'empty-error': ['intro'] };
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };

for (const [name, need] of Object.entries(MARKERS)) {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'lottie', `${name}.json`), 'utf8'));
  const have = (j.markers || []).map((m) => m.cm);
  check(need.every((m) => have.includes(m)) && j.layers.length > 0, `${name}.json: слои и маркеры ${need.join(', ')}`);
}

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const until = async (fn, max = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { if (fn()) return true; await sleep(30); } return false; };
    const { heartIcon, lottieIcon } = await import('/js/lottie.js');
    const ui = await import('/js/ui.js');
    const anim = (el) => window.lottie?.getRegisteredAnimations().find((a) => el.contains(a.wrapper));
    const box = ui.h('div', { style: { position: 'fixed', left: '0', top: '0', zIndex: 999, background: 'var(--bg)', padding: '20px' } });
    document.body.append(box);
    const out = {};

    const heart = heartIcon(false); box.append(ui.h('button', { class: 'btn list-btn' }, heart));
    out.heartMounted = await until(() => heart.classList.contains('lt-on'));
    heart.set(true, true);
    await sleep(80);
    out.heartPlaying = !!anim(heart) && !anim(heart).isPaused;
    out.heartEnd = await until(() => anim(heart)?.isPaused) && Math.round(anim(heart).currentFrame);

    // снятие из избранного: кнопка сразу серая, а сжимающаяся заливка — ещё своим цветом (мелькала тёмной)
    const h2 = heartIcon(true); const b2 = ui.h('button', { class: 'btn list-btn tag tag-fav' }, h2); box.append(b2);
    await until(() => h2.classList.contains('lt-on'));
    const yellow = getComputedStyle(h2).color;
    h2.set(false, true); b2.className = 'btn list-btn';
    await sleep(30); out.offDuring = getComputedStyle(h2).color === yellow;
    await sleep(250); out.offAfter = getComputedStyle(h2).color !== yellow;

    const empty = ui.emptyView('Пусто');
    box.append(empty);
    const ghost = empty.querySelector('.lt');
    // до готовности анимации — пустое место, а не статичная иконка «i» (мелькала перед привидением)
    out.ghostBlankBefore = !ghost.classList.contains('lt-on') && getComputedStyle(ghost).backgroundImage === 'none' && getComputedStyle(ghost).backgroundColor === 'rgba(0, 0, 0, 0)';
    out.ghostMounted = await until(() => ghost.classList.contains('lt-on'));
    out.ghostLooping = await until(() => anim(ghost) && anim(ghost).loop && !anim(ghost).isPaused, 2000);
    const before = window.lottie.getRegisteredAnimations().length;
    empty.remove();
    out.ghostDestroyed = await until(() => window.lottie.getRegisteredAnimations().length === before - 1, 6000);
    // на месте уничтоженной анимации — неподвижный снимок: при возврате место не пустое ни на кадр
    out.ghostSnapshot = ghost.classList.contains('lt-on') && !!ghost.querySelector('.lt-host svg');
    box.append(empty);
    const r0 = ghost.getBoundingClientRect(); const svg0 = ghost.querySelector('.lt-host svg');
    out.ghostSnapVisible = !!svg0 && svg0.getBoundingClientRect().width > 0 && r0.width > 0 && getComputedStyle(ghost).visibility === 'visible';
    empty.remove();
    box.append(empty);
    out.ghostBack = await until(() => ghost.classList.contains('lt-on') && anim(ghost) && !anim(ghost).isPaused);

    document.documentElement.classList.add('economy');
    heart.set(false, true);
    await sleep(80);
    out.economyStill = anim(heart).isPaused && Math.round(anim(heart).currentFrame);
    document.documentElement.classList.remove('economy');

    const missing = lottieIcon('нет-такой', { fallback: 'ic_bell' }); box.append(missing);
    await sleep(600);
    out.fallback = !missing.classList.contains('lt-on') && missing.style.getPropertyValue('--ic').includes('ic_bell');
    const missingBlank = lottieIcon('нет-такой-2', { fallback: 'ic_bell', blank: true }); box.append(missingBlank);
    await until(() => missingBlank.classList.contains('lt-fail'));
    out.blankFallback = getComputedStyle(missingBlank).backgroundColor !== 'rgba(0, 0, 0, 0)';

    // звезда оценки (muted): до готовности анимации — серая, а не залитая цветом выбора (мелькала жёлтой)
    const starWrap = ui.h('span', { style: { color: 'rgb(255, 167, 38)' } });
    const star = lottieIcon('star', { fallback: 'ic_star_rate', pad: 0.5, muted: true });
    starWrap.append(star); box.append(starWrap);
    out.starBefore = getComputedStyle(star).backgroundColor;
    out.starGray = out.starBefore !== 'rgb(255, 167, 38)' && out.starBefore !== 'rgba(0, 0, 0, 0)';
    out.starReady = await star.ready;
    out.starFrame0 = Math.round(anim(star).currentFrame);

    // бейдж непрочитанных выпрыгивает (и колокольчик звенит), только когда их стало больше — не при каждой
    // сборке шапки вкладки
    const { auth, A } = await import('/js/api.js'); const common = await import('/js/screens/common.js');
    Object.defineProperty(auth, 'loggedIn', { get: () => true, configurable: true });
    A.notifCount = async () => ({ code: 0, count: 3 });
    const badgeAnims = async () => { const bar = common.mainToolbar(); box.append(bar); await until(() => bar.querySelector('.notif-badge')); const b = bar.querySelector('.notif-badge'); const n = b ? b.getAnimations().length : -1; bar.remove(); return n; };
    out.badgeFirst = await badgeAnims();
    out.badgeAgain = await badgeAnims();

    ui.toast('Скопировано', { ok: true });
    out.toast = await until(() => document.querySelector('#toast.ok .toast-ic.lt-on'));
    return out;
  })()`);
  check(r.heartMounted, 'сердце: анимация сменила статичную иконку');
  check(r.heartPlaying, 'сердце: по set(true, true) отрезок «on» играет');
  check(r.heartEnd === 35, `сердце: встало в конечный кадр «on» (кадр ${r.heartEnd})`);
  check(r.offDuring && r.offAfter, 'сердце: при снятии заливка сжимается своим цветом, потом — цвет кнопки');
  check(r.ghostBlankBefore, 'пустой экран: до готовности анимации — пустое место, а не статичная иконка');
  check(r.ghostMounted && r.ghostLooping, 'пустой экран: привидение появилось и крутит петлю');
  check(r.ghostDestroyed, 'вынули из DOM — анимация уничтожена');
  check(r.ghostSnapshot && r.ghostSnapVisible, 'на её месте снимок кадра: вернули — сразу видно, без пустого места');
  check(r.ghostBack, 'вернули в DOM — создана снова и играет');
  check(r.economyStill === 51, `режим экономии: без проигрывания, сразу кадр покоя (кадр ${r.economyStill})`);
  check(r.fallback, 'файла нет — остаётся статичная иконка');
  check(r.blankFallback, 'blank: файла нет — всё же показывается статичная иконка');
  check(r.starGray, `звезда оценки до готовности — не залитая (фон ${r.starBefore})`);
  check(r.starReady === true && r.starFrame0 === 0, 'звезда: ready, стоит в начальном кадре до команды');
  check(r.badgeFirst === 1 && r.badgeAgain === 0, `бейдж непрочитанных выпрыгивает один раз, не при каждой сборке шапки (${r.badgeFirst}, потом ${r.badgeAgain})`);
  check(r.toast, 'тост { ok }: галочка-анимация');
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
