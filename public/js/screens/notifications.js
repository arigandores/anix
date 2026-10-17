// Уведомления: единый список с фильтром (без вкладок)
import { h, icon, actionIcon, iconButton, img, pagedList, emptyView, sheet, toast, confirmDialog, esc, skeleton } from '../ui.js';
import { api, prefetchRead } from '../api.js';
import { t } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { backToolbar, relTime } from './common.js';

const FILTERS = [
  [1, 'Все уведомления', ['notification/all']],
  [2, 'Только эпизоды', ['notification/episodes']],
  [3, 'Только релизы', ['notification/related/release']],
  [4, 'Только записи', ['notification/articles']],
  [5, 'Только дружба', ['notification/friends']],
  [6, 'Только ответы', ['notification/releaseComments', 'notification/collectionComments', 'notification/article/comments']],
];

const DELETE_EP = {
  friend: 'notification/friend/delete',
  episode: 'notification/episode/delete',
  releaseComment: 'notification/releaseComment/delete',
  collectionComment: 'notification/collectionComment/delete',
  myCollection: 'notification/my/collection/comment/delete',
  articleComment: 'notification/article/comment/delete',
  myArticle: 'notification/my/article/comment/delete',
  relatedRelease: 'notification/related/release/delete',
};

const bold = (s) => `<b>${esc(s)}</b>`;

function payloadText(payload, max = 150) {
  const parts = [];
  for (const b of (payload && payload.blocks) || []) {
    const d = b.data || {};
    if (d.text) parts.push(d.text.replace(/<[^>]+>/g, ''));
    else if (b.type === 'list' && Array.isArray(d.items)) parts.push(d.items.join(' '));
  }
  const s = parts.join(' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function parentId(n) {
  const c = n.comment || {};
  return (n.parent_comment && n.parent_comment.id) || c.parent_comment_id || c.id;
}

function describe(n) {
  const out = { image: '', html: '', spoiler: false, poster: false, onClick: null };
  const c = n.comment || {};
  const cp = c.profile || n.profile || {};
  switch (n.type) {
    case 'episode': {
      const ep = n.episode || {};
      const rel = ep.release || n.release || {};
      const src = ep.source || {};
      out.image = rel.image; out.poster = true;
      out.html = `Вышла ${bold(`«${ep.name || 'нет названия'}»`)} релиза ${bold(`«${rel.title_ru || ''}»`)}`
        + ` в варианте ${bold(`«${(src.type && src.type.name) || ''}»`)} на источнике «${esc(src.name || '')}»`;
      out.onClick = () => rel.id && navigate('release', { id: rel.id });
      break;
    }
    case 'friend': {
      const p = n.by_profile || n.profile || {};
      out.image = p.avatar;
      out.html = n.status === 1
        ? `Пользователь ${bold(p.login)} внёс вас в список своих друзей`
        : `Пользователь ${bold(p.login)} хочет внести вас в список друзей`;
      out.onClick = () => p.id && navigate('profile', { id: p.id });
      break;
    }
    case 'relatedRelease': {
      const rel = n.release || {};
      out.image = rel.image; out.poster = true;
      out.html = `В Anixart добавлена страница релиза ${bold(`«${rel.title_ru || ''}»`)}`;
      out.onClick = () => rel.id && navigate('release', { id: rel.id });
      break;
    }
    case 'article': {
      const a = n.article || {};
      const ch = a.channel || {};
      out.image = ch.avatar;
      out.html = `Новая запись на канале ${bold(`«${ch.title || ''}»`)}<br><span class="muted">${esc(payloadText(a.payload))}</span>`;
      out.onClick = () => a.id && navigate('article', { id: a.id });
      break;
    }
    case 'myCollection': {
      out.image = cp.avatar;
      out.html = `Новый комментарий к вашей коллекции ${bold(n.embeddable_title || '')} от пользователя ${bold(cp.login)}: ${esc(c.message || '')}`;
      out.onClick = () => navigate('replies', { kind: 'collection', id: parentId(n) });
      break;
    }
    case 'myArticle': {
      out.image = cp.avatar;
      const d = n.embeddable_description ? String(n.embeddable_description).slice(0, 50) : '';
      out.html = d
        ? `Новый комментарий к Вашей блоговой записи ${bold(`«${d}»`)} от пользователя ${bold(cp.login)}: ${esc(c.message || '')}`
        : `Новый комментарий к Вашей блоговой записи от пользователя ${bold(cp.login)}: ${esc(c.message || '')}`;
      out.onClick = () => navigate('replies', { kind: 'article', id: parentId(n) });
      break;
    }
    default: {
      // releaseComment, collectionComment, articleComment — ответы на комментарии
      out.image = cp.avatar;
      out.spoiler = !!c.is_spoiler;
      out.html = `Новый ответ от ${bold(cp.login)}: ${esc(c.message || '')}`;
      const kind = n.type === 'collectionComment' ? 'collection' : n.type === 'articleComment' ? 'article' : 'release';
      out.onClick = () => navigate('replies', { kind, id: parentId(n) });
    }
  }
  return out;
}

function notificationRow(n, onChanged) {
  const info = describe(n);
  const pic = info.image ? img(info.image, info.poster ? '' : 'avatar') : h('div', { class: info.poster ? '' : 'avatar' });
  if (info.poster) pic.style.cssText = 'width:44px;height:66px;border-radius:8px;object-fit:cover;flex:none;background:var(--ph1)';
  const body = h('div', { class: 'grow' });
  const text = h('div', { html: info.html });
  if (info.spoiler) {
    const box = h('div', { class: 'rel-note', style: { margin: '2px 0', cursor: 'pointer' } },
      h('b', null, 'В ответе на ваш комментарий может содержаться спойлер.'),
      h('div', { class: 'muted' }, 'Нажмите, чтобы прочитать'));
    box.onclick = (e) => { e.stopPropagation(); box.replaceWith(text); };
    body.append(box);
  } else {
    body.append(text);
  }
  body.append(h('div', { class: 'muted3', style: { fontSize: '12px', marginTop: '2px' } }, n.timestamp ? relTime(n.timestamp) : 'время не указано'));
  const row = h('div', { class: 'comment', style: { cursor: 'pointer', alignItems: 'flex-start' }, onclick: () => info.onClick && info.onClick() }, pic, body);
  if (n.is_new) row.append(h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--carmine)', flex: 'none', marginTop: '6px' } }));
  const del = DELETE_EP[n.type];
  if (del) {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      sheet(null, [{
        label: 'Удалить', icon: 'ic_trash_outline', danger: true,
        onClick: async () => {
          try { await api.get(`${del}/${n.id}`); row.remove(); toast('Уведомление удалено'); onChanged(); } catch { toast(t('error_load')); }
        },
      }]);
    });
  }
  return row;
}

// Страница уведомлений по фильтру: несколько источников, свежие сверху
async function loadNotifs(filter, page) {
  const def = FILTERS.find((f) => f[0] === filter);
  const parts = await Promise.all(def[2].map((p) => api.get(`${p}/${page}`).catch(() => ({ content: [] }))));
  const items = [].concat(...parts.map((r) => r.content || []));
  items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  // has-more: хотя бы один источник отдал полную страницу
  return { content: items, hasMore: parts.some((r) => (r.content || []).length >= 25) };
}
// первая страница — в памяти и с нажатия колокольчика (common.js notifButton): открывается без мелькания скелетона
export function prefetchNotifications() { return prefetchRead('notifications:1', () => loadNotifs(1, 0)); }

registerScreen('notifications', () => {
  let filter = 1;
  let markedRead = false;
  const holder = h('div');
  const badgeChanged = () => window.dispatchEvent(new CustomEvent('notifications-read'));

  function build() {
    const def = FILTERS.find((f) => f[0] === filter);
    const list = pagedList({
      skeleton: 'notifications', remember: `notifications:${filter}`,
      load: (page) => loadNotifs(filter, page),
      onFirst: (r) => {
        // есть новые — через 1 с notification/read
        if (!markedRead && (r.content || []).some((x) => x.is_new)) {
          markedRead = true;
          setTimeout(() => { api.get('notification/read').then(badgeChanged).catch(() => {}); }, 1000);
        }
      },
      render: (n) => notificationRow(n, badgeChanged),
      empty: () => emptyView('Уведомлений нет', null, 'ic_bell'),
    });
    holder.replaceChildren(
      h('div', { class: 'row', style: { padding: '8px 20px' } },
        h('div', { class: 'grow' }),
        h('button', {
          class: 'chip',
          onclick: () => sheet('Фильтр', FILTERS.map(([v, l]) => ({ label: l, checked: v === filter, onClick: () => { filter = v; build(); } }))),
        }, actionIcon('ic_tune', 'sm'), def[1])),
      list);
  }

  build();
  return h('div', null,
    backToolbar('Уведомления', [
      iconButton('ic_trash_outline', 'Очистить все', async () => {
        if (!(await confirmDialog('Подтверждение', 'Вы уверены, что хотите очистить все уведомления?', 'Очистить'))) return;
        try { await api.get('notification/delete/all'); build(); badgeChanged(); } catch { toast(t('error_load')); }
      }),
      iconButton('ic_settings', 'Настройки уведомлений', () => navigate('notification-settings')),
    ]),
    holder);
});

// Настройки уведомлений: GET-переключатели без тела
const NOTIF_PREFS = [
  ['is_episode_notifications_enabled', 'О выходе новых серий', 'profile/preference/notification/episode/edit'],
  ['is_first_episode_notification_enabled', 'Получать только одно уведомление', 'profile/preference/notification/episode/first/edit'],
  ['is_related_release_notifications_enabled', 'О новых связанных релизах', 'profile/preference/notification/related/release/edit'],
  ['is_article_notifications_enabled', 'О новых записях', 'profile/preference/notification/article/edit'],
  ['is_comment_notifications_enabled', 'Уведомления об ответах', 'profile/preference/notification/comment/edit'],
  ['is_my_collection_comment_notifications_enabled', 'Комментарии к моим коллекциям', 'profile/preference/notification/my/collection/comment/edit'],
  ['is_my_article_comment_notifications_enabled', 'Комментарии к моим записям', 'profile/preference/notification/my/article/comment/edit'],
  ['is_report_process_notifications_enabled', 'Обработка жалоб', 'profile/preference/notification/report/process/edit'],
];

registerScreen('notification-settings', async () => {
  const root = h('div', null, backToolbar('Уведомления'));
  const my = await api.get('profile/preference/notification/my');
  const list = h('div', { class: 'menu-list', style: { maxWidth: '760px' } });
  for (const [key, label, path] of NOTIF_PREFS) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!my[key];
    cb.onchange = async () => {
      try { const r = await api.get(path); if (r.code !== 0) throw new Error(); } catch { cb.checked = !cb.checked; toast(t('error_load')); }
    };
    list.append(h('label', { class: 'menu-item' }, icon('ic_bell'), h('div', { class: 'grow' }, label), h('span', { class: 'switch' }, cb, h('span'))));
  }
  root.append(list);
  return root;
}, () => [backToolbar('Уведомления'), skeleton('switches', NOTIF_PREFS.length)]);
