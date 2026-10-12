'use strict';
// Проверка вёрстки, выполняемая в странице (для test/layout-audit.js)
module.exports = `(() => {
  const out = [];
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity !== 0; };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
  const text = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const de = document.scrollingElement;
  if (de.scrollWidth > innerWidth + 1) out.push({ kind: 'page-scroll-x', el: 'document', px: de.scrollWidth - innerWidth });
  const roots = [...document.querySelectorAll('#viewport, .backdrop')].filter(vis);
  for (const root of roots) {
    const rr = root.getBoundingClientRect();
    const right = rr.left + root.clientWidth; // без полосы прокрутки
    for (const el of root.querySelectorAll('*')) {
      if (!vis(el)) continue;
      const s = getComputedStyle(el);
      if (s.position === 'fixed') continue;
      // ближайший предок с обрезкой по горизонтали (ниже root)
      let clip = null;
      for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== 'visible') { clip = a; break; }
      }
      // лента с горизонтальной прокруткой — так задумано; диалог и прочие контейнеры с вертикальной прокруткой — граница
      const carousel = (c) => c.matches('.tabbar.scrollable, .hscroll, .banners, .screens')
        || (/auto|scroll/.test(getComputedStyle(c).overflowX) && !c.matches('.dialog') && c.scrollHeight <= c.clientHeight + 1);
      if (clip && carousel(clip)) continue;
      if (el.matches('.rel-hero > .bg')) continue; // размытая подложка шапки релиза выходит за край намеренно
      const r = el.getBoundingClientRect();
      // граница — область содержимого контейнера (без отступов): иначе вылет в поля карточки не виден
      const contentBox = (c) => { const q = c.getBoundingClientRect(); const cs = getComputedStyle(c);
        const l = q.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        return { left: l, right: l + c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) }; };
      const box = clip ? contentBox(clip) : { left: rr.left, right };
      const over = Math.max(box.left - r.left, r.right - box.right);
      const ellipsis = (e) => getComputedStyle(e).textOverflow === 'ellipsis';
      if (over > 2) {
        // сообщаем только о самом внешнем вылезающем элементе
        const pr = el.parentElement.getBoundingClientRect();
        const parentOver = Math.max(box.left - pr.left, pr.right - box.right);
        if (parentOver <= 2) out.push({ kind: clip ? 'clipped' : 'outside-viewport', el: name(el), parent: name(el.parentElement), px: Math.round(over), text: text(el) });
      }
      // текст шире своего блока: вылезает (visible) или обрезан без многоточия (hidden)
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && !ellipsis(el)) {
        out.push({ kind: s.overflowX === 'visible' ? 'text-overflow' : 'text-clipped', el: name(el), px: el.scrollWidth - el.clientWidth, text: text(el) });
      }
    }
  }
  return out;
})()`;
