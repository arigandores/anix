// Общие элементы интерфейса: релизы, карточки, комментарии и т. п.
import { h, icon, iconButton, img, toast, dialog, sheet, prompt, confirmDialog } from '../ui.js';
import { A, auth, prefetchRelease, dropPrefetchedRelease } from '../api.js';
import { t, tp } from '../store.js';
import { navigate } from '../router.js';
import { partyEntryButton } from '../party/ui.js';

// ---------- Форматирование ----------
export function gradeText(g) {
  if (g == null) return '';
  const r = Math.round(Number(g) * 10) / 10;
  return String(r).replace(/\.0$/, '');
}
export function digits(n) { return String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }

export function episodesText(rel) {
  const R = rel.episodes_released; const T = rel.episodes_total;
  const st = rel.status?.id ?? rel.status_id;
  if ((R != null && R === T) || st === 3) return T != null ? t('format_episodes_total', T) : t('label_episodes_unknown');
  if (R != null && T != null) return t('format_episodes_of', R, T);
  if (R != null) return `${R} из ? эп`;
  if (T != null) return `? из ${T} эп`;
  return '';
}

const MON_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
const SEASONS = ['', 'зима', 'весна', 'лето', 'осень'];
export function seasonName(i) { return SEASONS[i] || ''; }

export function relTime(sec) {
  if (!sec) return t('time_not_specified') !== 'time_not_specified' ? t('time_not_specified') : 'время не указано';
  const now = Date.now() / 1000; const d = now - sec;
  const date = new Date(sec * 1000); const today = new Date();
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (d < 5) return 'только что';
  if (d < 60) return `${Math.floor(d)} сек назад`;
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 4 * 3600) return `${Math.floor(d / 3600)} ч назад`;
  if (date.toDateString() === today.toDateString()) return `сегодня в ${hm}`;
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return `вчера в ${hm}`;
  const base = `${date.getDate()} ${MON_SHORT[date.getMonth()]}`;
  return date.getFullYear() === today.getFullYear() ? `${base} в ${hm}` : `${base} ${date.getFullYear()} в ${hm}`;
}
export function dateFull(sec) { const d = new Date(sec * 1000); return `${d.getDate()} ${MON_SHORT[d.getMonth()]} ${d.getFullYear()} г.`; }

const LIST_BADGE = ['', 'status_watching', 'status_plan', 'status_completed', 'status_hold_on', 'status_dropped'];
export const LIST_NAMES = ['list_no_watching', 'list_watching', 'list_plan', 'list_completed', 'list_hold_on', 'list_dropped'];

function posterEl(rel, cls = 'poster') {
  const p = h('div', { class: cls }, img(rel.image, '', rel.title_ru || ''));
  const s = rel.profile_list_status;
  if (s && s > 0 && s < 6) p.append(h('div', { class: `status-bubble s${s}` }, t(LIST_BADGE[s])));
  return p;
}

function metaRow(rel, { small = false } = {}) {
  const parts = [];
  const st = rel.status?.id ?? rel.status_id;
  if (st === 3 && !small) parts.push(h('span', null, t('label_announcement')));
  const ep = episodesText(rel);
  if (ep) parts.push(h('span', null, ep));
  const out = h('div', { class: 'meta row', style: { gap: '6px', flexWrap: 'wrap' } });
  parts.forEach((p, i) => { if (i) out.append(h('span', null, '•')); out.append(p); });
  if (rel.vote_count > 50) {
    if (parts.length) out.append(h('span', null, '•'));
    out.append(h('span', { class: 'row', style: { gap: '2px' } }, gradeText(rel.grade), icon('ic_star_rate', 'xs')));
  }
  if (rel.is_favorite) out.append(icon('ic_favorite', 'sm heart'));
  return out;
}

function announceChip(rel) {
  const st = rel.status?.id ?? rel.status_id;
  if (st !== 3) return null;
  let txt;
  if (rel.aired_on_date) txt = dateFull(rel.aired_on_date);
  else if (rel.season && rel.year) txt = `${seasonName(rel.season)} ${rel.year} г.`;
  else if (rel.year) txt = `${rel.year} г.`;
  else txt = 'скоро';
  return h('span', { class: 'chip-ann' }, txt);
}

export function openRelease(rel) { navigate('release', { id: rel.id, preload: rel }); }

// Предзагрузка при наведении: только когда курсор остановился на карточке (200 мс без движения)
// и список в этот момент не прокручивается (колесо/перетаскивание). Проход курсором по списку запросов не шлёт.
let scrollingUntil = 0;
addEventListener('wheel', () => { scrollingUntil = Date.now() + 350; }, { passive: true, capture: true });
function hoverPrefetch(el, rel) {
  let tm;
  el.addEventListener('mousemove', () => {
    clearTimeout(tm);
    tm = setTimeout(() => {
      if (Date.now() < scrollingUntil || document.querySelector('.dragging') || !el.matches(':hover')) return;
      prefetchRelease(rel.id);
    }, 200);
  });
  el.addEventListener('mouseleave', () => clearTimeout(tm));
  return el;
}

// Строка релиза в списке
export function releaseRow(rel, { rank, onMore, history } = {}) {
  const st = rel.status?.id ?? rel.status_id;
  const desc = rel.description || (st === 3 ? '' : t('description_not_specified'));
  const row = h('div', { class: 'release-row', onclick: () => openRelease(rel), oncontextmenu: (e) => { e.preventDefault(); releaseSheet(rel); } },
    rank != null ? h('div', { class: 'rank' }, String(rank)) : null,
    posterEl(rel),
    h('div', { class: 'info' },
      h('div', { class: 'row', style: { alignItems: 'flex-start' } },
        h('div', { class: 't grow clamp2' }, rel.title_ru || rel.title_original || t('unnamed')),
        iconButton('ic_more', 'Ещё', (e) => { e.stopPropagation(); (onMore || releaseSheet)(rel); }, 'sm')),
      metaRow(rel),
      announceChip(rel),
      history ? historyLine(rel) : null,
      desc ? h('div', { class: `desc ${st === 3 ? 'clamp3' : 'clamp4'}`, style: { WebkitLineClamp: st === 3 ? 3 : 4, display: '-webkit-box', WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, desc) : null));
  return hoverPrefetch(row, rel);
}

function historyLine(rel) {
  const ep = rel.last_view_episode;
  const parts = [];
  if (ep) parts.push(ep.name || `${ep.position} серия`);
  const typeName = ep?.source?.type?.name;
  if (typeName) parts.push(typeName);
  return h('div', { class: 'col', style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
    parts.length ? h('div', { class: 'hist-line' }, h('span', { style: { color: 'var(--carmine)' } }, icon('ic_check_circle_outline')), parts.join(' • ')) : null,
    rel.last_view_timestamp ? h('div', { class: 'hist-line' }, h('span', { style: { color: '#4db6ac' } }, icon('ic_timelapse')), relTime(rel.last_view_timestamp)) : null);
}

// Карточка релиза
export function releaseCard(rel) {
  return hoverPrefetch(h('div', { class: 'release-card', onclick: () => openRelease(rel), oncontextmenu: (e) => { e.preventDefault(); releaseSheet(rel); } },
    posterEl(rel),
    h('div', { class: 't clamp2' }, rel.title_ru || rel.title_original || t('unnamed')),
    metaRow(rel, { small: true })), rel);
}

// ---------- Need auth ----------
export function needAuthDialog() {
  dialog({
    title: t('need_auth_title'),
    content: h('p', null, t('need_auth_desc')),
    actions: [{ label: t('later') }, { label: t('log_in'), primary: true, onClick: () => navigate('auth') }],
  });
}
export function requireAuth() { if (auth.loggedIn) return true; needAuthDialog(); return false; }
export function needAuthView() {
  return h('div', { class: 'empty center-gate' }, // посередине экрана (app.css)
    icon('logo', 'big brand'), // фирменный, а не приглушённый, как иконки других пустых экранов
    h('div', { class: 'empty-title', style: { fontSize: '22px' } }, t('need_auth_title')),
    h('div', { class: 'empty-sub', style: { maxWidth: '380px' } }, t('need_auth_desc')),
    h('button', { class: 'btn btn-primary lg', style: { marginTop: '14px' }, onclick: () => navigate('auth') }, t('log_in')));
}

// ---------- Список / избранное ----------
export const STATUS_COLORS = ['var(--text4)', 'var(--green)', 'var(--purple)', 'var(--blue)', 'var(--yellow)', 'var(--red)'];
export async function chooseListStatus(rel, onChanged) {
  if (!requireAuth()) return;
  const cur = rel.profile_list_status || 0;
  sheet(t('title_choose_watch_status'), LIST_NAMES.map((k, i) => ({
    label: t(k), checked: i === cur,
    // цвет статуса как в легенде «В списках у людей»; «Не смотрю» — серый
    dot: STATUS_COLORS[i],
    onClick: async () => {
      if (i === cur) return;
      try {
        if (i === 0) {
          await A.listDelete(cur, rel.id);
          toast(t('format_removed_from_list', t(LIST_NAMES[cur])));
        } else {
          await A.listAdd(i, rel.id);
          toast(t('format_added_to_list', t(LIST_NAMES[i])));
        }
        rel.profile_list_status = i;
        dropPrefetchedRelease(rel.id);
        onChanged && onChanged(i);
      } catch (e) { toast(t('error_load')); }
    },
  })));
}

export async function toggleFavorite(rel, onChanged) {
  if (!requireAuth()) return;
  try {
    if (rel.is_favorite) {
      await A.favDelete(rel.id);
      rel.is_favorite = false; rel.favorites_count = Math.max(0, (rel.favorites_count || 1) - 1);
      toast(t('toast_removed_from_favorites'));
    } else {
      await A.favAdd(rel.id);
      rel.is_favorite = true; rel.favorites_count = (rel.favorites_count || 0) + 1;
      toast(t('toast_added_to_favorites') !== 'toast_added_to_favorites' ? t('toast_added_to_favorites') : 'Добавлено в Избранное');
    }
    dropPrefetchedRelease(rel.id);
    onChanged && onChanged(rel.is_favorite);
  } catch { toast(t('error_load')); }
}

// Быстрое меню релиза
export function releaseSheet(rel) {
  if (!requireAuth()) return;
  const st = rel.profile_list_status || 0;
  const head = [rel.vote_count > 50 ? `★ ${gradeText(rel.grade)}` : null, episodesText(rel)].filter(Boolean).join(' • ');
  sheet(`${rel.title_ru || t('unnamed')}${head ? ` — ${head}` : ''}`, [
    rel.is_favorite
      ? { label: t('remove_from_favorite'), icon: 'ic_favorite', onClick: () => toggleFavorite(rel) }
      : { label: t('add_to_favorite'), icon: 'ic_favorite_border', onClick: () => toggleFavorite(rel) },
    { label: t('format_in_list', t(LIST_NAMES[st]).toLowerCase()), icon: 'ic_bookmarks', dot: st ? STATUS_COLORS[st] : null, onClick: () => chooseListStatus(rel) },
    rel.is_viewed ? {
      label: t('remove_from_history'), icon: 'ic_history',
      onClick: async () => { try { await A.historyDelete(rel.id); rel.is_viewed = false; toast(t('toast_removed_from_history')); } catch { toast(t('error_load')); } },
    } : null,
  ]);
}

// Колокольчик с бейджем notification/count (тулбары Главной, Обзора, Закладок, Ленты, Профиля)
function notifButton() {
  const btn = h('button', { class: 'icon-btn', title: 'Уведомления', style: { position: 'relative' }, onclick: () => { if (requireAuth()) navigate('notifications'); } }, icon('ic_bell'));
  if (auth.loggedIn) {
    A.notifCount().then((r) => {
      if (r.count > 0) {
        btn.append(h('span', {
          style: { position: 'absolute', top: '4px', right: '4px', minWidth: '16px', height: '16px', borderRadius: '8px', background: 'var(--carmine)', color: '#fff', fontSize: '10px', lineHeight: '16px', textAlign: 'center', padding: '0 4px' },
        }, r.count > 99 ? '99+' : String(r.count)));
      }
    }).catch(() => {});
  }
  return btn;
}

// ---------- Тулбар главных вкладок (search_bar + уведомления + настройки) ----------
export function mainToolbar({ hint = t('search_bar_text'), onSearch } = {}) {
  const bar = h('div', { class: 'appbar' },
    h('div', { class: 'searchbar', role: 'button', tabindex: '0', onclick: () => (onSearch ? onSearch() : navigate('search', {})) },
      icon('ic_search'), h('span', { class: 'placeholder' }, hint)),
    h('div', { class: 'grow' }),
    h('div', { class: 'actions' },
      partyEntryButton(), // «Смотреть вместе» (party/ui.js)
      notifButton(),
      iconButton('ic_settings', t('settings') !== 'settings' ? t('settings') : 'Настройки', () => navigate('settings'))));
  return bar;
}

// party — 👥 «Смотреть вместе» всегда (страница аниме, как в главной шапке); иначе — только пока вы в комнате
export function backToolbar(title, actions = [], { bordered = false, party = false } = {}) {
  return h('div', { class: `appbar ${bordered ? 'bordered' : ''}` },
    iconButton('ic_back', 'Назад', () => history.back()),
    h('div', { class: 'title small' }, title),
    h('div', { class: 'actions' }, partyEntryButton(party ? {} : { onlyInRoom: true }), actions));
}

export function sectionHead(title, more, sub) {
  return h('div', { class: 'section-head' },
    h('div', { class: 'grow' }, h('div', { class: 'section-title' }, title), sub ? h('div', { class: 'muted', style: { fontSize: '13px' } }, sub) : null),
    more ? h('button', { class: 'section-more', onclick: more }, t('show_more'), icon('ic_chevron_end', 'sm')) : null);
}

// ---------- Профиль: аватар + ник ----------
export function avatarEl(profile, cls = 'avatar') {
  const el = img(profile?.avatar, cls, profile?.login || '');
  el.onclick = (e) => { e.stopPropagation(); if (profile?.id) navigate('profile', { id: profile.id }); };
  return el;
}
export function profileName(profile) {
  return h('span', { class: 'row', style: { gap: '4px', display: 'inline-flex', cursor: 'pointer' }, onclick: (e) => { e.stopPropagation(); if (profile?.id) navigate('profile', { id: profile.id }); } },
    profile?.login || 'Гость',
    profile?.is_verified ? icon('ic_verified', 'xs verified') : null,
    profile?.badge_url && profile?.badge_type === 0 ? h('img', { src: profile.badge_url, referrerpolicy: 'no-referrer', style: { width: '18px', height: '18px' }, alt: profile.badge_name || '' }) : null);
}

// ---------- Комментарии (CommentModel) ----------
const COMMENT_PREFIX = { release: 'release', collection: 'collection', article: 'article' };

export function commentItem(c, { kind = 'release', release, onReply, onChanged, showTarget = false, compact = false } = {}) {
  const prefix = COMMENT_PREFIX[kind];
  const msg = h('div', { class: 'msg' });
  const hidden = !c.is_deleted && (c.is_spoiler || c.vote_count <= -5);
  if (c.is_deleted) msg.append(h('i', { class: 'muted' }, t('comment_deleted') !== 'comment_deleted' ? t('comment_deleted') : 'Комментарий удалён'));
  else if (hidden) {
    const why = c.is_spoiler && c.vote_count <= -5 ? 'Комментарий содержит спойлер и имеет слишком низкий рейтинг.'
      : c.is_spoiler ? 'Комментарий может содержать спойлер.' : 'У комментария слишком низкий рейтинг.';
    const box = h('div', { class: 'rel-note', style: { cursor: 'pointer', margin: 0 } }, h('b', null, why), h('div', { class: 'muted' }, 'Нажмите, чтобы прочитать'));
    box.onclick = (e) => { e.stopPropagation(); box.replaceWith(linkify(c.message)); };
    msg.append(box);
  } else msg.append(linkify(c.message));

  const score = h('span', { class: c.vote_count > 0 ? 'vote-pos' : c.vote_count < 0 ? 'vote-neg' : 'muted3' }, String(c.vote_count ?? 0).replace('-', '–'));
  const minus = h('button', { class: c.vote === 1 ? 'on' : '', title: 'Минус' }, icon('ic_arrow_downward', 'sm'));
  const plus = h('button', { class: c.vote === 2 ? 'on' : '', title: 'Плюс' }, icon('ic_arrow_upward', 'sm'));
  async function vote(v) {
    if (!requireAuth()) return;
    const old = c.vote || 0;
    const voteFn = kind === 'collection' ? A.collectionCommentVote : kind === 'article' ? A.articleCommentVote : A.releaseCommentVote;
    try {
      const r = await voteFn(c.id, v);
      if (r.code === 2) return toast('Вы превысили дневной лимит на отрицательные оценки');
      if (r.code === 3) return toast('Похоже, вы зарегистрировались совсем недавно — Anixart разрешает ставить оценки чуть позже.');
      if (r.code === 402) return toast('Вы не можете голосовать, поскольку ваш аккаунт заблокирован');
      const delta = { '0>2': 1, '0>1': -1, '2>2': -1, '1>1': 1, '1>2': 2, '2>1': -2 }[`${old}>${v}`] || 0;
      c.vote_count = (c.vote_count || 0) + delta;
      c.vote = old === v ? 0 : v;
      score.textContent = String(c.vote_count).replace('-', '–');
      score.className = c.vote_count > 0 ? 'vote-pos' : c.vote_count < 0 ? 'vote-neg' : 'muted3';
      minus.classList.toggle('on', c.vote === 1); plus.classList.toggle('on', c.vote === 2);
    } catch { toast(t('error_load')); }
  }
  minus.onclick = (e) => { e.stopPropagation(); vote(1); };
  plus.onclick = (e) => { e.stopPropagation(); vote(2); };

  let episodeCtx = null;
  if (kind === 'release' && c.posted_at_episode != null && release) {
    if (c.posted_at_episode === 0) episodeCtx = 'На момент анонса';
    else if (c.posted_at_episode > 0 && ((release.status?.id ?? release.status_id) === 2 || c.posted_at_episode !== release.episodes_total)) episodeCtx = `На момент выхода ${c.posted_at_episode} серии`;
  }

  const tools = h('div', { class: 'tools' }, minus, score, plus,
    onReply ? h('button', { onclick: (e) => { e.stopPropagation(); onReply(c); } }, 'Ответить') : null,
    c.reply_count > 0 && !c.is_reply ? h('button', { onclick: (e) => { e.stopPropagation(); navigate('replies', { kind, id: c.id, release }); } }, tp('replies', c.reply_count) !== String(c.reply_count) ? `Показать ${tp('replies', c.reply_count)}` : `Показать ${c.reply_count} ответов`) : null);

  const el = h('div', { class: 'comment', oncontextmenu: (e) => { e.preventDefault(); commentMenu(c, kind, prefix, onChanged); } },
    avatarEl(c.profile),
    h('div', { class: 'body' },
      h('div', { class: 'who' }, profileName(c.profile), h('span', { class: 'when' }, relTime(c.timestamp)), c.is_edited ? icon('ic_pencil', 'xs muted3') : null,
        h('div', { class: 'grow' }),
        iconButton('ic_more', 'Ещё', (e) => { e.stopPropagation(); commentMenu(c, kind, prefix, onChanged); }, 'sm')),
      showTarget && c.release ? h('div', { class: 'linkish', style: { fontSize: '13px' }, onclick: () => openRelease(c.release) }, c.release.title_ru) : null,
      episodeCtx ? h('div', { class: 'muted3', style: { fontSize: '12px' } }, episodeCtx) : null,
      msg,
      compact ? null : tools));
  return el;
}

function commentMenu(c, kind, prefix, onChanged) {
  if (c.is_deleted) return;
  const mine = auth.profileId && c.profile?.id === auth.profileId;
  sheet('Комментарий', [
    { label: 'Скопировать', icon: 'ic_copy', onClick: () => { navigator.clipboard?.writeText(c.message || ''); toast('Скопировано'); } },
    mine ? {
      label: 'Редактировать', icon: 'ic_edit_outline',
      onClick: async () => {
        const text = await prompt('Редактировать', { value: c.message, multiline: true, okLabel: 'Сохранить' });
        if (text == null) return;
        const fn = kind === 'collection' ? (id, b) => A.api?.post(`collection/comment/edit/${id}`, b) : null;
        try {
          const path = `${prefix}/comment/edit/${c.id}`;
          const { api } = await import('../api.js');
          const r = await api.post(path, { message: text, spoiler: !!c.is_spoiler });
          if (r.code === 0) { c.message = text; c.is_edited = true; onChanged && onChanged(); toast('Сохранено'); } else toast(t('error_load'));
          void fn;
        } catch { toast(t('error_load')); }
      },
    } : null,
    mine ? {
      label: 'Удалить', icon: 'ic_trash_outline', danger: true,
      onClick: async () => {
        if (!(await confirmDialog('Удалить комментарий?', 'Это действие нельзя отменить.', 'Удалить'))) return;
        const fn = kind === 'collection' ? A.collectionCommentDelete : kind === 'article' ? A.articleCommentDelete : A.releaseCommentDelete;
        try { const r = await fn(c.id); if (r.code === 0) { c.is_deleted = true; onChanged && onChanged(); toast('Комментарий удалён'); } else toast(t('error_load')); } catch { toast(t('error_load')); }
      },
    } : null,
    !mine ? { label: 'Пожаловаться', icon: 'ic_alert', onClick: () => report(`comment/${prefix}`, c.id) } : null,
  ]);
}

export async function report(kind, entityId) {
  if (!requireAuth()) return;
  const { api } = await import('../api.js');
  let reasons = [];
  try { reasons = await api.get(`report/${kind}/reasons`); } catch { /* ignore */ }
  if (!Array.isArray(reasons)) reasons = [];
  const sel = h('select', { class: 'input' }, h('option', { value: '' }, 'Причина'), reasons.map((r) => h('option', { value: r.id }, r.name)));
  const ta = h('textarea', { class: 'input', rows: 4, placeholder: 'Описание (необязательно)', style: { marginTop: '10px' } });
  dialog({
    title: 'Пожаловаться',
    content: h('div', null, sel, ta),
    actions: [{ label: 'Отмена' }, {
      label: 'Отправить', primary: true,
      onClick: async () => {
        if (!sel.value) { toast('Укажите причину жалобы'); return true; }
        if (ta.value.length > 400) { toast('Описание жалобы слишком длинное, максимум 400 символов'); return true; }
        try {
          const r = await api.post(`report/${kind}`, { entity_id: entityId, reason: Number(sel.value), message: ta.value });
          toast(r.code === 0 ? 'Спасибо! Жалоба отправлена.' : t('error_load'));
        } catch { toast(t('error_load')); }
        return false;
      },
    }],
  });
}

export function linkify(text) {
  const span = h('span');
  const re = /(https?:\/\/[^\s<]+)/g;
  let last = 0; let m;
  const s = String(text ?? '');
  while ((m = re.exec(s))) {
    if (m.index > last) span.append(s.slice(last, m.index));
    span.append(h('a', { href: m[1], target: '_blank', rel: 'noopener', class: 'linkish' }, m[1]));
    last = m.index + m[1].length;
  }
  if (last < s.length) span.append(s.slice(last));
  return span;
}

// Комментарий-композер (5..720 символов)
// top — над списком (страница аниме, «Комментарии»): без прилипания к низу экрана, разделитель снизу
export function commentComposer({ onSend, placeholder = 'Ваш комментарий', top = false }) {
  const ta = h('textarea', { class: 'input', rows: 1, placeholder, maxlength: 720 });
  const spoiler = h('button', { class: 'chip', type: 'button' }, 'Спойлер');
  let isSpoiler = false;
  spoiler.onclick = () => { isSpoiler = !isSpoiler; spoiler.classList.toggle('on', isSpoiler); };
  let reply = null;
  const replyBar = h('div', { class: 'muted', style: { display: 'none', fontSize: '13px', padding: '0 20px' } });
  const send = h('button', { class: 'icon-btn accent', title: 'Отправить' }, icon('ic_send'));
  async function doSend() {
    if (!requireAuth()) return;
    const text = ta.value.trim();
    if (text.length < 5) return toast('Ваш комментарий слишком короткий. Дайте свободу мысли!');
    if (text.length > 720) return toast('Ваш комментарий слишком длинный. Краткость – сестра таланта!');
    send.disabled = true;
    try {
      const ok = await onSend({ message: text, spoiler: isSpoiler, parentCommentId: reply?.parentCommentId ?? null, replyToProfileId: reply?.replyToProfileId ?? null });
      if (ok) { ta.value = ''; isSpoiler = false; spoiler.classList.remove('on'); setReply(null); }
    } finally { send.disabled = false; }
  }
  send.onclick = doSend;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSend(); });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(160, ta.scrollHeight)}px`; });
  function setReply(r, prefixText) {
    reply = r;
    replyBar.style.display = r ? 'block' : 'none';
    replyBar.replaceChildren(r ? h('span', null, `Ответ: ${r.login || ''} `, h('button', { class: 'linkish', onclick: () => setReply(null) }, '✕')) : '');
    if (r && prefixText && !ta.value.startsWith(prefixText)) ta.value = prefixText + ta.value;
    if (r) ta.focus();
  }
  const root = h('div', null, replyBar, h('div', { class: `comment-input ${top ? 'top' : ''}` }, ta, spoiler, send));
  root.setReply = setReply;
  return root;
}

export function collectionCard(c) {
  return h('div', { class: 'release-card', style: { width: '100%' }, onclick: () => navigate('collection', { id: c.id, preload: c }) },
    h('div', { class: 'poster', style: { aspectRatio: '16/9', width: '100%' } }, img(c.image)),
    h('div', { class: 't clamp2' }, c.is_private ? icon('ic_lock', 'xs') : null, ' ', c.title),
    h('div', { class: 'meta row', style: { gap: '10px' } },
      h('span', { class: 'row', style: { gap: '3px' } }, icon('ic_comment_outline', 'xs'), String(c.comment_count ?? 0)),
      h('span', { class: `row ${c.is_favorite ? 'heart' : ''}`, style: { gap: '3px' } }, icon(c.is_favorite ? 'ic_favorite' : 'ic_favorite_border', 'xs'), String(c.favorites_count ?? 0))));
}

// Просмотр картинок (кадры, постер, картинки в ленте): во весь экран, вписано в окно. Несколько — листание стрелками,
// ← → (Home, End), колесом и свайпом, счётчик «3 / 8», лента миниатюр. Клик по картинке — ×2 к месту клика (ещё клик — обратно),
// увеличенное тянется мышью.
// Esc или клик мимо картинки — закрыть. imageViewer(src) — одна картинка; { images, index, title } — несколько.
export function imageViewer(src, { images, index = 0, title = '' } = {}) {
  const list = images && images.length ? images : [src];
  const many = list.length > 1;
  let i = Math.max(0, Math.min(index, list.length - 1));
  let zoom = false; let pan = { x: 0, y: 0 };
  const pic = h('img', { class: 'iv-img', alt: '', referrerpolicy: 'no-referrer', draggable: 'false' });
  const count = h('span', { class: 'iv-count' });
  const btn = (cls, label, ic, fn) => h('button', { class: `iv-btn ${cls}`, title: label, 'aria-label': label, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ic));
  const prev = many ? btn('iv-nav prev', 'Предыдущая (←)', 'ic_chevron_end', () => go(i - 1)) : null;
  const next = many ? btn('iv-nav next', 'Следующая (→)', 'ic_chevron_end', () => go(i + 1)) : null;
  const thumbs = many ? h('div', { class: 'iv-thumbs' }, list.map((s, k) => h('button', {
    class: 'iv-thumb', 'aria-label': `${k + 1} из ${list.length}`, onclick: (e) => { e.stopPropagation(); go(k); },
  }, h('img', { src: s, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })))) : null;
  const stage = h('div', { class: 'iv-stage' }, pic);
  const root = h('div', { class: 'iv', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Просмотр картинки' },
    h('div', { class: 'iv-top' },
      h('div', { class: 'iv-title' }, title ? h('b', null, title) : null, many ? count : null),
      h('a', { class: 'iv-btn', href: list[i], target: '_blank', rel: 'noopener', title: 'Открыть в браузере', 'aria-label': 'Открыть в браузере', onclick: (e) => { e.stopPropagation(); e.currentTarget.href = list[i]; } }, icon('ic_open_in_new')),
      btn('', 'Закрыть (Esc)', 'ic_close', () => close())),
    stage, prev, next, thumbs);

  // вписать в сцену: маленькие кадры (у источника 600px) крупнее, но не больше чем вдвое — дальше слишком мыльно
  function fit() {
    if (!pic.naturalWidth) return;
    const r = stage.getBoundingClientRect(); const cs = getComputedStyle(stage);
    const w = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); const hh = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const k = Math.min(w / pic.naturalWidth, hh / pic.naturalHeight, 2);
    pic.style.width = `${Math.round(pic.naturalWidth * k)}px`; pic.style.height = `${Math.round(pic.naturalHeight * k)}px`;
  }
  pic.addEventListener('load', fit);
  window.addEventListener('resize', fit);
  const paintZoom = () => {
    root.classList.toggle('zoomed', zoom);
    pic.style.transform = zoom ? `translate(${pan.x}px, ${pan.y}px) scale(2)` : '';
  };
  function go(k) {
    if (k < 0 || k >= list.length) return;
    i = k; zoom = false; pan = { x: 0, y: 0 }; paintZoom();
    pic.src = list[i]; // листание — сразу, без анимации: быстро мотать (появление с анимацией — только при открытии)
    count.textContent = `${i + 1} / ${list.length}`;
    if (prev) { prev.disabled = i === 0; next.disabled = i === list.length - 1; }
    if (thumbs) {
      [...thumbs.children].forEach((t, k2) => t.classList.toggle('on', k2 === i));
      thumbs.children[i].scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    for (const d of [-1, 1]) if (list[i + d]) { const pre = new Image(); pre.referrerPolicy = 'no-referrer'; pre.src = list[i + d]; } // соседние — заранее
  }
  function close() {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', fit);
    root.classList.add('closing');
    setTimeout(() => root.remove(), 160);
  }
  // клавиши — раньше остальных (плеер, экраны): ← → листают, Esc закрывает только просмотр
  const onKey = (e) => {
    const k = e.key;
    if (k === 'Escape') close();
    else if (k === 'ArrowLeft') go(i - 1);
    else if (k === 'ArrowRight') go(i + 1);
    else if (k === 'Home') go(0);
    else if (k === 'End') go(list.length - 1);
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);
  // клик мимо картинки — закрыть (по картинке, кнопкам и миниатюрам — нет)
  root.addEventListener('click', (e) => { if (e.target === root || e.target === stage) close(); });
  // колесо — листать, когда не увеличено: щелчок колеса — кадр (не чаще раза в 80 мс), мелкие прокрутки тачпада копятся
  let wheelAt = 0; let wheelAcc = 0;
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (zoom || !many) return;
    wheelAcc += e.deltaY || e.deltaX;
    if (Math.abs(wheelAcc) < 40 || performance.now() - wheelAt < 80) return;
    wheelAt = performance.now(); go(i + (wheelAcc > 0 ? 1 : -1)); wheelAcc = 0;
  }, { passive: false });
  // перетаскивание: увеличенная — двигается, обычная — свайп листает
  let drag = null;
  stage.addEventListener('pointerdown', (e) => { if (e.target !== pic) return; drag = { x: e.clientX, y: e.clientY, pan: { ...pan }, moved: false }; pic.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (zoom) {
      const r = pic.getBoundingClientRect(); const mx = r.width / 4; const my = r.height / 4; // увеличенная вдвое — сдвиг до четверти
      pan = { x: Math.max(-mx, Math.min(mx, drag.pan.x + dx)), y: Math.max(-my, Math.min(my, drag.pan.y + dy)) };
      paintZoom();
    }
  });
  stage.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) toggleZoom(e); // клик (без перетаскивания) — увеличить к месту клика или вернуть
    else if (!zoom && many && Math.abs(dx) > 60) go(i + (dx < 0 ? 1 : -1));
    drag = null;
  });
  // ×2: точка под курсором остаётся под ним (сдвиг — до половины картинки, чтобы край не уходил внутрь)
  function toggleZoom(e) {
    zoom = !zoom;
    if (zoom) {
      const r = pic.getBoundingClientRect();
      const mx = r.width / 2; const my = r.height / 2;
      pan = { x: Math.max(-mx, Math.min(mx, r.left + mx - e.clientX)), y: Math.max(-my, Math.min(my, r.top + my - e.clientY)) };
    } else pan = { x: 0, y: 0 };
    paintZoom();
  }
  document.body.append(root);
  go(i);
  root.querySelector('.iv-top .iv-btn:last-child').focus({ preventScroll: true });
  return { close, go, get index() { return i; } };
}

export const emptyFilter = () => ({
  age_ratings: [], category_id: null, country: null, end_year: null, episode_duration_from: null, episode_duration_to: null,
  episodes_from: null, episodes_to: null, genres: [], genres_mode: null, profile_list_exclusions: [], season: null, sort: 0,
  source: null, start_year: null, status_id: null, studio: null, types: [], is_genres_exclude_mode_enabled: false,
});

// «Ещё» с has-more = content.length >= 25 (страница 0..)
export function hasMore(r) { return (r.content || []).length >= 25; }
