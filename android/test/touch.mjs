// Палец на телефоне: нажатие без синей подсветки WebView; отступы карточек слева и справа одинаковые (полоса прокрутки
// не занимает колонку справа); свайп влево-вправо по содержимому переключает вкладки (главная, «Популярное»):
// длинный и быстрый короткий — соседняя вкладка, короткий медленный и у крайней вкладки — остаётся, вертикальный —
// прокрутка; карусель внутри вкладки листается сама, вкладку не меняет
import { ensureDevice, install, launch, js, until, check, skip, done, tap, sleep, sh, screenshot, REAL, pageErrors, waitFor } from './_device.mjs';

// видимые вкладки текущего экрана (экраны под ним в DOM, но скрыты)
const TABS = `[...document.querySelectorAll('.tabs')].filter((e) => e.getClientRects().length).pop()`;
const active = () => js(`(() => { const t = ${TABS}; return t ? [...t.querySelectorAll('.tabbar .tab')].findIndex((b) => b.classList.contains('active')) : -1; })()`);
// после свайпа всё на месте: анимации кончились, в .tabbody одна вкладка без сдвига, полоска под активной вкладкой
const settled = () => until(`(() => {
  const t = ${TABS}; if (!t) return false;
  const body = t.querySelector('.tabbody'); const page = body.firstElementChild;
  const tab = t.querySelector('.tabbar .tab.active'); const ink = t.querySelector('.tab-ink');
  const inkX = Number(/translateX\\(([-\\d.]+)px\\)/.exec(ink.style.transform)?.[1]);
  return !body.classList.contains('swiping') && body.children.length === 1 && !page.style.transform && !page.getAnimations().length
    && Math.abs(inkX - tab.offsetLeft) < 1 && Math.abs(parseFloat(ink.style.width) - tab.offsetWidth) < 1 && !ink.getAnimations().length;
})()`, 4000, 100);
// свайп пальцем по содержимому вкладки: from/to — доли ширины экрана, на высоте 60% видимой части содержимого;
// below — по пустому месту ниже содержимого (над нижним меню): возвращает, правда ли палец был ниже
async function swipe(from, to, ms = 300, page = `${TABS}.querySelector('.tabbody')`, { below = false } = {}) {
  const p = await js(`(() => {
    const r = ${page}.getBoundingClientRect();
    const [ox, oy] = anixAndroid.webOrigin().split(',').map(Number);
    const top = Math.max(r.top, 0); const bottom = Math.min(r.bottom, innerHeight - 90);
    const navTop = document.getElementById('bottomnav')?.getBoundingClientRect().top ?? innerHeight;
    const y = ${below} ? navTop - 40 : top + (bottom - top) * 0.6;
    return { y: Math.round(oy + y * devicePixelRatio), w: Math.round(innerWidth * devicePixelRatio), ox, under: y > r.bottom + 20 };
  })()`);
  sh(`input swipe ${p.ox + Math.round(p.w * from)} ${p.y} ${p.ox + Math.round(p.w * to)} ${p.y} ${ms}`);
  await sleep(150);
  if (page.includes('.tabbody')) await settled();
  else await until(`(() => { const b = ${page}; return !b.classList.contains('swiping') && b.children.length === 1 && !b.firstElementChild.style.transform && !b.firstElementChild.getAnimations().length; })()`, 4000, 100);
  return p.under;
}
// метка на содержимом вкладки: та же вкладка или сменилась
const mark = (v) => js(`(${TABS}.querySelector('.tabbody').firstElementChild.dataset.swipeMark = ${JSON.stringify(v)}, 1)`);
const marked = () => js(`${TABS}.querySelector('.tabbody').firstElementChild.dataset.swipeMark || ''`);

await ensureDevice();
install();
await launch({ fresh: true });
const apiOk = (await js(`fetch('/api/config/toggles').then((r) => r.status)`)) < 500;
if (!apiOk) { skip('touch', 'сервер Anixart недоступен — списков нет'); done('touch'); }
check('главная: список загрузился', !!(await until(`${REAL('.tabbody .release-row')} > 2`, 30000)));

// 1. Синяя подсветка нажатия
const hl = await js(`getComputedStyle(document.querySelector('.tabbody .release-row')).webkitTapHighlightColor`);
check('нажатие без синей подсветки WebView (tap-highlight прозрачный)', hl === 'rgba(0, 0, 0, 0)', hl);
await tap('.tabbody .release-row', { index: 1, after: 0 });
check('нажатие на карточку открывает аниме', !!(await waitFor(async () => (await js('Number(document.body.dataset.depth || 1)')) === 2, 8000, 200)));
sh('input keyevent 4'); await sleep(900);
await until(`Number(document.body.dataset.depth || 1) === 1`, 5000);

// 2. Отступы слева и справа
const gaps = await js(`(() => {
  const vp = document.getElementById('viewport');
  const row = [...document.querySelectorAll('.tabbody .release-row')].find((e) => e.getClientRects().length && !e.closest('.skeleton, .sk-root'));
  const r = row.getBoundingClientRect(); const bar = document.querySelector('.searchbar').getBoundingClientRect();
  return { gutter: vp.offsetWidth - vp.clientWidth, left: Math.round(r.left), right: Math.round(innerWidth - r.right), long: vp.scrollHeight > vp.clientHeight,
    barLeft: Math.round(bar.left), toolsRight: Math.round(innerWidth - [...document.querySelectorAll('.appbar .icon-btn')].filter((e) => e.getClientRects().length).pop().getBoundingClientRect().right) };
})()`);
check('полоса прокрутки не занимает колонку справа', gaps.gutter === 0 && gaps.long, JSON.stringify(gaps));
check('карточка: отступ справа равен левому', Math.abs(gaps.left - gaps.right) <= 1, JSON.stringify(gaps));
check('шапка: отступ справа равен левому', Math.abs(gaps.barLeft - gaps.toolsRight) <= 4, JSON.stringify(gaps));
screenshot('touch-home');

// 3. Свайпы на главной (по умолчанию открыта «Аниме», вкладка 1 из 5)
const start = await active();
check('главная открыта на вкладке «Аниме»', start === 1, start);
await mark('anime');
await swipe(0.8, 0.2);
check('свайп влево — следующая вкладка', await active() === 2 && await marked() !== 'anime', await active());
check('после свайпа — всё на месте (одна вкладка, без сдвига, полоска под вкладкой)', !!(await settled()));
check('новая вкладка загрузилась', !!(await until(`${REAL('.tabbody .release-row')} > 0`, 20000)));
await swipe(0.2, 0.8);
check('свайп вправо — назад, на «Аниме» (содержимое из памяти)', await active() === 1 && await marked() === 'anime', await active());
await swipe(0.55, 0.45, 600);
check('короткий медленный свайп — вкладка та же', await active() === 1 && await marked() === 'anime');
await swipe(0.6, 0.45, 60);
check('быстрое короткое смахивание — следующая вкладка', await active() === 2, await active());
await swipe(0.2, 0.8); await swipe(0.2, 0.8);
check('до первой вкладки «Моя вкладка»', await active() === 0, await active());
await mark('first');
await swipe(0.2, 0.8);
check('у первой вкладки свайп вправо — остаётся, содержимое вернулось на место', await active() === 0 && await marked() === 'first' && !!(await settled()));

// 4. Вертикальная прокрутка — не свайп
await swipe(0.8, 0.2); // на «Аниме»: длинный список
await until(`${REAL('.tabbody .release-row')} > 2`, 20000);
const top0 = await js(`document.getElementById('viewport').scrollTop`);
const p = await js(`(() => { const [ox, oy] = anixAndroid.webOrigin().split(',').map(Number); return { x: ox + Math.round(innerWidth * devicePixelRatio * 0.5), y1: oy + Math.round(innerHeight * devicePixelRatio * 0.7), y2: oy + Math.round(innerHeight * devicePixelRatio * 0.35) }; })()`);
sh(`input swipe ${p.x} ${p.y1} ${p.x + 40} ${p.y2} 300`); await sleep(800);
const top1 = await js(`document.getElementById('viewport').scrollTop`);
check('вертикальный жест — прокрутка, вкладка та же', top1 > top0 + 100 && await active() === 1, `${top0} → ${top1}`);
check('после прокрутки ничего не сдвинуто', !!(await settled()));

// 5. Карусель внутри вкладки листается сама (полоса с прокруткой по горизонтали — как .hscroll на других экранах)
await js(`(() => {
  const s = document.createElement('div'); s.className = 'hscroll test-hscroll';
  for (let i = 0; i < 12; i++) { const c = document.createElement('div'); c.style.cssText = 'flex:none;width:140px;height:120px;background:#444;border-radius:8px'; s.append(c); }
  const page = ${TABS}.querySelector('.tabbody').firstElementChild; page.prepend(s);
  document.getElementById('viewport').scrollTop = 0; return 1;
})()`);
await sleep(300);
const hs = await js(`(() => { const r = document.querySelector('.test-hscroll').getBoundingClientRect(); const [ox, oy] = anixAndroid.webOrigin().split(',').map(Number);
  return { y: oy + Math.round((r.top + r.height / 2) * devicePixelRatio), w: Math.round(innerWidth * devicePixelRatio), ox }; })()`);
sh(`input swipe ${hs.ox + Math.round(hs.w * 0.8)} ${hs.y} ${hs.ox + Math.round(hs.w * 0.2)} ${hs.y} 300`); await sleep(700);
check('свайп по карусели — листается карусель, вкладка та же', await js(`document.querySelector('.test-hscroll').scrollLeft`) > 50 && await active() === 1);
await js(`document.querySelector('.test-hscroll').remove(), 1`);

// 6. «Популярное» (Обзор → плитка): все четыре вкладки свайпом
await tap('#bottomnav .nav-item[data-tab="discover"]', { after: 800 });
await tap('.tile', { text: 'Популярное', after: 1200 });
check('«Популярное» открыто', !!(await until(`${REAL('.tabbody .release-row')} > 0`, 20000)));
for (let i = 1; i < 4; i++) { await swipe(0.85, 0.15); check(`«Популярное»: свайп — вкладка ${i + 1}`, await active() === i, await active()); }
await swipe(0.85, 0.15);
check('«Популярное»: у последней вкладки свайп влево — остаётся', await active() === 3 && !!(await settled()));
await tap(`.tabbar .tab`, { index: 0, after: 600 });
check('нажатие на вкладку по-прежнему переключает', await active() === 0 && !!(await settled()));
screenshot('touch-popular');

// 7. Настройки: разделы («Вид», «Плеер», …) — тоже свайпом
sh('input keyevent 4'); await sleep(900);
await tap('#bottomnav .nav-item[data-tab="home"]', { after: 800 });
await tap('[title="Настройки"]', { after: 1200 });
const SET = `document.querySelector('.settings-body')`;
const sections = () => js(`[...document.querySelectorAll('.settings-tab')].map((b) => b.dataset.section)`);
const section = () => js(`document.querySelector('.settings-tab.active')?.dataset.section`);
const list = await sections();
const s0 = await section(); const i0 = list.indexOf(s0);
check('настройки открыты', !!(await until(`!!${SET}?.firstElementChild`, 8000)) && i0 >= 0, s0);
// по пустому месту ниже пунктов раздела (на телефоне это полэкрана): свайп там не делал ничего
const under = await swipe(0.85, 0.15, 300, SET, { below: true });
check('настройки: палец ниже пунктов раздела', under);
check('настройки: свайп влево по пустому месту ниже пунктов — следующий раздел', await section() === list[i0 + 1], `${s0} → ${await section()}`);
check('раздел на месте, прежний ушёл', await js(`${SET}.children.length === 1 && ${SET}.firstElementChild.dataset.section === document.querySelector('.settings-tab.active').dataset.section`));
await swipe(0.15, 0.85, 300, SET);
check('настройки: свайп вправо по пунктам — обратно', await section() === s0, await section());
if (i0 === 0) {
  await swipe(0.15, 0.85, 300, SET);
  check('настройки: у первого раздела свайп вправо — остаётся', await section() === s0);
}
screenshot('touch-settings');

check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('touch');
