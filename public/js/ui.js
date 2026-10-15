// Мини-набор UI-примитивов (аналог Material-компонентов приложения).

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
        }
      }
      else if (k === 'onclick' && typeof v === 'function') el.addEventListener('click', guardClick(el, v));
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

// Асинхронный обработчик клика (запрос, диалог) — один за раз: пока он не завершился, повторные клики
// по этому элементу игнорируются (двойной клик не отправляет запрос дважды). Синхронные — как есть.
export function guardClick(el, fn) {
  return (e) => {
    if (el.dataset.busy) { e?.stopPropagation(); return undefined; } // и не до родителя (кнопка в строке-ссылке)
    const r = fn(e);
    if (r && typeof r.then === 'function') {
      el.dataset.busy = '1';
      Promise.resolve(r).finally(() => { delete el.dataset.busy; });
    }
    return r;
  };
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(name, cls = '') {
  return h('span', { class: `ic ${cls}`, style: { '--ic': `url(/icons/${name}.svg)` }, 'aria-hidden': 'true' });
}

export function iconButton(name, title, onClick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, title, 'aria-label': title, onclick: onClick }, icon(name));
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Toast ---
let toastTimer;
export function toast(msg, ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) el = h('div', { id: 'toast', role: 'status' });
  if (el.parentNode !== overlayHost()) overlayHost().append(el);
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// --- Диалоги / bottom sheets ---
export function dialog({ title, content, actions = [], onClose, cls = '' } = {}) {
  const backdrop = h('div', { class: 'backdrop' });
  const box = h('div', { class: `dialog ${cls}`, role: 'dialog', 'aria-modal': 'true' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.classList.add('closing'); // плавное закрытие, затем удаление
    setTimeout(() => backdrop.remove(), 160);
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  if (title) box.append(h('div', { class: 'dialog-title' }, title));
  if (content) box.append(h('div', { class: 'dialog-content' }, content));
  if (actions.length) {
    box.append(h('div', { class: 'dialog-actions' }, actions.map((a) => h('button', {
      class: `btn ${a.primary ? 'btn-primary' : 'btn-text'}`,
      onclick: async () => { const keep = a.onClick ? await a.onClick() : false; if (keep !== true) close(); },
    }, a.label))));
  }
  backdrop.append(box);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  overlayHost().append(backdrop);
  return { close, box };
}

// Куда вставлять диалоги и уведомления: в полноэкранном режиме браузер показывает только полноэкранный
// элемент (плеер) — то, что вставлено в body, не видно
function overlayHost() { return document.fullscreenElement || document.body; }

export function sheet(title, items) {
  // items: [{label, icon, dot (CSS-цвет точки), color (цвет текста), onClick, checked, danger}]
  const list = h('div', { class: 'sheet-list' });
  const d = dialog({ title, content: list, cls: 'sheet' });
  for (const it of items) {
    if (!it) continue;
    const btn = h('button', {
      class: `sheet-item ${it.checked ? 'checked' : ''} ${it.danger ? 'danger' : ''}`,
      onclick: () => { d.close(); it.onClick && it.onClick(); },
    },
    it.dot ? h('span', { class: 'dot', style: { background: it.dot } }) : null,
    it.icon ? icon(it.icon) : null,
    h('span', null, it.label),
    it.checked ? icon('ic_check', 'end') : null);
    if (it.color) btn.style.color = it.color;
    list.append(btn);
  }
  return d;
}

export function confirmDialog(title, text, okLabel = 'Да') {
  return new Promise((resolve) => {
    let done = false;
    dialog({
      title, content: h('p', null, text),
      actions: [
        { label: 'Отмена', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, primary: true, onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function prompt(title, { value = '', placeholder = '', multiline = false, okLabel = 'Готово' } = {}) {
  return new Promise((resolve) => {
    const input = multiline
      ? h('textarea', { class: 'input', rows: 4, placeholder })
      : h('input', { class: 'input', placeholder });
    input.value = value;
    let done = false;
    dialog({
      title, content: input,
      actions: [
        { label: 'Отмена', onClick: () => { done = true; resolve(null); } },
        { label: okLabel, primary: true, onClick: () => { done = true; resolve(input.value); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    setTimeout(() => input.focus(), 30);
  });
}

// --- Загрузка / ошибки ---
export function spinner() { return h('div', { class: 'spinner-wrap' }, h('div', { class: 'spinner' })); }

// Скелетоны: повторяют раскладку настоящих элементов (release-row, release-card, comment…),
// чтобы при подгрузке контент вставал на то же место без прыжков.
const line = (w, cls = '', extra = {}) => h('div', { class: `sk sk-line ${cls}`, style: { width: w, ...extra } });
const block = (style) => h('div', { class: 'sk', style });
const circle = (size) => block({ width: size, height: size, borderRadius: '50%', flex: 'none' });
const pill = (w, height = '40px') => block({ width: w, height, borderRadius: `calc(${height} / 2)`, flex: 'none' });
const col = (gap, ...c) => h('div', { class: 'grow', style: { display: 'flex', flexDirection: 'column', gap } }, ...c);
const skRow = () => h('div', { class: 'release-row' }, h('div', { class: 'poster sk' }),
  h('div', { class: 'info', style: { gap: '9px', paddingTop: '4px' } }, line('72%', 'title'), line('38%'), line('94%', '', { marginTop: '6px' }), line('88%'), line('60%')));
const skCard = (style) => h('div', { class: 'release-card', style }, h('div', { class: 'poster sk' }), line('86%', 'title'), line('52%'));
const skComment = () => h('div', { class: 'comment' }, h('div', { class: 'avatar sk' }),
  h('div', { class: 'body', style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px' } }, line('34%', 'title'), line('92%'), line('70%'), line('24%', '', { marginTop: '4px' })));
const skMenu = () => h('div', { class: 'menu-item' }, circle('24px'), col('7px', line('40%', 'title'), line('64%')));
// серия: номер, название и источник, справа кнопка-глаз (icon-btn sm)
const skEp = () => h('div', { class: 'ep-row' }, h('div', { class: 'num sk' }), col('7px', line('30%', 'title'), line('18%')),
  h('div', { class: 'icon-btn sm' }, circle('20px')));
const skArticle = () => h('div', { class: 'article' },
  h('div', { class: 'head' }, h('div', { class: 'avatar sk' }), col('7px', line('22%', 'title'), line('14%'))),
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, line('96%'), line('82%'), block({ height: '260px', borderRadius: '12px', marginTop: '4px' })),
  h('div', { class: 'foot' }, pill('54px', '28px'), pill('44px', '28px'), h('div', { class: 'grow' }), pill('96px', '28px')));
// каналы (channelRow): аватар, название, подписчики, кнопка «Подписаться»
const skChannel = () => h('div', { class: 'type-row' }, circle('44px'), col('7px', line('36%', 'title'), line('22%')), pill('124px'));
// люди (profileRow): аватар 40, ник, число друзей
const skProfile = () => h('div', { class: 'type-row' }, circle('40px'), col('7px', line('28%', 'title'), line('16%')));
// уведомление: аватар/постер слева, текст в 2 строки, время
const skNotif = () => h('div', { class: 'comment' }, circle('40px'), col('7px', line('88%'), line('56%'), line('18%', '', { marginTop: '2px' })));
// настройка с переключателем
const skSwitch = () => h('div', { class: 'menu-item' }, circle('24px'), col('0', line('42%', 'title')), block({ width: '44px', height: '24px', borderRadius: '12px', flex: 'none' }));
// озвучка/источник (type-row): иконка-круг, название, подпись, стрелка
const skType = () => h('div', { class: 'type-row' }, circle('44px'), col('7px', line('34%', 'title'), line('48%')), circle('20px'));
const skVideo = () => h('div', { class: 'release-card', style: { width: '260px', flex: 'none' } }, h('div', { class: 'poster sk', style: { aspectRatio: '16/9', width: '100%' } }), line('80%', 'title'), line('50%'));
export const skLine = line;
export const skParts = { line, block, circle, pill, col };
const times = (n, f) => Array.from({ length: n }, (_, i) => f(i));

// --- Когда показывать загрузку ---
// Скелетон (.sk-root и одиночные .sk) и спиннер проявляются только если загрузка дольше SK_DELAY
// (анимация sk-reveal в app.css), а показавшись, держатся не меньше SK_MIN — иначе мелькают на кадр.
// Если за видимым скелетоном сразу идёт следующий (экран загрузил шапку и грузит список, автопереход
// между экранами), новый продолжает отсчёт предыдущего: уже показанный не прячется заново.
const SK_DELAY = 250; const SK_MIN = 400; const SK_CHAIN = 300;
const SK_SEL = '.sk-root, .sk, .spinner-wrap, .load-reveal';
let skHandoff = { at: -Infinity, revealAt: 0 }; // когда сменили скелетон и когда тот начал (или начнёт) проявляться
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Задержка появления для нового скелетона: обычная или остаток от только что сменённого (может быть < 0)
export function skRevealDelay() {
  const now = performance.now();
  return now - skHandoff.at < SK_CHAIN ? skHandoff.revealAt - now : SK_DELAY;
}
function skStyle() { return { '--sk-delay': `${Math.round(skRevealDelay())}ms` }; }

// Вызывать перед заменой скелетона контентом: ждёт, только если скелетон уже виден и показан меньше SK_MIN.
// Время берётся из самой CSS-анимации — у скелетона, не вставленного на страницу, её нет.
// Возвращает true, если скелетон был виден: тогда контент ставится на его место сразу, без анимации
// появления (markAppeared) — иначе между скелетоном и проявляющимся контентом мелькает пустота.
export async function skeletonSettled(scope) {
  const sk = scope?.matches?.(SK_SEL) ? scope : scope?.querySelector?.(SK_SEL);
  const anim = sk?.isConnected && sk.getAnimations().find((a) => a.animationName === 'sk-reveal');
  if (!anim) return false;
  const shown = Number(anim.currentTime) - Number(anim.effect.getTiming().delay); // < 0 — ещё не проявился
  const revealAt = performance.now() - shown;
  if (shown >= 0 && shown < SK_MIN) await sleep(SK_MIN - shown);
  skHandoff = { at: performance.now(), revealAt };
  return shown >= 0;
}

export function skeleton(kind = 'rows', n, { recs = false } = {}) {
  const wrap = (...c) => h('div', { class: 'skeleton sk-root', 'aria-busy': 'true', 'aria-label': 'Загрузка', style: skStyle() }, ...c);
  switch (kind) {
    case 'cards': return wrap(h('div', { class: 'grid' }, times(n || 12, () => skCard())));
    case 'hcards': return wrap(h('div', { class: 'hscroll' }, times(n || 8, () => skCard())));
    case 'comments': return wrap(times(n || 6, skComment));
    case 'menu': return wrap(h('div', { class: 'menu-list' }, times(n || 8, skMenu)));
    case 'switches': return wrap(h('div', { class: 'menu-list', style: { maxWidth: '760px' } }, times(n || 8, skSwitch)));
    case 'channels': return wrap(times(n || 8, skChannel));
    case 'profiles': return wrap(times(n || 8, skProfile));
    case 'profiles1': return wrap(times(n || 8, () => h('div', { class: 'type-row' }, circle('40px'), col('0', line('30%', 'title'))))); // только ник (поиск)
    case 'notifications': return wrap(times(n || 8, skNotif));
    case 'types': return wrap(h('div', { class: 'list' }, times(n || 6, skType)));
    case 'episodes': return wrap(times(n || 10, skEp));
    case 'articles': return wrap(times(n || 2, skArticle));
    case 'videos': return wrap(times(n || 2, () => [h('div', { class: 'section-head' }, line('160px', 'title')), h('div', { class: 'hscroll' }, times(5, skVideo))]));
    // collectionCard в обычной сетке (.grid): обложка 16:9, название в 2 строки, счётчики
    case 'collections': return wrap(h('div', { class: 'grid' },
      times(n || 10, () => h('div', { class: 'release-card' }, h('div', { class: 'poster sk', style: { aspectRatio: '16/9' } }), line('90%', 'title'), line('60%', 'title'), line('45%')))));
    case 'schedule': return wrap(times(n || 3, () => [h('div', { class: 'day-title' }, line('130px', 'title', { margin: '4px 0' })),
      h('div', { class: 'hscroll' }, times(9, () => skCard({ width: '120px', flex: 'none' }))), h('div', { class: 'sep', style: { marginTop: '10px' } })]));
    // «Обзор»: баннеры, плитки, [рекомендации — только со входом], «Обсуждаемое сегодня»
    case 'discover': return wrap(
      h('div', { class: 'banners' }, times(3, () => h('div', { class: 'banner sk' }))),
      h('div', { class: 'tiles' }, times(5, () => block({ height: '68px', borderRadius: '14px' }))),
      recs ? [h('div', { class: 'section-head' }, col('6px', line('180px', 'title'), line('140px'))), h('div', { class: 'hscroll' }, times(8, () => skCard()))] : null,
      h('div', { class: 'section-head' }, line('200px', 'title')),
      h('div', { class: 'list' }, times(3, skRow)));
    case 'profile': return wrap(
      // profileView: шапка (аватар, ник, статус, строка с репутацией, кнопка) → карточки «Друзья» и «Статистика»
      h('div', { class: 'profile-head' }, h('div', { class: 'avatar lg sk' }),
        col('8px', line('200px', 'big'), line('150px'), line('300px'), h('div', { class: 'row', style: { marginTop: '8px' } }, pill('170px')))),
      h('div', { class: 'container', style: { padding: '0 24px 40px' } },
        h('div', { class: 'card' }, h('div', { class: 'row' }, circle('24px'), col('0', line('120px', 'title')), times(3, () => circle('40px')))),
        h('div', { class: 'card' }, line('130px', 'title', { height: '20px' }), block({ height: '10px', borderRadius: '5px', margin: '14px 0 12px' }),
          h('div', { class: 'stat-grid' }, times(5, () => block({ height: '64px', borderRadius: '12px' }))),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '14px' } }, line('60%'), line('48%'), line('36%')),
          h('div', { class: 'row', style: { marginTop: '14px', flexWrap: 'wrap' } }, pill('170px'), pill('100px'), pill('150px'), pill('140px')))));
    default: return wrap(h('div', { class: 'list' }, times(n || 6, skRow)));
  }
}
// Заглушка экрана целиком (если у экрана нет своей): панель с «Назад» + скелет содержимого
export function screenSkeleton(kind, { back = true } = {}) {
  return h('div', null,
    h('div', { class: 'appbar' }, back ? iconButton('ic_back', 'Назад', () => history.back()) : null),
    skeleton(kind));
}

export function errorView(err, retry) {
  return h('div', { class: 'empty' },
    icon('ic_error', 'big'),
    h('div', { class: 'empty-title' }, 'Не удалось загрузить данные'),
    h('div', { class: 'empty-sub' }, 'Проверьте подключение к интернету'),
    retry ? h('button', { class: 'btn btn-tonal', onclick: retry }, 'Повторить') : null,
    err ? h('div', { class: 'empty-err' }, String(err.message || err)) : null);
}

export function emptyView(title, sub, ic = 'ic_info_outline') {
  return h('div', { class: 'empty' }, icon(ic, 'big'), h('div', { class: 'empty-title' }, title), sub ? h('div', { class: 'empty-sub' }, sub) : null);
}

// Подменённый тихим обновлением контент показываем сразу, без анимации появления (.appeared в app.css)
const APPEAR_SEL = '.release-row, .release-card, .comment, .article, .ep-row, .type-row';
export function markAppeared(node) {
  if (node.matches?.(APPEAR_SEL)) node.classList.add('appeared');
  node.querySelectorAll?.(APPEAR_SEL).forEach((el) => el.classList.add('appeared'));
  return node;
}

// --- Бесконечный список (ответ: {code, content, total_count, total_page_count, current_page}) ---
export function pagedList({ load, render, container, empty, startPage = 0, grid = false, onFirst, pageSize = 25, skeleton: skKind }) {
  const list = container || h('div', { class: grid ? 'grid' : 'list' });
  const sentinel = h('div', { class: 'sentinel' });
  let page = startPage; let loading = false; let ended = false; let count = 0;
  let gen = 0; // поколение загрузки: ответы, пришедшие после reload/refresh, отбрасываются
  const host = h('div', { class: 'paged' }, list, sentinel);
  const isEnd = (r, items) => (typeof r.hasMore === 'boolean' ? !r.hasMore : items.length < (pageSize || 25));
  async function next() {
    if (loading || ended) return;
    loading = true;
    const my = gen;
    // первая страница — скелетон в раскладке списка, следующие — спиннер внизу
    if (count === 0 && skKind !== false) {
      list.style.display = 'none';
      sentinel.replaceChildren(skeleton(skKind || (grid ? 'cards' : 'rows')));
    } else sentinel.replaceChildren(spinner());
    try {
      const r = await load(page);
      if (my !== gen) return;
      const instant = await skeletonSettled(sentinel);
      if (my !== gen) return;
      const items = Array.isArray(r) ? r : (r.content || []);
      if (page === startPage && onFirst) onFirst(r);
      list.style.display = '';
      for (const it of items) { const node = render(it, count++); if (node) list.append(instant ? markAppeared(node) : node); }
      page += 1;
      // Следующая страница есть, только если пришло >= 25 элементов
      if (isEnd(r, items)) ended = true;
      sentinel.replaceChildren();
      if (ended && count === 0 && empty) sentinel.replaceChildren(empty());
    } catch (e) {
      if (my !== gen) return;
      list.style.display = '';
      sentinel.replaceChildren(errorView(e, () => { loading = false; next(); }));
      loading = false;
      return;
    }
    loading = false;
    if (!ended && isVisible(sentinel)) next();
  }
  const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) next(); }, { rootMargin: '600px' });
  io.observe(sentinel);
  // первую страницу грузим сразу, не дожидаясь появления списка на странице: экран может дождаться
  // данных до показа (router.js) и появиться уже с контентом. Микрозадача — после кода, создавшего список.
  queueMicrotask(() => next());
  host.reload = () => { gen += 1; list.replaceChildren(); page = startPage; ended = false; count = 0; loading = false; next(); };
  // Тихое обновление (возврат на экран): заново запрашивает уже загруженные страницы и подменяет
  // содержимое разом — без скелетона и без скачка прокрутки. При ошибке остаётся прежний вид.
  host.refresh = async () => {
    const my = ++gen;
    loading = true;
    const pages = Math.max(1, page - startPage);
    try {
      const rs = await Promise.all(Array.from({ length: pages }, (_, i) => load(startPage + i)));
      if (my !== gen) return;
      const nodes = []; let n = 0; let loaded = 0; let end = false;
      for (const r of rs) {
        const items = Array.isArray(r) ? r : (r.content || []);
        if (loaded === 0 && onFirst) onFirst(r);
        for (const it of items) { const node = render(it, n++); if (node) nodes.push(markAppeared(node)); }
        loaded += 1;
        if (isEnd(r, items)) { end = true; break; }
      }
      list.replaceChildren(...nodes);
      list.style.display = '';
      count = n; page = startPage + loaded; ended = end;
      sentinel.replaceChildren();
      if (ended && count === 0 && empty) sentinel.replaceChildren(empty());
    } catch {
      if (my !== gen) return;
    }
    loading = false;
    if (!ended && isVisible(sentinel)) next();
  };
  host.dispose = () => io.disconnect();
  return host;
}

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight + 600 && r.bottom > -600 && el.isConnected;
}

// --- Вкладки ---
export function tabs(defs, { initial = 0, onChange, scrollable = true, cache: useCache = true } = {}) {
  // defs: [{title, render: () => Node}]; cache:false — вкладка перерисовывается при каждом выборе (свежие данные)
  const bar = h('div', { class: `tabbar ${scrollable ? 'scrollable' : ''}`, role: 'tablist' });
  const body = h('div', { class: 'tabbody' });
  const cache = new Map();
  let current = -1;
  const tabEls = () => [...bar.querySelectorAll('.tab')]; // в полосе могут быть и другие элементы (иконки)
  function select(i) {
    if (i === current) return;
    current = i;
    tabEls().forEach((b, j) => b.classList.toggle('active', j === i));
    if (!useCache || !cache.has(i)) cache.set(i, defs[i].render());
    body.replaceChildren(cache.get(i));
    tabEls()[i]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    onChange && onChange(i);
  }
  defs.forEach((d, i) => bar.append(h('button', { class: 'tab', role: 'tab', onclick: () => select(i) }, d.title)));
  const root = h('div', { class: 'tabs' }, bar, body);
  root.select = select;
  root.refresh = (i = current) => { cache.delete(i); const c = current; current = -1; select(c); };
  select(initial);
  return root;
}

// --- Форматирование ---
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export function formatDate(sec, withTime = false) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const now = new Date();
  let s = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (d.getFullYear() !== now.getFullYear()) s += ` ${d.getFullYear()}`;
  if (withTime) s += ` в ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return s;
}

export function timeAgo(sec) {
  if (!sec) return '';
  const diff = Math.floor(Date.now() / 1000) - sec;
  if (diff < 60) return 'только что';
  if (diff < 3600) { const m = Math.floor(diff / 60); return `${m} ${plural(m, 'минуту', 'минуты', 'минут')} назад`; }
  if (diff < 86400) { const hh = Math.floor(diff / 3600); return `${hh} ${plural(hh, 'час', 'часа', 'часов')} назад`; }
  if (diff < 86400 * 2) return 'вчера';
  return formatDate(sec, true);
}

export function num(n) {
  if (n == null) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.0', '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace('.0', '')}K`;
  return String(n);
}

const seenImages = new Set(); // уже показанные адреса: при перерисовке экрана не проявляем их заново
export function img(src, cls = '', alt = '') {
  const el = h('img', { class: `${cls} fade`.trim(), alt, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  // плавное появление после загрузки (из кэша — сразу)
  el.addEventListener('load', () => { el.classList.add('loaded'); if (src) seenImages.add(src); }, { once: true });
  if (src) el.src = src; else el.classList.add('noimg', 'loaded');
  if (src && seenImages.has(src)) el.classList.add('loaded');
  if (el.complete && el.naturalWidth) el.classList.add('loaded');
  el.addEventListener('error', () => { el.classList.add('noimg'); el.classList.add('loaded'); el.removeAttribute('src'); }, { once: true });
  return el;
}
