// Комментарии и ответы (релизы, коллекции, записи)
import { h, icon, pagedList, emptyView, sheet, toast, skeleton } from '../ui.js';
import { A, api } from '../api.js';
import { t, tp } from '../store.js';
import { registerScreen } from '../router.js';
import { backToolbar, commentItem, commentComposer } from './common.js';
import { commentAddError } from './release.js';

const LOADERS = {
  release: { list: A.releaseComments, add: A.releaseCommentAdd, replies: A.releaseCommentReplies, one: (id) => api.get(`release/comment/${id}`) },
  collection: { list: A.collectionComments, add: A.collectionCommentAdd, replies: A.collectionCommentReplies, one: (id) => api.get(`collection/comment/${id}`) },
  article: { list: A.articleComments, add: A.articleCommentAdd, replies: A.articleCommentReplies, one: (id) => api.get(`article/comment/${id}`) },
};
const SORTS = [[1, 'Сначала новые'], [2, 'Сначала старые'], [3, 'Сначала популярные']];

registerScreen('comments', ({ kind = 'release', id, release }) => {
  const L = LOADERS[kind];
  let sort = 1;
  const holder = h('div');
  const countEl = h('span', { class: 'muted' }, h('span', { class: 'sk sk-line', style: { display: 'inline-block', width: '120px', verticalAlign: 'middle' } }));
  let composer;
  function build() {
    const list = pagedList({
      skeleton: 'comments',
      load: (page) => L.list(id, page, sort),
      onFirst: (r) => { countEl.textContent = r.total_count ? tp('comments', r.total_count) : 'Нет комментариев'; },
      render: (c) => commentItem(c, { kind, release, onReply: (cc) => composer.setReply({ parentCommentId: cc.id, replyToProfileId: null, login: cc.profile?.login }) }),
      empty: () => emptyView('Еще никто не оставлял комментарии. Будьте первыми!', null, 'ic_comment_outline'),
    });
    holder.replaceChildren(h('div', { class: 'row', style: { padding: '8px 20px' } }, countEl, h('div', { class: 'grow' }),
      h('button', { class: 'chip', onclick: () => sheet('Сортировка', SORTS.map(([v, l]) => ({ label: l, checked: v === sort, onClick: () => { sort = v; build(); } }))) }, icon('ic_sort', 'sm'), SORTS.find((s) => s[0] === sort)[1])), list);
  }
  composer = commentComposer({
    top: true, // над списком: написать, не листая до конца
    onSend: async (body) => {
      const r = await L.add(id, body);
      if (r.code === 0) { build(); return true; }
      toast(commentAddError(r.code));
      return false;
    },
  });
  build();
  return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: '100%' } }, backToolbar('Комментарии'), composer, h('div', { style: { flex: 1 } }, holder));
});

// ответы: исходный комментарий, разделитель, ответы с отступом
const repliesSkeletonBody = () => [skeleton('comments', 1), h('div', { class: 'sep' }), h('div', { style: { paddingLeft: '28px' } }, skeleton('comments', 3))];

registerScreen('replies', async ({ kind = 'release', id, release }) => {
  const L = LOADERS[kind];
  const root = h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: '100%' } }, backToolbar('Ответы'));
  const body = h('div', { style: { flex: 1 } }, ...repliesSkeletonBody());
  let composer;
  let embeddableId = release?.id ?? null;
  async function load() {
    const [parent, replies] = await Promise.all([L.one(id), L.replies(id, 0, 2)]);
    body.replaceChildren();
    const p = parent.comment || parent;
    const emb = p && (p.release || p.collection || p.article);
    embeddableId = (emb && typeof emb === 'object' ? emb.id : null) ?? p?.release_id ?? p?.collection_id ?? p?.article_id ?? embeddableId;
    if (p && p.id) body.append(commentItem(p, { kind, release }), h('div', { class: 'sep' }));
    const items = replies.content || [];
    if (!items.length) body.append(emptyView('Нет ответов'));
    items.forEach((c) => body.append(h('div', { style: { paddingLeft: '28px' } }, commentItem(c, {
      kind, release,
      onReply: (cc) => {
        const first = cc.profile?.login ? `${cc.profile.login}, ` : '';
        composer.setReply({ parentCommentId: id, replyToProfileId: cc.profile?.id, login: cc.profile?.login }, first);
      },
    }))));
  }
  composer = commentComposer({
    onSend: async (b) => {
      const req = { ...b, parentCommentId: b.parentCommentId ?? id };
      if (req.replyToProfileId && req.message) req.message = req.message.replace(/^([^,]+, )(.)/, (_, a, c) => a + c.toLowerCase());
      if (embeddableId == null) { toast(t('error_load')); return false; }
      const r = await L.add(embeddableId, req).catch(() => ({ code: -1 }));
      if (r.code === 0) { load(); return true; }
      toast(commentAddError(r.code));
      return false;
    },
  });
  composer.setReply({ parentCommentId: id, replyToProfileId: null, login: '' });
  root.append(body, composer);
  await load();
  return root;
}, () => [backToolbar('Ответы'), ...repliesSkeletonBody()]);
