// Коллекции: список, коллекция, коллекции профиля
import { h, icon, actionIcon, iconButton, growBars, img, pagedList, emptyView, sheet, toast, confirmDialog, skeleton, skParts, guardClick, markAppeared, morph } from '../ui.js';
import { A, auth, remembered } from '../api.js';
import { t } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { heartIcon } from '../lottie.js';
import { backToolbar, collectionCard, releaseRow, relTime, requireAuth, avatarEl, profileName, imageViewer, report, digits, pinToHome } from './common.js';

const SORTS = [[1, 'Лидеры рейтинга'], [2, 'Популярные за год'], [3, 'Популярные за сезон'], [4, 'Популярные за неделю'], [5, 'Недавно добавленные'], [6, 'Случайные']];

registerScreen('collections', ({ sort: initSort }) => {
  let sort = initSort || (2 + Math.floor(Math.random() * 5));
  const holder = h('div');
  function build() {
    // Pagination: первая страница 0 (или -1 для случайных), далее (cur+1)%N с пропуском посещённых
    let N = 0; let cur = -1; const visited = new Set(); let first = true;
    const sortRow = h('div', { class: 'row', style: { padding: '8px var(--gutter)', gap: '10px' } },
      auth.loggedIn ? h('button', { class: 'chip', onclick: () => navigate('my-collections') }, icon('ic_collection', 'sm'), 'Мои коллекции') : null,
      h('div', { class: 'grow' }),
      h('button', { class: 'chip', onclick: () => sheet('Сортировка', SORTS.map(([v, l]) => ({ label: l, checked: v === sort, onClick: () => { sort = v; build(); } }))) }, actionIcon('ic_sort', 'sm'), SORTS.find((s) => s[0] === sort)[1]));
    const list = pagedList({
      skeleton: 'collections',
      grid: true,
      load: async () => {
        let page; let prev;
        if (first) { page = sort === 6 ? -1 : 0; prev = -1; first = false; } else {
          prev = cur; page = N ? (cur + 1) % N : cur + 1;
          if (visited.has(page)) { page = [...Array(N).keys()].find((i) => !visited.has(i)); if (page == null) return { content: [] }; }
        }
        const r = await A.collections(page, prev, 1, sort);
        N = r.total_page_count || N; cur = r.current_page ?? page; visited.add(cur);
        return r;
      },
      render: collectionCard,
    });
    holder.replaceChildren(sortRow, list);
  }
  build();
  return h('div', null, backToolbar(t('title_collections') !== 'title_collections' ? t('title_collections') : 'Коллекции'), holder);
});

registerScreen('my-collections', (params, ctx) => {
  const list = pagedList({ skeleton: 'collections', grid: true, load: (page) => A.profileCollections(auth.profileId, page), render: collectionCard, empty: () => emptyView('У вас пока нет коллекций') });
  // создали, изменили или удалили коллекцию (collection-editor.js) — список обновляется на месте; экран скрыт — при возврате
  let stale = false;
  const onChanged = () => { if (list.isConnected) list.refresh(); else stale = true; };
  window.addEventListener('collection-changed', onChanged);
  ctx.setDispose(() => window.removeEventListener('collection-changed', onChanged));
  ctx.setOnShow(() => { if (stale) { stale = false; list.refresh(); } });
  return h('div', null, backToolbar('Мои коллекции'),
    h('div', { class: 'row', style: { padding: '8px var(--gutter)' } },
      h('button', { class: 'chip', onclick: () => navigate('collection-editor') }, icon('ic_plus', 'sm'), 'Создать коллекцию')),
    list);
});

registerScreen('profile-collections', ({ profileId }) => h('div', null, backToolbar('Коллекции'),
  pagedList({ skeleton: 'collections', grid: true, load: (page) => A.profileCollections(profileId, page), render: collectionCard, empty: () => emptyView('Коллекций нет') })));

registerScreen('collection', async ({ id }, ctx) => {
  const root = h('div');
  // повторный заход — сразу из памяти; свежие данные фоном: изменились — экран пересобирается (api.js remembered)
  // изменилось — правим на месте и плавно (ui.js morph): то же данные-объект, новое дерево вливается в показанное
  const apply = (fresh) => {
    if (!root.isConnected) return;
    if (r.collection && fresh.collection) Object.assign(r.collection, fresh.collection); else Object.assign(r, fresh);
    const next = h('div'); paint(r, next); morph(root, markAppeared(next));
  };
  const r = await remembered(`collection:${id}`, () => A.collection(id), apply);
  paint(r);
  // коллекцию изменили в редакторе (collection-editor.js) — при показе экрана данные и релизы обновляются на месте
  // (память свежая — тем же фоновым обновлением, устарела — сразу свежим ответом); удалили — заглушка «удалена»
  let changed = null;
  // удалили из меню этого экрана (он и так закрывается) — без заглушки на кадр перед «Назад»
  const onChanged = (e) => { if (Number(e.detail?.id) === Number(id)) { changed = e.detail; if (root.isConnected && !changed.deleted) refreshChanged(); } };
  function refreshChanged() {
    const d = changed; changed = null;
    if (d.deleted) { r.code = 4; paint(r); return; }
    remembered(`collection:${id}`, () => A.collection(id), apply).then((fresh) => { if (fresh !== r) apply(fresh); }, () => {});
    root.querySelector('.paged')?.refresh?.();
  }
  window.addEventListener('collection-changed', onChanged);
  ctx.setDispose(() => window.removeEventListener('collection-changed', onChanged));
  ctx.setOnShow(() => { if (changed) refreshChanged(); });
  return root;

  // target — куда собрать: при фоновом обновлении — в отдельное дерево для morph
  function paint(r, target = root) {
  target.replaceChildren();
  if (r.code === 3 || r.code === 4) {
    target.append(backToolbar(''), emptyView(r.code === 3 ? 'Данная коллекция недоступна для просмотра, поскольку автор сделал её приватной' : 'Данная коллекция была удалена и больше недоступна для просмотра', null, 'ic_lock'));
    return;
  }
  const c = r.collection;
  if (!c) { target.append(backToolbar(''), emptyView('Коллекция не найдена')); return; }
  const mine = auth.profileId && c.creator?.id === auth.profileId;
  const favBtn = h('button', { class: 'btn list-btn' });
  const heart = heartIcon(!!c.is_favorite);
  const favLabel = h('span');
  favBtn.append(heart, favLabel);
  const paintFav = (on, animate) => {
    heart.set(on, animate); heart.classList.toggle('heart', on); // set — до смены цвета (lottie.js, heartIcon)
    favLabel.textContent = `${on ? 'Удалить из закладок' : 'Добавить в закладки'} ${digits(c.favorites_count)}`;
  };
  // сердце переключается сразу по нажатию; сервер отказал — обратно
  favBtn.onclick = guardClick(favBtn, async () => {
    if (!requireAuth()) return;
    const was = !!c.is_favorite;
    paintFav(!was, true);
    try {
      const res = was ? await A.collectionFavDelete(c.id) : await A.collectionFavAdd(c.id);
      if (res.code === 0 || res.code === 3) { c.is_favorite = !was; c.favorites_count += c.is_favorite ? 1 : -1; }
    } catch { toast(t('error_load')); }
    paintFav(!!c.is_favorite, false);
  });
  paintFav(!!c.is_favorite, false);
  const base = (window.__toggles && window.__toggles.baseUrl) || 'https://anixart-app.com/';
  const toolbar = h('div', { class: 'appbar' },
    iconButton('ic_back', 'Назад', () => history.back()),
    avatarEl(c.creator, 'avatar'),
    h('div', { class: 'grow' }, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Автор коллекции'), profileName(c.creator)),
    iconButton('ic_more', 'Ещё', () => sheet(null, [
      // как на странице релиза: системное «Поделиться» (на Android — меню приложений), без него — в буфер
      { label: 'Поделиться', icon: 'ic_export_variant', onClick: () => { const text = `Рекомендую ознакомиться с коллекцией: «${c.title}»\n${base}collection/${c.id}`; if (navigator.share) navigator.share({ text }).catch(() => {}); else { navigator.clipboard?.writeText(text); toast('Скопировано', { ok: true }); } } },
      { label: 'Скопировать ссылку', icon: 'ic_link', onClick: () => { navigator.clipboard?.writeText(`${base}collection/${c.id}`); toast('Скопировано', { ok: true }); } },
      // ярлык коллекции на рабочем столе телефона (как в Anixart)
      window.anixartNative?.pinShortcut ? { label: 'На рабочий стол', icon: 'ic_home', onClick: () => pinToHome(`collection-${c.id}`, c.title || 'Коллекция', `anixart://collection?id=${c.id}`, c.image || '') } : null,
      mine ? { label: 'Редактировать', icon: 'ic_pencil', onClick: () => navigate('collection-editor', { id: c.id }) } : null,
      // удалили — «Мои коллекции» обновятся (то же событие, что из редактора)
      mine ? { label: 'Удалить', icon: 'ic_trash_outline', danger: true, onClick: async () => { if (await confirmDialog('Удалить коллекцию?', 'Вы уверены, что хотите удалить коллекцию?', 'Удалить')) { const d = await A.collectionDelete(c.id).catch(() => null); toast(d && d.code === 0 ? 'Коллекция удалена' : 'Не удалось удалить коллекцию'); if (d && d.code === 0) { window.dispatchEvent(new CustomEvent('collection-changed', { detail: { id: c.id, deleted: true } })); history.back(); } } } } : null,
      !mine ? { label: 'Пожаловаться', icon: 'ic_alert', onClick: () => report('collection', c.id) } : null,
    ])));
  const statsHolder = h('div', { 'data-keep': '' }); // заполняет список (onFirst) — при фоновом обновлении не трогаем
  const header = h('div', { class: 'container', style: { padding: '0 var(--gutter)' } },
    h('div', { class: 'poster', style: { width: '100%', aspectRatio: '16/7', borderRadius: '16px', cursor: 'zoom-in' }, onclick: () => imageViewer(c.image) }, img(c.image)),
    h('h1', { class: 'rel-title', style: { margin: '14px 0 4px' } }, c.title),
    h('div', { class: 'muted' }, relTime(c.creation_date), c.last_update_date > c.creation_date ? ` • Ред. ${relTime(c.last_update_date)}` : ''),
    c.is_private && mine ? h('div', { class: 'rel-note' }, 'Это закрытая коллекция, доступ к ней имеете только Вы.') : null,
    c.description ? h('div', { class: 'desc-text', style: { margin: '12px 0' } }, c.description) : null,
    h('div', { class: 'rel-actions' }, favBtn,
      h('button', { class: 'btn list-btn', onclick: () => navigate('comments', { kind: 'collection', id: c.id }) }, icon('ic_comment_outline', 'sm'), `Оставить комментарий… ${c.comment_count}`)),
    statsHolder);
  let total = 0;
  // в дереве для morph — заглушка: список релизов обновляется сам (remember)
  const list = target !== root ? h('div', { class: 'paged' }) : pagedList({
    load: (page) => A.collectionReleases(c.id, page), remember: `collection-releases:${c.id}`,
    onFirst: (res) => {
      total = res.total_count || (res.content || []).length;
      if (!total) return;
      const counts = [[r.watching_count, 'green', 'Смотрю'], [r.plan_count, 'purple', 'В планах'], [r.completed_count, 'blue', 'Просмотрено'], [r.hold_on_count, 'yellow', 'Отложено'], [r.dropped_count, 'red', 'Брошено']];
      const sum = counts.reduce((a, x) => a + (x[0] || 0), 0);
      statsHolder.replaceChildren(h('div', { class: 'card', style: { marginTop: '16px' } },
        h('div', { class: 'card-title' }, `${digits(total)} релизов в коллекции`),
        growBars(h('div', { class: 'progress-multi' }, counts.map(([n, col]) => h('div', { style: { width: `${((n || 0) * 100) / Math.max(total, sum || 1)}%`, background: `var(--${col})` } })))),
        auth.loggedIn ? h('div', { class: 'chips' }, counts.map(([n, col, l]) => h('span', { class: 'badge' }, h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: `var(--${col})` } }), `${l}: ${n || 0}`))) : null,
        total > 1 ? h('button', { class: 'btn btn-tonal', style: { marginTop: '12px' }, onclick: () => navigate('release', { random: 4, collectionId: c.id }) }, actionIcon('ic_shuffle', 'sm'), 'Открыть случайный') : null));
    },
    render: (rel) => releaseRow(rel),
  });
  target.append(toolbar, header, h('div', { style: { height: '10px' } }), list);
  }
}, ({ preload: c }) => {
  // шапка коллекции: автор в панели, обложка 16:7, название, дата, кнопки; затем релизы
  const { line, circle, pill, block, col } = skParts;
  const bar = h('div', { class: 'appbar' }, iconButton('ic_back', 'Назад', () => history.back()),
    c?.creator?.avatar ? avatarEl(c.creator, 'avatar') : circle('40px'),
    h('div', { class: 'grow' }, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Автор коллекции'), c?.creator ? profileName(c.creator) : line('110px', '', { marginTop: '4px' })));
  return [bar, h('div', { class: 'container', style: { padding: '0 var(--gutter)' } },
    c?.image ? h('div', { class: 'poster', style: { width: '100%', aspectRatio: '16/7', borderRadius: '16px' } }, img(c.image)) : block({ width: '100%', aspectRatio: '16/7', borderRadius: '16px' }),
    c?.title ? h('h1', { class: 'rel-title', style: { margin: '14px 0 4px' } }, c.title) : line('50%', 'big', { margin: '14px 0 8px' }),
    line('140px'),
    c?.description ? h('div', { class: 'desc-text', style: { margin: '12px 0' } }, c.description) : null,
    h('div', { class: 'rel-actions' }, pill('230px'), pill('250px')),
    block({ height: '120px', borderRadius: '16px', marginTop: '16px' })),
  h('div', { style: { height: '10px' } }), skeleton('rows', 4)];
});
