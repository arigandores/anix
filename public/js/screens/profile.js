// Профиль и подэкраны (друзья, списки, оценки, комментарии)
import { h, icon, actionIcon, iconButton, growBars, img, toast, tabs, pagedList, emptyView, sheet, confirmDialog, skeleton, markAppeared, morph } from '../ui.js';
import { A, api, auth, remembered } from '../api.js';
import { t, tp, prefs } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { mainToolbar, backToolbar, relTime, digits, needAuthView, releaseRow, commentItem, collectionCard, avatarEl, profileName, report, openRelease } from './common.js';
import { BOOKMARK_TABS, bookmarkReleaseTab } from './bookmarks.js';
import { articleCard } from './feed.js';

function watchedTime(min) {
  if (!min) return '0 мин.';
  if (prefs.get('WATCHED_TIME_FORMAT') === 'hours' && min >= 60) { const all = Math.floor(min / 60); return `~ ${all} ${['час', 'часа', 'часов'][pl(all)]}`; }
  const d = Math.floor(min / 1440); const hh = Math.floor((min % 1440) / 60);
  if (!d && !hh) return `${min} мин.`;
  return `~ ${d ? `${d} ${['день', 'дня', 'дней'][pl(d)]} ` : ''}${hh} ${['час', 'часа', 'часов'][pl(hh)]}`;
}
// Динамика просмотра (как в Anixart): серий за день — 8 дней подряд по последний день с просмотрами, дни без
// просмотров — «0» и короткий столбик (а не пропуск: один день не висит посреди пустой карточки). Число — над каждым
// столбцом (на телефоне нет наведения), дата — под ним наискосок; столбцы узкие, со скруглённым верхом, с промежутками
const DYN_DAYS = 8;
const BAR_MAX = 120; // px — самый высокий столбец
export function watchDynamics(dyn) {
  const dayStart = (ts) => { const d = new Date(ts * 1000); d.setHours(0, 0, 0, 0); return d; };
  const counts = new Map();
  for (const d of dyn) { const k = dayStart(d.timestamp).getTime(); counts.set(k, (counts.get(k) || 0) + (d.count || 0)); }
  const last = new Date(Math.max(...counts.keys()));
  const days = Array.from({ length: DYN_DAYS }, (_, i) => {
    const d = new Date(last); d.setDate(d.getDate() - (DYN_DAYS - 1 - i));
    return { date: d, count: counts.get(d.getTime()) || 0 };
  });
  const max = Math.max(1, ...days.map((d) => d.count));
  const label = (d) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
  const episodes = (n) => `${n} ${['серия', 'серии', 'серий'][pl(n)]}`;
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Динамика просмотра серий'),
    h('div', { class: 'wdyn', role: 'img', 'aria-label': days.map((d) => `${label(d.date)}: ${episodes(d.count)}`).join(', ') },
      days.map((d) => h('div', { class: 'wdyn-col', title: `${label(d.date)}: ${episodes(d.count)}` },
        h('span', { class: 'wdyn-n' }, String(d.count)),
        h('div', { class: `wdyn-bar ${d.count ? '' : 'zero'}`, style: d.count ? { height: `${Math.max(16, Math.round((d.count / max) * BAR_MAX))}px` } : null }),
        h('span', { class: 'wdyn-d' }, label(d.date))))));
}
function pl(n) { const a = n % 100; const b = n % 10; if (a > 10 && a < 20) return 2; if (b > 1 && b < 5) return 1; if (b === 1) return 0; return 2; }

function registered(sec) {
  if (!sec) return 'давно';
  const d = new Date(sec * 1000); const now = new Date();
  const M = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
  if (d.toDateString() === now.toDateString()) return 'с сегодня';
  return d.getFullYear() === now.getFullYear() ? `с ${d.getDate()} ${M[d.getMonth()]}` : `с ${d.getDate()} ${M[d.getMonth()]} ${d.getFullYear()}`;
}

function friendButtons(p, rebuild) {
  if (p.is_my_profile) return [h('button', { class: 'btn btn-tonal', onclick: () => navigate('settings', { section: 'account' }) }, 'Редактировать')];
  const me = auth.profileId; const fs = p.friend_status;
  const out = (me < p.id && fs === 0) || (me > p.id && fs === 1);
  const inc = (me < p.id && fs === 1) || (me > p.id && fs === 0);
  const send = async () => {
    if (!auth.loggedIn) return navigate('auth');
    const r = await A.friendRequestSend(p.id);
    const msg = { 4: 'Пользователь внес Вас в свой блоклист.', 6: 'Вы превысили допустимый лимит по количеству друзей.', 7: 'Пользователь превысил допустимый лимит по количеству друзей.', 8: 'Пользователь ограничил входящие заявки.', 9: 'Вы превысили допустимый лимит по количеству друзей.' }[r.code];
    if (msg) return toast(msg);
    p.friend_status = r.friend_status ?? p.friend_status; rebuild();
  };
  const remove = async () => { const r = await A.friendRequestRemove(p.id); p.friend_status = r.friend_status ?? null; rebuild(); };
  if (fs === 2) return [h('button', { class: 'btn btn-tonal', onclick: remove }, 'Удалить из друзей')];
  if (out) return [h('button', { class: 'btn btn-tonal', onclick: remove }, 'Заявка отправлена')];
  if (inc) return [h('span', { class: 'muted' }, 'Отправил(а) Вам заявку в друзья'), h('button', { class: 'btn btn-primary', onclick: send }, 'Добавить в друзья')];
  return [h('button', { class: 'btn btn-primary', disabled: p.is_friend_requests_disallowed || p.is_me_blocked || p.is_blocked, onclick: send }, 'Добавить в друзья')];
}

// blog — блок «Записи» прежнего вида того же профиля: при тихом обновлении переносится как есть,
// чтобы не грузить его заново со скелетоном
async function profileView(id, { fromMain = false, blog = null } = {}) {
  const root = h('div');
  // повторный заход — сразу из памяти; свежие данные фоном: изменились — профиль пересобирается (api.js remembered)
  const r = await remembered(`profile:${id}`, () => A.profile(id), (fresh) => {
    if (!fresh?.profile || !root.isConnected) return;
    Object.assign(p, fresh.profile); p.is_my_profile = fresh.is_my_profile || p.id === auth.profileId;
    // изменилось только то, что изменилось: правим на месте и плавно (ui.js morph), без пересборки экрана
    const next = h('div'); build(next); morph(root, markAppeared(next));
  });
  const p = r.profile;
  if (!p) { root.append(fromMain ? mainToolbar() : backToolbar(t('profile')), emptyView('Профиль не найден')); return root; }
  p.is_my_profile = r.is_my_profile || p.id === auth.profileId;
  let blogHolder = blog;
  const blogSection = () => {
    if (blogHolder) return blogHolder.isConnected && building ? h('div', { 'data-keep': '' }) : blogHolder; // в дереве для morph — заглушка
    blogHolder = h('div', { 'data-keep': '' }); // подгружается сам — при фоновом обновлении не трогаем (morph)
    const holder = blogHolder;
    remembered(`blog:${p.id}`, () => A.blog(p.id)).then((b) => { // блог и первая страница записей — тоже из памяти
      if (!b.channel) return;
      holder.append(h('div', { class: 'section-head', style: { padding: '18px 0 6px' } }, h('div', { class: 'section-title' }, 'Записи')),
        pagedList({ skeleton: 'articles', load: (page) => A.channelArticles(b.channel.id, page), remember: `channel-articles:${b.channel.id}`, render: (a) => articleCard(a), empty: () => emptyView('Похоже, нет ни одной записи') }));
    }).catch(() => {});
    return holder;
  };
  // target — куда собрать: при фоновом обновлении — в отдельное дерево, которое вливается в показанное (morph)
  let building = false;
  const build = (target = root) => {
    building = target !== root;
    target.replaceChildren();
    target.append(fromMain ? mainToolbar({ hint: 'Поиск пользователей', onSearch: () => navigate('search', { scope: 'profiles' }) })
      : backToolbar(t('profile'), [iconButton('ic_more', 'Ещё', () => moreSheet(p))]));
    if (p.is_deleted) { target.append(emptyView('Профиль удалён')); return; }
    const head = h('div', { class: 'profile-head' },
      h('div', { style: { position: 'relative' } }, img(p.avatar, 'avatar lg'), p.is_online ? h('span', { style: { position: 'absolute', right: '6px', bottom: '6px', width: '16px', height: '16px', borderRadius: '50%', background: 'var(--green)', border: '3px solid var(--bg)' } }) : null),
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, p.login, p.is_verified ? icon('ic_verified', 'sm verified') : null, p.badge?.image_url ? h('img', { src: p.badge.image_url, referrerpolicy: 'no-referrer', style: { width: '24px', height: '24px' } }) : null),
        h('div', { class: 'muted' }, p.status || 'Статус не установлен'),
        h('div', { class: 'row muted', style: { fontSize: '13px', marginTop: '4px', flexWrap: 'wrap' } },
          h('span', { title: 'Уровень репутации пользователя' }, icon('ic_stars', 'xs'), ` ${p.rating_score ?? 0}`),
          p.is_online ? h('span', { class: 'online' }, 'в сети') : p.last_activity_time ? h('span', null, `был(а) в сети ${relTime(p.last_activity_time)}`) : null,
          h('span', null, `в Anixart ${registered(p.register_date)}`)),
        (p.roles || []).length ? h('div', { class: 'chips', style: { marginTop: '8px' } }, p.roles.map((ro) => h('span', { class: 'badge', style: { background: ro.color ? `#${String(ro.color).replace('#', '')}33` : '' } }, ro.name))) : null,
        !p.is_social_hidden ? h('div', { class: 'row', style: { marginTop: '8px' } },
          p.vk_page ? iconButton('ic_vk', 'ВКонтакте', () => window.open(`https://vk.com/${p.vk_page}`, '_blank'), 'sm') : null,
          p.tg_page ? iconButton('ic_telegram', 'Telegram', () => window.open(`https://t.me/${p.tg_page}`, '_blank'), 'sm') : null,
          p.tt_page ? iconButton('ic_tiktok', 'TikTok', () => window.open(`https://tiktok.com/@${p.tt_page}`, '_blank'), 'sm') : null,
          p.discord_page ? iconButton('ic_discord', `Discord: ${p.discord_page}`, () => { navigator.clipboard?.writeText(p.discord_page); toast('Скопировано', { ok: true }); }, 'sm') : null) : null,
        h('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap' } }, friendButtons(p, build))));
    target.append(head);
    if (p.is_banned) target.append(h('div', { class: 'rel-note', style: { margin: '0 24px 10px' } }, p.is_perm_banned ? 'Пользователь был заблокирован за нарушение правил навсегда' : `Пользователь был заблокирован за нарушение правил до ${new Date(p.ban_expires * 1000).toLocaleDateString('ru-RU')}`));
    if (p.is_me_blocked) { target.append(h('div', { class: 'rel-note', style: { margin: '0 24px' } }, 'Пользователь внес Вас в свой блоклист. Вы не можете просматривать информацию этого профиля.')); return; }
    if (p.is_private && !p.is_my_profile) target.append(h('div', { class: 'rel-note', style: { margin: '0 24px 10px' } }, 'У пользователя установлены настройки приватности. Некоторая информация для Вас может быть недоступна.'));

    const body = h('div', { class: 'container', style: { padding: '0 var(--page-pad) 40px' } });
    // Друзья
    body.append(h('div', { class: 'card', style: { cursor: 'pointer' }, onclick: () => navigate('friends', { profile: p }) },
      h('div', { class: 'row' }, icon('ic_person_add'), h('b', { class: 'grow' }, p.friend_count ? `${p.friend_count} ${tp('friends', p.friend_count)}` : 'Нет друзей'),
        h('div', { class: 'row', style: { gap: '0' } }, (p.friends_preview || []).slice(0, 3).map((f) => img(f.avatar, 'avatar', f.login))), icon('ic_chevron_end'))));
    // Витрина
    if (!(p.is_stats_hidden && p.is_counts_hidden)) {
      const rows = [['Смотрю', p.watching_count, 'green', 1], ['В планах', p.plan_count, 'purple', 2], ['Просмотрено', p.completed_count, 'blue', 3], ['Отложено', p.hold_on_count, 'yellow', 4], ['Брошено', p.dropped_count, 'red', 5]];
      const total = rows.reduce((a, x) => a + (x[1] || 0), 0) || 1;
      const pref = (arr) => (arr || []).slice().sort((a, b) => b.percentage - a.percentage).map((x) => `${x.name} ${x.percentage}%`).join(', ');
      body.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Статистика'),
        growBars(h('div', { class: 'progress-multi' }, rows.map(([, n, c]) => h('div', { style: { width: `${((n || 0) * 100) / total}%`, background: `var(--${c})` } })))),
        h('div', { class: 'stat-grid' }, rows.map(([l, n, c, st]) => h('div', { class: 'stat clickable', onclick: () => (p.is_my_profile ? null : navigate('profile-lists', { profile: p, status: st })) },
          h('b', { style: { color: `var(--${c})` } }, digits(n)), h('span', null, l)))),
        h('div', { class: 'info-rows', style: { marginTop: '12px' } },
          p.preferred_genres ? h('div', null, h('b', null, 'Жанры: '), pref(p.preferred_genres)) : null,
          p.preferred_audiences ? h('div', null, h('b', null, 'Аудитория: '), pref(p.preferred_audiences)) : null,
          p.preferred_themes ? h('div', null, h('b', null, 'Тематика: '), pref(p.preferred_themes)) : null,
          h('div', null, h('b', null, 'Просмотрено серий: '), digits(p.watched_episode_count)),
          h('div', null, h('b', null, 'Время просмотра: '), watchedTime(p.watched_time))),
        h('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap' } },
          h('button', { class: 'btn btn-tonal', onclick: () => (p.is_my_profile ? import('../router.js').then((m) => m.switchTab('bookmarks')) : navigate('profile-lists', { profile: p, status: 1 })) }, 'Списки просмотра'),
          h('button', { class: 'btn btn-tonal', onclick: () => navigate('profile-votes', { profile: p }) }, 'Оценки'),
          h('button', { class: 'btn btn-tonal', onclick: () => navigate('profile-comments', { profile: p }) }, `Комментарии ${p.comment_count ?? ''}`),
          h('button', { class: 'btn btn-tonal', onclick: () => navigate('profile-collections', { profileId: p.id }) }, `Коллекции ${p.collection_count ?? ''}`))));
    }
    const dyn = (p.watch_dynamics || []).filter((d) => d && d.timestamp);
    if (dyn.length && !p.is_stats_hidden) body.append(watchDynamics(dyn));
    if ((p.votes || []).length) {
      // название — всегда на две строки: звёзды под всеми релизами на одной высоте (короткое название поднимало их)
      body.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Оценки релизов'),
        h('div', { class: 'screens', style: { gap: '12px' } }, p.votes.map((rel) => h('div', { class: 'release-card', style: { width: '110px', flex: 'none' }, onclick: () => openRelease(rel) },
          h('div', { class: 'poster', style: { width: '100%' } }, img(rel.image)), h('div', { class: 't clamp2', style: { fontSize: '12px', minHeight: '2.5em' } }, rel.title_ru), h('div', { class: 'meta' }, '★'.repeat(rel.my_vote || 0)))))));
    }
    if ((p.history || []).length && !p.is_stats_hidden) {
      body.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Просмотрено недавно'),
        h('div', { class: 'list' }, p.history.map((rel) => releaseRow(rel, { history: true })))));
    }
    if ((p.collections_preview || []).length) {
      body.append(h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Коллекции'), h('div', { class: 'grid', style: { padding: 0 } }, p.collections_preview.map(collectionCard))));
    }
    if ((p.comments_preview || []).length) {
      body.append(h('div', { class: 'card', style: { padding: '16px 0' } }, h('div', { class: 'card-title', style: { padding: '0 16px' } }, 'Комментарии'),
        p.comments_preview.map((c) => commentItem(c, { kind: 'release', showTarget: true }))));
    }
    // Блог
    body.append(blogSection());
    target.append(body);
  };
  build();
  root.blog = blogHolder;
  return root;
}

function moreSheet(p) {
  const base = (window.__toggles && window.__toggles.baseUrl) || 'https://anixart-app.com/';
  sheet(p.login, [
    { label: 'История никнейма', icon: 'ic_history', onClick: () => navigate('login-history', { profile: p }) },
    // «Поделиться» — системное меню (телефон), как на странице аниме; без него — в буфер
    navigator.share ? { label: 'Поделиться', icon: 'ic_export_variant', onClick: () => navigator.share({ text: `${p.login}
${base}profile/${p.id}` }).catch(() => {}) } : null,
    { label: 'Скопировать ссылку', icon: 'ic_link', onClick: () => { navigator.clipboard?.writeText(`${base}profile/${p.id}`); toast('Скопировано', { ok: true }); } },
    !p.is_my_profile ? { label: 'Пожаловаться', icon: 'ic_alert', onClick: () => report('profile', p.id) } : null,
    !p.is_my_profile && auth.loggedIn ? (p.is_blocked
      ? { label: 'Разблокировать', icon: 'ic_lock', onClick: async () => { await A.blockRemove(p.id); p.is_blocked = false; toast('Пользователь убран из Вашего блоклиста'); } }
      : { label: 'Заблокировать', icon: 'ic_lock', danger: true, onClick: async () => { if (await confirmDialog('Заблокировать', 'Вы действительно хотите заблокировать пользователя?', 'Заблокировать')) { await A.blockAdd(p.id); p.is_blocked = true; toast('Пользователь добавлен в Ваш блоклист'); } } }) : null,
  ]);
}

registerScreen('tab:profile', async (_p, ctx) => {
  if (!auth.loggedIn) return needAuthView();
  // свой профиль обновляется при возврате на вкладку: «Просмотрено недавно», счётчики списков и т.д.
  const holder = h('div');
  const load = async () => {
    const prev = holder.firstChild;
    try {
      const view = await profileView(auth.profileId, { fromMain: true, blog: prev?.blog || null });
      holder.replaceChildren(prev ? markAppeared(view) : view);
    } catch { /* оставляем прежний вид */ }
  };
  await load();
  ctx.setOnShow(({ returning }) => { if (returning) load(); });
  return holder;
}, () => [auth.loggedIn ? mainToolbar({ hint: 'Поиск пользователей' }) : null, auth.loggedIn ? skeleton('profile') : null]);
registerScreen('profile', ({ id }) => profileView(id), () => [backToolbar(t('profile')), skeleton('profile')]);

registerScreen('login-history', ({ profile }) => h('div', null, backToolbar('История никнейма'),
  pagedList({ skeleton: 'menu', load: (page) => api.get(`profile/login/history/all/${profile.id}/${page}`), render: (c) => h('div', { class: 'menu-item' }, icon('ic_history'), h('div', { class: 'grow' }, c.newLogin || c.new_login), h('span', { class: 'muted' }, relTime(c.timestamp))), empty: () => emptyView('Изменений нет') })));

function profileRow(p) {
  return h('div', { class: 'type-row', onclick: () => navigate('profile', { id: p.id }) }, avatarEl(p), h('div', { class: 'grow' }, profileName(p), p.friend_count != null ? h('div', { class: 'muted', style: { fontSize: '12px' } }, `${p.friend_count} ${tp('friends', p.friend_count)}`) : null));
}

registerScreen('friends', ({ profile }) => {
  const mine = profile.id === auth.profileId;
  const defs = [{ title: 'Друзья', render: () => pagedList({ skeleton: 'profiles', load: (page) => A.friends(profile.id, page), render: profileRow, empty: () => emptyView('Друзей пока нет') }) }];
  if (mine) {
    defs.push({
      title: 'Заявки в друзья',
      render: () => pagedList({
        skeleton: 'profiles',
        load: (page) => A.friendRequestsIn(page),
        render: (p) => { const row = profileRow(p); row.append(h('button', { class: 'btn btn-primary', onclick: async (e) => { e.stopPropagation(); await A.friendRequestSend(p.id); row.remove(); } }, 'Принять'), h('button', { class: 'btn btn-text', onclick: async (e) => { e.stopPropagation(); await A.friendRequestHide(p.id); row.remove(); } }, 'Скрыть')); return row; },
        empty: () => emptyView('Заявок нет'),
      }),
    }, {
      title: 'Исходящие заявки',
      render: () => pagedList({
        skeleton: 'profiles',
        load: (page) => A.friendRequestsOut(page),
        render: (p) => { const row = profileRow(p); row.append(h('button', { class: 'btn btn-text', onclick: async (e) => { e.stopPropagation(); await A.friendRequestRemove(p.id); row.remove(); } }, 'Отменить')); return row; },
        empty: () => emptyView('Заявок нет'),
      }),
    });
  }
  return h('div', null, backToolbar('Друзья'), tabs(defs));
});

registerScreen('profile-lists', ({ profile, status = 1 }) => h('div', null, backToolbar('Списки просмотра'),
  tabs(BOOKMARK_TABS.filter((d) => d.status).map((d) => ({ title: t(d.title), render: () => bookmarkReleaseTab(d, { profileId: profile.id }) })), { initial: status - 1 })));

const VOTE_SORTS = [[1, 'Сначала последние'], [2, 'Сначала старые'], [3, '5 звёзд'], [4, '4 звезды'], [5, '3 звезды'], [6, '2 звезды'], [7, '1 звезда']];
registerScreen('profile-votes', ({ profile }) => {
  let sort = 1; const holder = h('div');
  const build = () => holder.replaceChildren(
    h('div', { class: 'row', style: { padding: '8px var(--gutter)' } }, h('div', { class: 'grow' }),
      h('button', { class: 'chip', onclick: () => sheet('Сортировка', VOTE_SORTS.map(([v, l]) => ({ label: l, checked: v === sort, onClick: () => { sort = v; build(); } }))) }, actionIcon('ic_sort', 'sm'), VOTE_SORTS.find((x) => x[0] === sort)[1])),
    pagedList({ load: (page) => A.votedReleases(profile.id, page, sort), render: (r) => { const row = releaseRow(r); row.querySelector('.info').append(h('div', { style: { color: 'var(--orange)' } }, '★'.repeat(r.my_vote || 0), r.voted_at ? h('span', { class: 'muted', style: { marginLeft: '8px', fontSize: '12px' } }, relTime(r.voted_at)) : null)); return row; }, empty: () => emptyView('Оценённых релизов нет') }));
  build();
  return h('div', null, backToolbar('Оценки'), holder);
});

registerScreen('profile-comments', ({ profile }) => h('div', null, backToolbar('Комментарии'), tabs([
  { title: 'К релизам', render: () => pagedList({ skeleton: 'comments', load: (page) => A.profileReleaseComments(profile.id, page, 1), render: (c) => commentItem(c, { kind: 'release', showTarget: true }), empty: () => emptyView('Пользователь не оставлял ни одного комментария к релизам') }) },
  { title: 'К коллекциям', render: () => pagedList({ skeleton: 'comments', load: (page) => api.get(`collection/comment/all/profile/${profile.id}/${page}`, { sort: 1 }), render: (c) => commentItem(c, { kind: 'collection' }), empty: () => emptyView('Пользователь не оставлял ни одного комментария к коллекциям') }) },
  { title: 'К записям', render: () => pagedList({ skeleton: 'comments', load: (page) => api.get(`article/comment/all/profile/${profile.id}/${page}`, { sort: 1 }), render: (c) => commentItem(c, { kind: 'article' }), empty: () => emptyView('Пользователь не оставлял ни одного комментария к записям') }) },
])));

