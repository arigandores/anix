// Комментарии и ответы (релизы, коллекции, записи)
import { h, icon, actionIcon, pagedList, emptyView, sheet, toast, skeleton } from '../ui.js';
import { A, api, prefetchRead } from '../api.js';
import { t, tp } from '../store.js';
import { registerScreen } from '../router.js';
import { backToolbar, commentItem, commentComposer } from './common.js';
import { commentAddError } from './release.js';
import { ANDROID } from '../platform.js';

const LOADERS = {
  release: { list: A.releaseComments, add: A.releaseCommentAdd, replies: A.releaseCommentReplies, one: (id) => api.get(`release/comment/${id}`) },
  collection: { list: A.collectionComments, add: A.collectionCommentAdd, replies: A.collectionCommentReplies, one: (id) => api.get(`collection/comment/${id}`) },
  article: { list: A.articleComments, add: A.articleCommentAdd, replies: A.articleCommentReplies, one: (id) => api.get(`article/comment/${id}`) },
};
const SORTS = [[1, 'Сначала новые'], [2, 'Сначала старые'], [3, 'Сначала популярные']];
// первая страница — в памяти (повторный заход сразу) и с нажатия кнопки «Комментарии» (prefetchComments): ответ
// успевает за ожидание перехода, экран открывается сразу с комментариями, без мелькания скелетона
const listKey = (kind, id, sort) => `comments:${kind}:${id}:${sort}`;
export function prefetchComments(kind, id) { return prefetchRead(listKey(kind, id, 1), () => LOADERS[kind].list(id, 0, 1)); }

registerScreen('comments', ({ kind = 'release', id, release }) => {
  const L = LOADERS[kind];
  let sort = 1;
  const holder = h('div');
  const countEl = h('span', { class: 'muted' }, h('span', { class: 'sk sk-line', style: { display: 'inline-block', width: '120px', verticalAlign: 'middle' } }));
  let composer;
  let total = 0;
  const paintCount = () => { countEl.textContent = total ? tp('comments', total) : 'Нет комментариев'; };
  // удалили свой комментарий (common.js commentItem) — в счётчике на один меньше
  holder.addEventListener('comment-removed', (e) => { if (!e.detail?.reply) { total = Math.max(0, total - 1); paintCount(); } });
  function build() {
    const list = pagedList({
      skeleton: 'comments', remember: listKey(kind, id, sort),
      load: (page) => L.list(id, page, sort),
      onFirst: (r) => { total = r.total_count || 0; paintCount(); },
      // ответы — в ветке под комментарием (common.js commentItem), поле сверху — только для новых комментариев
      render: (c) => commentItem(c, { kind, release, ownerId: id }),
      empty: () => emptyView('Еще никто не оставлял комментарии. Будьте первыми!', null, 'ic_comment_outline'),
    });
    holder.replaceChildren(h('div', { class: 'row', style: { padding: '8px var(--gutter)' } }, countEl, h('div', { class: 'grow' }),
      h('button', { class: 'chip', onclick: () => sheet('Сортировка', SORTS.map(([v, l]) => ({ label: l, checked: v === sort, onClick: () => { sort = v; build(); } }))) }, actionIcon('ic_sort', 'sm'), SORTS.find((s) => s[0] === sort)[1])), list);
  }
  composer = commentComposer({
    // над списком и закреплено под шапкой: написать, не листая наверх. Телефон — внизу, под большим пальцем и над
    // клавиатурой (как в Anixart)
    top: !ANDROID, sticky: !ANDROID,
    onSend: async (body) => {
      const r = await L.add(id, body);
      if (r.code === 0) { build(); return true; }
      toast(commentAddError(r.code));
      return false;
    },
  });
  build();
  return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: '100%' } }, backToolbar('Комментарии'),
    ANDROID ? null : composer, h('div', { style: { flex: 1 } }, holder), ANDROID ? composer : null);
});

// «Ответы» (переход из уведомлений): исходный комментарий с открытой веткой — те же ответы и поле ответа,
// что и в списке комментариев (common.js commentItem)
const repliesSkeletonBody = () => [skeleton('comments', 1), h('div', { style: { paddingLeft: '68px' } }, skeleton('comments', 3))];

registerScreen('replies', async ({ kind = 'release', id, release }) => {
  const L = LOADERS[kind];
  const root = h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: '100%' } }, backToolbar('Ответы'));
  const body = h('div', { style: { flex: 1 } }, ...repliesSkeletonBody());
  root.append(body);
  const parent = await L.one(id).catch(() => null);
  const p = parent && (parent.comment || parent);
  if (!p || !p.id) body.replaceChildren(emptyView('Комментарий не найден'));
  else body.replaceChildren(commentItem(p, { kind, release, ownerId: release?.id ?? null, expand: true }));
  return root;
}, () => [backToolbar('Ответы'), ...repliesSkeletonBody()]);
