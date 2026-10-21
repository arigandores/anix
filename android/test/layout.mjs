// Вёрстка на телефоне — все экраны (список как в test/transitions-audit.js), тёмная и светлая тема:
// нет горизонтальной прокрутки и вылезающих за край блоков (кроме лент, которые листаются вбок), кнопки не меньше
// пальца, текст не мельче 11 px, нижнее меню не закрывает конец экрана, полосы системы — в цвет темы.
// Скриншоты каждого экрана — android/test/shots/layout-<экран>-<тема>.png (смотреть глазами при изменениях)
import { ensureDevice, install, launch, js, until, check, skip, done, sleep, screenshot, windowState, pageErrors, sh } from './_device.mjs';

const MIN_TAP = 32; // CSS px: меньше — промахиваешься пальцем (Material: 48 dp с полями, сама кнопка — от 32)
const ONLY = process.argv.slice(2);

// ANIX_FONT_SCALE=1.3 — крупный шрифт в настройках Android (WebView увеличивает текст вслед за ним)
const FONT = process.env.ANIX_FONT_SCALE || '';
// ANIX_LANDSCAPE=1 — телефон повёрнут горизонтально (вне плеера): ширина больше 720 px — раскладка с боковым меню
const LAND = process.env.ANIX_LANDSCAPE === '1';
await ensureDevice();
install();
await launch({ fresh: true });
// поворот мог закончиться уже после запуска — страница подстраивается на лету (configChanges: без пересоздания окна);
// только что загруженный эмулятор под нагрузкой (4 параллельно) поворачивает страницу дольше 10 с
let landOk = !LAND || !!(await until('innerWidth > innerHeight', 25000));
if (!landOk) { // только что загруженный эмулятор сбросил поворот после ensureDevice — выставить заново
  sh('settings put system accelerometer_rotation 0'); sh('settings put system user_rotation 0'); await sleep(800); sh('settings put system user_rotation 1');
  landOk = !!(await until('innerWidth > innerHeight', 20000));
}
if (LAND) check('экран повёрнут горизонтально', landOk && (await windowState()).landscape, await js('[innerWidth, innerHeight]'));
if (FONT) check(`крупный шрифт ×${FONT} применён`, Math.abs((await js('anixAndroid.textZoom()')) - Number(FONT) * 100) < 2, await js('anixAndroid.textZoom()'));
const apiOk = (await js(`fetch('/api/config/toggles').then((r) => r.status)`)) < 500;
if (!apiOk) { skip('вёрстка', 'бекенд Anixart не отвечает'); done('layout'); }
const rid = await js(`import('/js/api.js').then((m) => m.A.releaseCollections ? fetch('/api/release/random').then((r) => r.json()).then(() => 40) : 40)`);
const cid = await js(`import('/js/api.js').then((m) => m.A.releaseCollections(40, 0, 1)).then((r) => r.content?.[0]?.id ?? null).catch(() => null)`);
const P1 = '{ profile: { id: 1 } }';
const SCREENS = [
  ...['home', 'discover', 'bookmarks', 'feed', 'profile'].map((t) => [`tab:${t}`, null]),
  ['release', `{ id: ${rid} }`], ['episodes', `{ release: { id: ${rid} } }`], ['search', '{ query: "Мастер Муси" }'], ['profile', '{ id: 1 }'],
  ['profile-lists', `{ profile: { id: 1 }, status: 1 }`], ['profile-comments', P1], ['profile-votes', P1], ['friends', P1],
  ['profile-collections', '{ profileId: 1 }'], ['collections', '{}'], ['top', '{}'], ['watching', '{}'], ['recommendations', '{}'],
  ['schedule', '{}'], ['notifications', '{}'], ['settings', '{}'], ['filter', '{}'], ['channels', '{}'],
  ['comments', `{ kind: "release", id: ${rid} }`], ['release-collections', `{ release: { id: ${rid} } }`], ['feed-search', '{}'],
  ['auth', '{}'], ['signup', '{}'], ['restore', '{}'],
  ...(cid ? [['collection', `{ id: ${cid} }`]] : []),
].filter(([n]) => !ONLY.length || ONLY.some((o) => n.includes(o)));

// Проверки на показанном экране — одним вызовом в странице
const AUDIT = (minTap) => `(() => {
  const vw = innerWidth; const out = { overflow: [], small: [], tiny: [], wrapped: [], hidden: null, page: document.scrollingElement.scrollWidth - vw };
  const name = (e) => (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : e.tagName.toLowerCase());
  const scroller = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return p; if (s.overflowX === 'hidden' || s.overflow === 'hidden') return p; } return null; };
  const scr = document.querySelector('#viewport .screen:last-child') || document.body;
  const vis = (e) => { const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && Number(s.opacity) > 0.05; };
  for (const e of scr.querySelectorAll('*')) {
    if (e.closest('.skeleton, .sk-root, [hidden], .lt svg') || !vis(e)) continue;
    const r = e.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !scroller(e)) out.overflow.push(name(e) + ' ' + Math.round(r.left) + '…' + Math.round(r.right));
    const interactive = e.matches('button, a[href], [role="button"], [role="tab"], .menu-item, .chip, input:not([type="checkbox"]), select, textarea');
    if (interactive && !e.disabled && r.top < innerHeight && r.bottom > 0 && !e.closest('.ep-row, .release-row') ) {
      // поле нажатия шире самой кнопки (android.css: ::after с отрицательным inset) — считаем его
      const af = getComputedStyle(e, '::after'); const grow = (v) => (af.content !== 'none' && af.position === 'absolute' ? Math.max(0, -parseFloat(v) || 0) : 0);
      const m = Math.min(r.width + grow(af.left) + grow(af.right), r.height + grow(af.top) + grow(af.bottom));
      if (m < ${minTap}) out.small.push(name(e) + ' ' + Math.round(r.width) + '×' + Math.round(r.height) + ' «' + (e.title || e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 20) + '»');
    }
    // подпись кнопки, чипа, вкладки, строки поиска — в одну строку (перенос — значит, ей не хватило места)
    if (e.matches('button, [role="button"], [role="tab"], .wchip, .chip, .nav-item, .searchbar .placeholder') && !e.closest('.ep-row, .release-row, .menu-item, .type-row, .pop-item, .sheet-item, .comment .text')) {
      for (const n of e.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        const tops = new Set([...rg.getClientRects()].map((x) => Math.round(x.top)));
        if (tops.size > 1) out.wrapped.push(name(e) + ' «' + n.textContent.trim().slice(0, 24) + '»');
      }
    }
    if (e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      const fs = parseFloat(getComputedStyle(e).fontSize);
      if (fs < 11) out.tiny.push(name(e) + ' ' + fs + 'px «' + e.textContent.trim().slice(0, 20) + '»');
    }
  }
  const nav = document.getElementById('bottomnav');
  const navTop = nav && nav.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight;
  const vp = document.getElementById('viewport');
  const before = vp.scrollTop; vp.scrollTop = vp.scrollHeight;
  const last = [...scr.querySelectorAll('*')].filter((e) => vis(e) && !e.closest('.skeleton, .sk-root') && e.children.length === 0 && getComputedStyle(e).position !== 'fixed' && !e.closest('.appbar, .tabbar, .wchips')).map((e) => e.getBoundingClientRect().bottom);
  const lastBottom = last.length ? Math.max(...last) : 0;
  out.hidden = lastBottom > navTop + 1 ? Math.round(lastBottom - navTop) : 0;
  vp.scrollTop = before;
  out.overflow = [...new Set(out.overflow)].slice(0, 6); out.small = [...new Set(out.small)].slice(0, 8); out.tiny = [...new Set(out.tiny)].slice(0, 6); out.wrapped = [...new Set(out.wrapped)].slice(0, 6);
  return out;
})()`;

const issues = [];
for (const theme of ['dark', 'light']) {
  await js(`import('/js/store.js').then((m) => (m.setTheme('${theme}'), 1))`);
  await sleep(500);
  const w = await windowState();
  check(`${theme}: значки системных полос в цвет темы`, w.darkBars === (theme === 'dark'), w);
  // все вкладки меню (нижнего или бокового) — целиком на экране: до каждой можно дотянуться
  const navs = await js(`[...document.querySelectorAll('#rail .nav-item, #bottomnav .nav-item')].filter((b) => b.getClientRects().length).map((b) => { const r = b.getBoundingClientRect(); return { tab: b.dataset.tab, ok: r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1 }; })`);
  check(`${theme}: все ${navs.length} вкладки меню видны целиком`, navs.length === 5 && navs.every((n) => n.ok), navs.filter((n) => !n.ok).map((n) => n.tab));
  for (const [n, p] of SCREENS) {
    // переход — не дожидаясь обещания import() в вызове DevTools: на телефоне боком оно изредка оставалось ждать, и
    // DevTools отвечал «Promise was collected»; экран дожидаемся по его имени (router.js — body.dataset.screen)
    const go = n.startsWith('tab:') ? `(import('/js/router.js').then((m) => m.switchTab('${n.slice(4)}', { reset: true })), 1)` : `(import('/js/router.js').then((m) => m.navigate('${n}', ${p})), 1)`;
    await js(go);
    check(`${theme} ${n}: экран открылся`, !!(await until(`document.body.dataset.screen === ${JSON.stringify(n)}`, 15000)), await js('document.body.dataset.screen'));
    await until(`!document.querySelector('#viewport .screen:last-child .sk-root, #viewport .screen:last-child .skeleton')`, 12000);
    await sleep(900);
    const a = await js(AUDIT(MIN_TAP));
    const label = `${theme} ${n}`;
    check(`${label}: без горизонтальной прокрутки и вылезающих блоков`, a.page <= 1 && !a.overflow.length, a.overflow.length ? a.overflow : a.page);
    check(`${label}: кнопки не меньше ${MIN_TAP}px`, !a.small.length, a.small);
    check(`${label}: текст не мельче 11px`, !a.tiny.length, a.tiny);
    check(`${label}: подписи кнопок, чипов и вкладок — в одну строку`, !a.wrapped.length, a.wrapped);
    check(`${label}: нижнее меню не закрывает конец экрана`, a.hidden <= 1, a.hidden);
    if (theme === 'dark' || /tab:home|release|episodes|settings/.test(n)) screenshot(`layout-${n.replace(':', '-')}-${theme}${FONT ? `-font${FONT}` : ''}${LAND ? '-land' : ''}`);
    if (!n.startsWith('tab:')) await js(`history.back(), 1`);
    await sleep(500);
    void issues;
  }
}
await js(`import('/js/store.js').then((m) => (m.setTheme('dark'), 1))`);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('layout');

