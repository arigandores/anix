// Лента, запись, канал
import { h, icon, iconButton, img, toast, tabs, pagedList, emptyView, errorView, skeleton, skParts } from '../ui.js';
import { A, auth } from '../api.js';
import { t, tp } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { mainToolbar, backToolbar, relTime, needAuthView, requireAuth, commentItem, commentComposer, imageViewer, digits } from './common.js';

// Jsoup-санитизация абзацев: разрешены b, i, s, u, a[href]; остальное — текст
const ALLOWED = new Set(['B', 'I', 'S', 'U', 'A', 'BR', 'STRONG', 'EM']);
function safeHtml(html, { stripAll = false } = {}) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
  const out = document.createDocumentFragment();
  (function walk(src, dst) {
    for (const n of src.childNodes) {
      if (n.nodeType === 3) { dst.append(document.createTextNode(n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      if (!stripAll && ALLOWED.has(n.tagName)) {
        let el;
        if (n.tagName === 'A') {
          const href = n.getAttribute('href') || '';
          el = document.createElement('a');
          if (/^https?:\/\//i.test(href)) { el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer'; }
        } else el = document.createElement(n.tagName === 'STRONG' ? 'b' : n.tagName === 'EM' ? 'i' : n.tagName.toLowerCase());
        walk(n, el);
        dst.append(el);
      } else if (n.tagName === 'BR') dst.append(document.createElement('br'));
      else walk(n, dst);
    }
  })(doc.body, out);
  return out;
}

function renderBlocks(blocks) {
  const box = h('div', { class: 'content' });
  for (const b of blocks || []) {
    const d = b.data || {};
    switch (b.type) {
      case 'paragraph': box.append(h('p', null, safeHtml(d.text))); break;
      case 'header': box.append(h('h3', null, safeHtml(d.text, { stripAll: true }))); break;
      case 'quote': box.append(h('blockquote', { style: { textAlign: d.alignment === 'center' ? 'center' : 'left' } }, safeHtml(d.text), d.caption ? h('div', { class: 'muted', style: { fontSize: '13px' } }, safeHtml(d.caption, { stripAll: true })) : null)); break;
      case 'list': {
        const L = h(d.style === 'ordered' ? 'ol' : 'ul');
        (d.items || []).forEach((it) => L.append(h('li', null, safeHtml(typeof it === 'string' ? it : it.content || '', { stripAll: true }))));
        box.append(L); break;
      }
      case 'media': {
        const items = d.items || [];
        const grid = h('div', { style: { display: 'grid', gap: '4px', gridTemplateColumns: items.length === 1 ? '1fr' : 'repeat(2, 1fr)' } });
        items.slice(0, 4).forEach((m) => { const i = img(m.url); i.style.cursor = 'zoom-in'; i.style.width = '100%'; if (m.width && m.height) i.style.aspectRatio = `${m.width} / ${m.height}`; i.onclick = () => imageViewer(m.url); grid.append(i); });
        box.append(grid); break;
      }
      case 'embed':
        box.append(h('a', { class: 'card', href: d.url, target: '_blank', rel: 'noopener', style: { display: 'flex', gap: '12px', alignItems: 'center', padding: '10px' } },
          d.image ? h('img', { src: d.image, style: { width: '120px', borderRadius: '8px', objectFit: 'cover', aspectRatio: '16/9' } }) : icon('ic_link'),
          h('div', { class: 'grow' }, h('div', { class: 'muted', style: { fontSize: '12px' } }, d.site_name || d.service || ''), h('b', { class: 'clamp2' }, d.title || d.url), d.description ? h('div', { class: 'muted clamp2', style: { fontSize: '13px' } }, d.description) : null)));
        break;
      case 'delimiter': box.append(h('hr', { style: { border: 0, borderTop: '1px solid var(--sep)', width: '100%' } })); break;
      default: box.append(h('p', { class: 'muted' }, 'Этот тип блока пока не поддерживается в Anix Desktop.'));
    }
  }
  return box;
}

function expandable(a) {
  const p = a.payload || {};
  const blocks = p.blocks || [];
  if ((a.contains_repost_article && !a.repost_article)) return true;
  if (blocks.length < (p.block_count || 0)) return true;
  return blocks.some((b) => (['paragraph', 'header'].includes(b.type) && (b.data?.text || '').length < (b.data?.text_length || 0)) || (b.type === 'list' && (b.data?.items || []).length < (b.data?.item_count || 0)));
}

function channelHead(ch, date) {
  const open = () => (ch.is_blog && ch.blog_profile_id ? navigate('profile', { id: ch.blog_profile_id }) : navigate('channel', { id: ch.id, preload: ch }));
  return h('div', { class: 'head' },
    img(ch.avatar, 'avatar'),
    h('div', { class: 'grow', style: { cursor: 'pointer' }, onclick: open },
      h('div', { class: 'row', style: { gap: '4px', fontWeight: 500 } }, ch.title, ch.is_verified ? icon('ic_verified', 'xs verified') : null),
      h('div', { class: 'muted3', style: { fontSize: '12px' } }, relTime(date))));
}

export function articleCard(a, { full = false } = {}) {
  if (a.is_deleted) return h('div', { class: 'article muted' }, 'Запись удалена');
  const score = h('span', { class: a.vote_count > 0 ? 'vote-pos' : a.vote_count < 0 ? 'vote-neg' : '' }, String(a.vote_count ?? 0).replace('-', '–'));
  const minus = h('button', { class: a.vote === 1 ? 'on' : '' }, icon('ic_arrow_downward', 'sm'));
  const plus = h('button', { class: a.vote === 2 ? 'on' : '' }, icon('ic_arrow_upward', 'sm'));
  async function vote(v) {
    if (!requireAuth()) return;
    const old = a.vote || 0;
    const r = await A.articleVote(a.id, v).catch(() => ({ code: -1 }));
    const err = { 2: 'Вы превысили дневной лимит на отрицательные оценки', 4: 'Создатель или администратор канала внёс Вас в блоклист. Вы не можете ставить оценки записям.', 5: 'Кажется, Вы зарегистрированы совсем недавно. Побудьте с нами немного дольше, чтобы получить возможность ставить оценки.', 402: 'Вы не можете голосовать, поскольку ваш аккаунт заблокирован' }[r.code];
    if (err) return toast(err);
    if (r.code !== 0) return toast(t('error_load'));
    a.vote_count += { '0>2': 1, '0>1': -1, '2>2': -1, '1>1': 1, '1>2': 2, '2>1': -2 }[`${old}>${v}`] || 0;
    a.vote = old === v ? 0 : v;
    score.textContent = String(a.vote_count).replace('-', '–');
    score.className = a.vote_count > 0 ? 'vote-pos' : a.vote_count < 0 ? 'vote-neg' : '';
    minus.classList.toggle('on', a.vote === 1); plus.classList.toggle('on', a.vote === 2);
  }
  minus.onclick = (e) => { e.stopPropagation(); vote(1); };
  plus.onclick = (e) => { e.stopPropagation(); vote(2); };
  const el = h('div', { class: 'article' },
    channelHead(a.channel || {}, a.creation_date),
    renderBlocks(a.payload?.blocks),
    a.repost_article ? h('div', { class: 'card', style: { marginTop: '10px' } }, channelHead(a.repost_article.channel || {}, a.repost_article.creation_date), renderBlocks(a.repost_article.payload?.blocks)) : null,
    !full && expandable(a) ? h('button', { class: 'btn btn-text', style: { paddingLeft: 0 }, onclick: () => navigate('article', { id: a.id, preload: a }) }, 'Показать ещё') : null,
    a.is_signed && a.author ? h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '6px' } }, a.author.login) : null,
    h('div', { class: 'foot' },
      h('button', { onclick: () => navigate('article', { id: a.id, comments: true, preload: a }) }, icon('ic_comment_outline', 'sm'), String(a.comment_count ?? 0)),
      h('span', { class: 'row', style: { gap: '4px' } }, icon('ic_repost', 'sm'), String(a.repost_count ?? 0)),
      h('div', { class: 'grow' }), minus, score, plus));
  return el;
}

function feedList(load, empty = 'Похоже, нет ни одной записи') {
  return pagedList({ skeleton: 'articles', load, render: (a) => articleCard(a), empty: () => emptyView(empty) });
}

const DATES = [[0, 'Последнее'], [1, '24 часа'], [2, 'Неделя'], [3, 'Месяц'], [4, 'Год'], [5, 'Всё время']];

function myFeed() {
  const holder = h('div', null, skeleton('articles'));
  let date = 0; let channelId = null;
  (async () => {
    const cnt = await (await import('../api.js')).api.get('channel/subscription/count').catch(() => ({}));
    if (!(cnt.subscription_count > 0)) {
      holder.replaceChildren(h('div', { class: 'empty', style: { paddingBottom: '10px' } }, h('div', { class: 'empty-title' }, 'Ой, а подписок-то нет!'), h('div', { class: 'empty-sub' }, 'Но ничего страшного, Вы можете подписаться на популярные каналы из списка ниже')),
        pagedList({ skeleton: 'channels', load: (page) => A.channelRecommendations(page), render: channelRow, empty: () => emptyView('Похоже, нет ни одного канала') }));
      return;
    }
    const subs = await A.subscriptions(0, 1).catch(() => ({ content: [] }));
    const listHolder = h('div');
    const rebuild = () => listHolder.replaceChildren(feedList((page) => A.feed(page, channelId, date)));
    const chips = h('div', { class: 'hscroll', style: { padding: '10px 20px' } },
      (subs.content || []).map((ch) => { const b = h('button', { class: 'chip', title: ch.title }, img(ch.avatar, '', ''), ch.title); b.querySelector('img').style.cssText = 'width:22px;height:22px;border-radius:50%'; b.onclick = () => { channelId = channelId === ch.id ? null : ch.id; [...chips.children].forEach((x) => x.classList.remove('on')); if (channelId) b.classList.add('on'); rebuild(); }; return b; }));
    const dateSel = h('select', { class: 'input', style: { width: 'auto', height: '36px' } }, DATES.map(([v, l]) => h('option', { value: v }, l)));
    dateSel.onchange = () => { date = Number(dateSel.value); rebuild(); };
    holder.replaceChildren(h('div', { class: 'row', style: { padding: '10px 20px 0' } }, dateSel, h('div', { class: 'grow' }), h('button', { class: 'btn btn-text', onclick: () => navigate('channels', { subscribed: true }) }, 'Все')), chips, listHolder);
    rebuild();
  })().catch((e) => holder.replaceChildren(emptyView(String(e.message || e))));
  return holder;
}

function channelRow(ch) {
  const btn = h('button', { class: `btn ${ch.is_subscribed ? 'btn-tonal' : 'btn-primary'}` }, ch.is_subscribed ? 'Отписаться' : 'Подписаться');
  btn.onclick = async (e) => {
    e.stopPropagation();
    if (!requireAuth()) return;
    const r = ch.is_subscribed ? await A.channelUnsubscribe(ch.id) : await A.channelSubscribe(ch.id);
    if (r.code === 3) return toast('Вы подписались на максимально возможное число каналов.');
    ch.is_subscribed = !ch.is_subscribed;
    btn.textContent = ch.is_subscribed ? 'Отписаться' : 'Подписаться'; btn.className = `btn ${ch.is_subscribed ? 'btn-tonal' : 'btn-primary'}`;
  };
  return h('div', { class: 'type-row', onclick: () => navigate('channel', { id: ch.id, preload: ch }) }, img(ch.avatar),
    h('div', { class: 'grow' }, h('div', { class: 'row', style: { gap: '4px', fontWeight: 500 } }, ch.title, ch.is_verified ? icon('ic_verified', 'xs verified') : null),
      h('div', { class: 'muted', style: { fontSize: '13px' } }, ch.subscriber_count ? tp('subscribers', ch.subscriber_count) : 'Нет подписчиков')), btn);
}

registerScreen('tab:feed', () => {
  if (!auth.loggedIn) return needAuthView();
  return h('div', null, mainToolbar({ hint: 'Поиск записей и блогов', onSearch: () => navigate('feed-search') }), tabs([
    { title: 'Моя лента', render: myFeed },
    { title: 'Свежее', render: () => feedList((page) => A.latestArticles(page)) },
  ]));
});

registerScreen('feed-search', () => {
  const input = h('input', { placeholder: 'Поиск записей и блогов' });
  const res = h('div');
  let timer;
  const run = () => { const q = input.value.trim(); if (!q) { res.replaceChildren(); return; } res.replaceChildren(feedList((page) => A.searchArticles(page, { query: q, searchBy: 0 }), 'Ничего не найдено')); };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 500); });
  setTimeout(() => input.focus(), 50);
  return h('div', null, h('div', { class: 'appbar' }, iconButton('ic_back', 'Назад', () => history.back()), h('div', { class: 'searchbar', style: { maxWidth: 'none' } }, icon('ic_search'), input)), res);
});

// Пока грузится запись: она же из карточки ленты (если открыта оттуда) или скелетон, затем комментарии
function articleSkeleton({ preload }) {
  return [backToolbar('Запись'), h('div', { class: 'container', style: { maxWidth: '820px', padding: 0 } },
    preload && !preload.is_deleted ? articleCard(preload, { full: true }) : skeleton('articles', 1),
    h('div', { class: 'section-head' }, skParts.line('150px', 'title')), skeleton('comments', 3))];
}

registerScreen('article', async ({ id, comments }) => {
  const r = await A.article(id);
  const root = h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: '100%' } }, backToolbar('Запись'));
  if (!r.article) { root.append(emptyView('Запись удалена')); return root; }
  import('../api.js').then(({ api }) => api.post('article/event', { type: 'read', entry_point: 'article', articles: [id] }).catch(() => {}));
  // на полной странице записи текст выделяемый, как в мобильном приложении
  const body = h('div', { class: 'container selectable', style: { maxWidth: '820px', padding: 0, flex: 1 } }, articleCard(r.article, { full: true }));
  const list = pagedList({ skeleton: 'comments', load: (page) => A.articleComments(id, page, 1), render: (c) => commentItem(c, { kind: 'article' }), empty: () => emptyView('Еще никто не оставлял комментарии. Будьте первыми!') });
  body.append(h('div', { class: 'section-head' }, h('div', { class: 'section-title' }, `Комментарии ${digits(r.article.comment_count)}`)), list);
  const composer = r.article.channel?.is_commenting_enabled !== false ? commentComposer({
    onSend: async (b) => {
      const res = await A.articleCommentAdd(id, b);
      if (res.code === 0) { list.reload(); return true; }
      toast(res.code === 8 ? 'Создатель или администратор канала внёс Вас в блоклист. Вы не можете комментировать записи.' : t('error_load'));
      return false;
    },
  }) : null;
  root.append(body, composer);
  if (comments) setTimeout(() => list.scrollIntoView({ behavior: 'smooth' }), 300);
  return root;
}, articleSkeleton);

// Канал: шапка сразу из данных карточки (обложка, аватар, название, описание уже есть в списке),
// записи грузятся параллельно; свежий канал (подписка, счётчики) подменяет шапку, когда придёт.
registerScreen('channel', ({ id, preload }) => {
  const bar = backToolbar(preload?.title || 'Канал');
  const head = h('div');
  const paint = (ch) => {
    bar.querySelector('.title').textContent = ch.title || 'Канал';
    head.replaceChildren(
      ch.cover ? h('div', { class: 'poster', style: { width: '100%', aspectRatio: '3/1', borderRadius: 0 } }, img(ch.cover)) : null,
      channelRow(ch),
      ch.description ? h('div', { class: 'muted', style: { padding: '0 20px 10px', whiteSpace: 'pre-line' } }, ch.description) : null);
  };
  if (preload) paint(preload);
  else {
    const { block, line } = skParts;
    head.append(h('div', { class: 'skeleton sk-root' }, block({ width: '100%', aspectRatio: '3/1', borderRadius: 0 }), skeleton('channels', 1),
      h('div', { style: { padding: '0 20px 10px', display: 'flex', flexDirection: 'column', gap: '8px' } }, line('86%'), line('54%'))));
  }
  const root = h('div', null, bar, h('div', { class: 'container', style: { maxWidth: '820px', padding: 0 } },
    head, h('div', { class: 'sep' }), feedList((page) => A.channelArticles(id, page))));
  A.channel(id).then((r) => {
    if (!r.channel) { root.replaceChildren(backToolbar('Канал'), emptyView('Канал не найден')); return; }
    paint(r.channel);
  }).catch((e) => { if (!preload) head.replaceChildren(errorView(e)); });
  return root;
});

registerScreen('channels', ({ subscribed }) => h('div', null, backToolbar('Каналы'),
  pagedList({ skeleton: 'channels', load: (page) => A.channels(page, { permission: null, is_blog: null, is_subscribed: subscribed ? true : null, sort: 1 }), render: channelRow, empty: () => emptyView('Похоже, нет ни одного канала') })));
