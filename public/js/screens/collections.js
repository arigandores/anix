// Коллекции: список, коллекция, коллекции профиля
import { h, icon, iconButton, img, pagedList, emptyView, sheet, toast, confirmDialog, skeleton, skParts, guardClick } from '../ui.js';
import { A, auth } from '../api.js';
import { t } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { backToolbar, collectionCard, releaseRow, relTime, requireAuth, avatarEl, profileName, imageViewer, report, digits } from './common.js';

const SORTS = [[1, 'Лидеры рейтинга'], [2, 'Популярные за год'], [3, 'Популярные за сезон'], [4, 'Популярные за неделю'], [5, 'Недавно добавленные'], [6, 'Случайные']];

registerScreen('collections', ({ sort: initSort }) => {
  let sort = initSort || (2 + Math.floor(Math.random() * 5));
  const holder = h('div');
  function build() {
    // Pagination: первая страница 0 (или -1 для случайных), далее (cur+1)%N с пропуском посещённых
    let N = 0; let cur = -1; const visited = new Set(); let first = true;
    const sortRow = h('div', { class: 'row', style: { padding: '8px 20px', gap: '10px' } },
      auth.loggedIn ? h('button', { class: 'chip', onclick: () => navigate('my-collections') }, icon('ic_collection', 'sm'), 'Мои коллекции') : null,
      h('div', { class: 'grow' }),
      h('button', { class: 'chip', onclick: () => sheet('Сортировка', SORTS.map(([v, l]) => ({ label: l, checked: v === sort, onClick: () => { sort = v; build(); } }))) }, icon('ic_sort', 'sm'), SORTS.find((s) => s[0] === sort)[1]));
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

registerScreen('my-collections', () => h('div', null, backToolbar('Мои коллекции'),
  pagedList({ skeleton: 'collections', grid: true, load: (page) => A.profileCollections(auth.profileId, page), render: collectionCard, empty: () => emptyView('У вас пока нет коллекций') })));

registerScreen('profile-collections', ({ profileId }) => h('div', null, backToolbar('Коллекции'),
  pagedList({ skeleton: 'collections', grid: true, load: (page) => A.profileCollections(profileId, page), render: collectionCard, empty: () => emptyView('Коллекций нет') })));

registerScreen('collection', async ({ id }) => {
  const root = h('div');
  const r = await A.collection(id);
  if (r.code === 3 || r.code === 4) {
    root.append(backToolbar(''), emptyView(r.code === 3 ? 'Данная коллекция недоступна для просмотра, поскольку автор сделал её приватной' : 'Данная коллекция была удалена и больше недоступна для просмотра', null, 'ic_lock'));
    return root;
  }
  const c = r.collection;
  if (!c) { root.append(backToolbar(''), emptyView('Коллекция не найдена')); return root; }
  const mine = auth.profileId && c.creator?.id === auth.profileId;
  const favBtn = h('button', { class: 'btn list-btn' });
  const paintFav = () => favBtn.replaceChildren(icon(c.is_favorite ? 'ic_favorite' : 'ic_favorite_border', `sm ${c.is_favorite ? 'heart' : ''}`), c.is_favorite ? 'Удалить из закладок' : 'Добавить в закладки', ` ${digits(c.favorites_count)}`);
  favBtn.onclick = guardClick(favBtn, async () => {
    if (!requireAuth()) return;
    try {
      const res = c.is_favorite ? await A.collectionFavDelete(c.id) : await A.collectionFavAdd(c.id);
      if (res.code === 0 || res.code === 3) { c.is_favorite = !c.is_favorite; c.favorites_count += c.is_favorite ? 1 : -1; paintFav(); }
    } catch { toast(t('error_load')); }
  });
  paintFav();
  const base = (window.__toggles && window.__toggles.baseUrl) || 'https://anixart-app.com/';
  const toolbar = h('div', { class: 'appbar' },
    iconButton('ic_back', 'Назад', () => history.back()),
    avatarEl(c.creator, 'avatar'),
    h('div', { class: 'grow' }, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Автор коллекции'), profileName(c.creator)),
    iconButton('ic_more', 'Ещё', () => sheet(null, [
      { label: 'Поделиться', icon: 'ic_export_variant', onClick: () => { navigator.clipboard?.writeText(`Рекомендую ознакомиться с коллекцией: «${c.title}»\n${base}collection/${c.id}`); toast('Скопировано'); } },
      { label: 'Скопировать ссылку', icon: 'ic_link', onClick: () => { navigator.clipboard?.writeText(`${base}collection/${c.id}`); toast('Скопировано'); } },
      mine ? { label: 'Удалить', icon: 'ic_trash_outline', danger: true, onClick: async () => { if (await confirmDialog('Удалить коллекцию?', 'Вы уверены, что хотите удалить коллекцию?', 'Удалить')) { const { api } = await import('../api.js'); const d = await api.get(`collectionMy/delete/${c.id}`).catch(() => null); toast(d && d.code === 0 ? 'Коллекция удалена' : 'Не удалось удалить коллекцию'); if (d && d.code === 0) history.back(); } } } : null,
      !mine ? { label: 'Пожаловаться', icon: 'ic_alert', onClick: () => report('collection', c.id) } : null,
    ])));
  const statsHolder = h('div');
  const header = h('div', { class: 'container', style: { padding: '0 20px' } },
    h('div', { class: 'poster', style: { width: '100%', aspectRatio: '16/7', borderRadius: '16px', cursor: 'zoom-in' }, onclick: () => imageViewer(c.image) }, img(c.image)),
    h('h1', { class: 'rel-title', style: { margin: '14px 0 4px' } }, c.title),
    h('div', { class: 'muted' }, relTime(c.creation_date), c.last_update_date > c.creation_date ? ` • Ред. ${relTime(c.last_update_date)}` : ''),
    c.is_private && mine ? h('div', { class: 'rel-note' }, 'Это закрытая коллекция, доступ к ней имеете только Вы.') : null,
    c.description ? h('div', { class: 'desc-text', style: { margin: '12px 0' } }, c.description) : null,
    h('div', { class: 'rel-actions' }, favBtn,
      h('button', { class: 'btn list-btn', onclick: () => navigate('comments', { kind: 'collection', id: c.id }) }, icon('ic_comment_outline', 'sm'), `Оставить комментарий… ${c.comment_count}`)),
    statsHolder);
  let total = 0;
  const list = pagedList({
    load: (page) => A.collectionReleases(c.id, page),
    onFirst: (res) => {
      total = res.total_count || (res.content || []).length;
      if (!total) return;
      const counts = [[r.watching_count, 'green', 'Смотрю'], [r.plan_count, 'purple', 'В планах'], [r.completed_count, 'blue', 'Просмотрено'], [r.hold_on_count, 'yellow', 'Отложено'], [r.dropped_count, 'red', 'Брошено']];
      const sum = counts.reduce((a, x) => a + (x[0] || 0), 0);
      statsHolder.replaceChildren(h('div', { class: 'card', style: { marginTop: '16px' } },
        h('div', { class: 'card-title' }, `${digits(total)} релизов в коллекции`),
        h('div', { class: 'progress-multi' }, counts.map(([n, col]) => h('div', { style: { width: `${((n || 0) * 100) / Math.max(total, sum || 1)}%`, background: `var(--${col})` } }))),
        auth.loggedIn ? h('div', { class: 'chips' }, counts.map(([n, col, l]) => h('span', { class: 'badge' }, h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: `var(--${col})` } }), `${l}: ${n || 0}`))) : null,
        total > 1 ? h('button', { class: 'btn btn-tonal', style: { marginTop: '12px' }, onclick: () => navigate('release', { random: 4, collectionId: c.id }) }, icon('ic_shuffle', 'sm'), 'Открыть случайный') : null));
    },
    render: (rel) => releaseRow(rel),
  });
  root.append(toolbar, header, h('div', { style: { height: '10px' } }), list);
  return root;
}, ({ preload: c }) => {
  // шапка коллекции: автор в панели, обложка 16:7, название, дата, кнопки; затем релизы
  const { line, circle, pill, block, col } = skParts;
  const bar = h('div', { class: 'appbar' }, iconButton('ic_back', 'Назад', () => history.back()),
    c?.creator?.avatar ? avatarEl(c.creator, 'avatar') : circle('40px'),
    h('div', { class: 'grow' }, h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Автор коллекции'), c?.creator ? profileName(c.creator) : line('110px', '', { marginTop: '4px' })));
  return [bar, h('div', { class: 'container', style: { padding: '0 20px' } },
    c?.image ? h('div', { class: 'poster', style: { width: '100%', aspectRatio: '16/7', borderRadius: '16px' } }, img(c.image)) : block({ width: '100%', aspectRatio: '16/7', borderRadius: '16px' }),
    c?.title ? h('h1', { class: 'rel-title', style: { margin: '14px 0 4px' } }, c.title) : line('50%', 'big', { margin: '14px 0 8px' }),
    line('140px'),
    c?.description ? h('div', { class: 'desc-text', style: { margin: '12px 0' } }, c.description) : null,
    h('div', { class: 'rel-actions' }, pill('230px'), pill('250px')),
    block({ height: '120px', borderRadius: '16px', marginTop: '16px' })),
  h('div', { style: { height: '10px' } }), skeleton('rows', 4)];
});
