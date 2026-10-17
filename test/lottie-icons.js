require('./_failfast');
// Третья партия Lottie-иконок: жесты при наведении (шестерёнка, фильтр, сортировка, «Случайный», «История», корзина),
// глаз (спойлер в поле комментария), полный экран, пустые экраны «замок» и «часы», новые «Главная» и «Закладки».
// Главное правило (CLAUDE.md): кадр покоя анимации совпадает со статичной иконкой — пока анимация грузится и после
// жеста ничего не мелькает и не сдвигается. Сравнивается картинка: статичная иконка рядом с анимацией в покое и
// анимация до и после жеста. Ещё — мягкое проявление заглушки, вставленной в уже показанный экран.
// Окно offscreen (в нём идут анимации и снимается картинка). Запуск: npx electron test/lottie-icons.js
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');

const MARKERS = { eye: ['hide', 'show'], fullscreen: ['enter', 'exit'], 'hover-settings': ['hover'], 'hover-tune': ['hover'], 'hover-sort': ['hover'],
  'hover-shuffle': ['hover'], 'hover-history': ['hover'], 'hover-trash': ['hover'], 'empty-lock': ['intro', 'loop'], 'empty-history': ['intro', 'loop'],
  'nav-home': ['select'], 'nav-bookmarks': ['select'] };
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };
for (const [name, need] of Object.entries(MARKERS)) {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'lottie', `${name}.json`), 'utf8'));
  const have = (j.markers || []).map((m) => m.cm);
  check(need.every((m) => have.includes(m)) && j.layers.length > 0, `${name}.json: слои и маркеры ${need.join(', ')}`);
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  const srv = await start(0);
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`(async () => {
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    window.__until = async (fn, max = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { if (fn()) return true; await sleep(30); } return false; };
    window.__anim = (el) => window.lottie?.getRegisteredAnimations().find((a) => el.contains(a.wrapper));
    window.__ui = await import('/js/ui.js'); window.__lt = await import('/js/lottie.js'); window.__common = await import('/js/screens/common.js');
    const box = document.createElement('div'); box.id = 'lt-box';
    Object.assign(box.style, { position: 'fixed', left: '0', top: '0', zIndex: 999, background: '#121212', color: '#bdbdbd', padding: '0', width: '900px', height: '700px' });
    document.body.append(box);
  })()`);
  // разница картинок двух прямоугольников окна (0…255 на пиксель)
  const shot = async (r) => (await win.webContents.capturePage(r)).toBitmap();
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return s / (a.length / 4) / 3; };

  // 1. Жесты при наведении: кнопка с анимацией, покой = статичная иконка, жест проигрывается и возвращается в покой
  const HOVER = ['ic_settings', 'ic_tune', 'ic_sort', 'ic_shuffle', 'ic_history', 'ic_trash_outline'];
  for (const [i, name] of HOVER.entries()) {
    const x = 20 + i * 120;
    const ok = await js(`(async () => {
      const { h, icon, iconButton } = window.__ui;
      const btn = iconButton('${name}', 'тест');
      const ref = h('span', { style: { position: 'absolute', left: '${x + 60}px', top: '20px', width: '48px', height: '48px', display: 'grid', placeItems: 'center' } }, h('button', { class: 'icon-btn' }, icon('${name}'))); // эталон — в такой же кнопке (тот же цвет)
      const wrap = h('span', { style: { position: 'absolute', left: '${x}px', top: '20px', width: '48px', height: '48px', display: 'grid', placeItems: 'center' } }, btn);
      document.getElementById('lt-box').append(wrap, ref);
      window.__btn = btn;
      return !!btn.querySelector('.lt') && await window.__until(() => btn.querySelector('.lt').classList.contains('lt-on'));
    })()`);
    check(ok, `${name}: кнопка с анимированной иконкой (загрузилась)`);
    if (!ok) continue;
    await js('new Promise((ok) => setTimeout(ok, 150))');
    const icRect = { x: x + 12, y: 32, width: 24, height: 24 }; const refRect = { x: x + 72, y: 32, width: 24, height: 24 };
    const rest = await shot(icRect); const ref = await shot(refRect);
    if (process.env.SHOTS) { const big = { x: x + 4, y: 24, width: 104, height: 40 }; fs.writeFileSync(path.join(process.env.SHOTS, `${name}.png`), (await win.webContents.capturePage(big)).resize({ width: 520 }).toPNG()); }
    const d0 = diff(rest, ref);
    check(d0 < 6, `${name}: в покое — как статичная иконка (разница ${d0.toFixed(1)})`);
    const played = await js(`(async () => {
      const el = window.__btn.querySelector('.lt'); window.__btn.dispatchEvent(new PointerEvent('pointerenter'));
      await new Promise((ok) => setTimeout(ok, 120)); const a = window.__anim(el); const moving = !!a && !a.isPaused;
      const done = await window.__until(() => window.__anim(el)?.isPaused, 2000);
      return moving && done;
    })()`);
    check(played, `${name}: наведение — жест проигрывается и заканчивается`);
    await js('new Promise((ok) => setTimeout(ok, 100))');
    const d1 = diff(rest, await shot(icRect));
    check(d1 < 4, `${name}: после жеста — снова иконка в покое, ничего не сдвинулось (разница ${d1.toFixed(1)})`);
  }

  // 2. Глаз в поле комментария: спойлер включили — перечёркнут (конец hide), выключили — открыт (конец show)
  const eye = await js(`(async () => {
    const c = window.__common.commentComposer({ onSend: async () => true });
    c.style.cssText = 'position:absolute;left:20px;top:120px;width:500px'; document.getElementById('lt-box').append(c);
    const btn = c.querySelector('.composer-spoiler'); const el = btn.querySelector('.lt');
    if (!el) return { lt: false };
    await window.__until(() => el.classList.contains('lt-on'));
    const frame = () => { const a = window.__anim(el); return Math.round(a.currentFrame + a.firstFrame); };
    const start = frame();
    btn.click(); await new Promise((ok) => setTimeout(ok, 60)); const playing = !window.__anim(el).isPaused;
    await window.__until(() => window.__anim(el).isPaused, 2000); const on = frame(); const pressed = btn.getAttribute('aria-pressed');
    btn.click(); await window.__until(() => window.__anim(el).isPaused && frame() !== on, 2000); const off = frame();
    return { lt: true, start, playing, on, off, pressed };
  })()`);
  check(eye.lt, 'спойлер: значок — анимированный глаз');
  if (eye.lt) {
    check(eye.playing && eye.pressed === 'true' && eye.on === 17, `спойлер включён — глаз перечёркивается (кадр ${eye.on})`);
    check(eye.off === 33 && [0, 33].includes(eye.start), `спойлер выключен — глаз снова открыт (кадр ${eye.off})`);
  }

  // 3. Полный экран: set(true) — уголки развернулись внутрь, set(false) — обратно
  const fsr = await js(`(async () => {
    const el = window.__lt.fullscreenIcon(); el.style.cssText = 'position:absolute;left:600px;top:120px;width:24px;height:24px';
    document.getElementById('lt-box').append(el);
    await window.__until(() => el.classList.contains('lt-on'));
    const frame = () => { const a = window.__anim(el); return Math.round(a.currentFrame + a.firstFrame); };
    el.set(true); await new Promise((ok) => setTimeout(ok, 40)); await window.__until(() => window.__anim(el).isPaused, 2000); const on = frame();
    el.set(false); await new Promise((ok) => setTimeout(ok, 40)); await window.__until(() => window.__anim(el).isPaused, 2000); const off = frame();
    return { on, off };
  })()`);
  check(fsr.on === 17 && fsr.off === 35, `полный экран: уголки внутрь и обратно (кадры ${fsr.on} → ${fsr.off})`);

  // 4. Пустые экраны «замок» и «часы» — анимированы, до готовности — пустое место (без мелькания статичной иконки)
  for (const ic of ['ic_lock', 'ic_history']) {
    const r = await js(`(async () => {
      const e = window.__ui.emptyView('Пусто', null, '${ic}'); e.style.cssText = 'position:absolute;left:20px;top:250px;width:300px';
      document.getElementById('lt-box').append(e); const el = e.querySelector('.lt');
      if (!el) return { lt: false };
      const blank = getComputedStyle(el).backgroundImage === 'none' || el.classList.contains('lt-on');
      const on = await window.__until(() => el.classList.contains('lt-on'));
      const intro = await window.__until(() => window.__anim(el) && !window.__anim(el).isPaused, 1500);
      e.remove(); return { lt: true, blank, on, intro };
    })()`);
    check(r.lt && r.blank && r.on && r.intro, `пустой экран ${ic}: анимация (вступление), до готовности — пусто`);
  }

  // 5. Заглушка, вставленная в уже показанный экран, — мягко проявляется (вставала рывком); на экране, который ещё
  // въезжает, — без своей анимации (едет вместе с ним)
  const soft = await js(`(async () => {
    const scr = document.createElement('div'); scr.className = 'screen'; const root = document.createElement('div'); scr.append(root);
    scr.style.cssText = 'position:absolute;left:400px;top:250px;width:400px;height:300px'; document.getElementById('lt-box').append(scr);
    const e = window.__ui.emptyView('Пусто'); root.append(e);
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    const own = e.getAnimations().some((a) => a.effect.getKeyframes().some((k) => Number(k.opacity) === 0));
    const minOp = Number(getComputedStyle(e).opacity);
    // экран въезжает: ui.enterScreen — заглушка внутри уже двигающегося блока своей анимации не получает
    const scr2 = document.createElement('div'); scr2.className = 'screen'; const r2 = document.createElement('div'); scr2.append(r2);
    document.getElementById('lt-box').append(scr2); window.__ui.enterScreen(scr2, 'forward');
    const e2 = window.__ui.emptyView('Пусто'); r2.append(e2);
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    const own2 = e2.getAnimations().length;
    return { own, minOp, own2 };
  })()`);
  check(soft.own && soft.minOp < 0.9, `заглушка на показанном экране — проявляется (видимость в начале ${soft.minOp.toFixed(2)})`);
  check(soft.own2 === 0, 'заглушка на въезжающем экране — без своей анимации (одна анимация на переход)');

  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
