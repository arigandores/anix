// Уведомления: единый список с фильтром (без вкладок)
import { h, icon, actionIcon, iconButton, img, pagedList, emptyView, sheet, dialog, toast, confirmDialog, esc, skeleton, plural } from '../ui.js';
import { api, A, prefetchRead, notifStatusEdit, notifTypeEdit, notifSelectedReleasesToggle, notifReleases, notifReleaseTypes, notifReleaseTypesEdit } from '../api.js';
import { t } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { backToolbar, relTime, releaseRow } from './common.js';
import { typesOf } from './episodes.js';
import { pushSupported, pushOn, pushPermission, askPush, syncPush, openPushSettings } from '../push.js';
import { prefs } from '../store.js';

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

// Телефон: уведомления Anixart не приходят — плашка с тем, как включить (как в Anixart). Нет плашки — всё включено
function pushBanner(repaint) {
  if (!pushSupported() || pushOn()) return null;
  const perm = pushPermission();
  const [sub, label, act] = !prefs.get('PHONE_NOTIFY')
    ? ['Сейчас они выключены в настройках приложения', 'Включить', async () => { prefs.set('PHONE_NOTIFY', true); await askPush(); }]
    : perm === 'ask' ? ['Разрешите приложению их показывать', 'Разрешить', () => askPush()]
      : ['Сейчас они выключены в настройках Android', 'Открыть настройки', () => openPushSettings()];
  return h('div', { class: 'rel-note push-off', style: { margin: '8px var(--card-inset) 0', padding: '14px 16px' } },
    h('div', { class: 'row', style: { gap: '10px' } }, icon('ic_bell'), h('b', null, 'Push-уведомления отключены')),
    h('div', { class: 'muted', style: { marginTop: '4px' } }, `Включите их, чтобы ничего не пропускать. ${sub}.`),
    h('button', { class: 'btn btn-tonal', style: { width: '100%', marginTop: '12px' }, onclick: async () => { await act(); repaint(); } }, label));
}
let pushAsked = false; // за запуск спрашиваем разрешение сами один раз — при первом открытии уведомлений

registerScreen('notifications', (_, ctx) => {
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
      h('div', { class: 'row', style: { padding: '8px var(--gutter)' } },
        h('div', { class: 'grow' }),
        h('button', {
          class: 'chip',
          onclick: () => sheet('Фильтр', FILTERS.map(([v, l]) => ({ label: l, checked: v === filter, onClick: () => { filter = v; build(); } }))),
        }, actionIcon('ic_tune', 'sm'), def[1])),
      list);
  }

  build();
  const banner = h('div');
  const paintBanner = () => banner.replaceChildren(...[pushBanner(paintBanner)].filter(Boolean));
  paintBanner();
  if (!pushAsked && pushSupported() && prefs.get('PHONE_NOTIFY') && pushPermission() === 'ask') { pushAsked = true; askPush().then(paintBanner); }
  ctx.setOnShow?.(() => paintBanner()); // вернулись из настроек Android
  window.addEventListener('focus', paintBanner);
  ctx.setDispose?.(() => window.removeEventListener('focus', paintBanner));
  return h('div', null,
    backToolbar('Уведомления', [
      iconButton('ic_trash_outline', 'Очистить все', async () => {
        if (!(await confirmDialog('Подтверждение', 'Вы уверены, что хотите очистить все уведомления?', 'Очистить'))) return;
        try { await api.get('notification/delete/all'); build(); badgeChanged(); } catch { toast(t('error_load')); }
      }),
      iconButton('ic_settings', 'Настройки уведомлений', () => navigate('notification-settings')),
    ]),
    banner,
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

// Списки для уведомлений о сериях (profile_lists: 0 — избранное, 1–5 — статусы)
const LISTS = ['Избранное', 'Смотрю', 'В планах', 'Просмотрено', 'Отложено', 'Брошено'];
// Статус в ответе — перечисление ProfileStatusNotificationPreference.Status: числом (оно же порядковый номер) или именем
const STATUS_ENUM = ['FAVORITE_STATUS', 'STATUS_WATCHING', 'STATUS_PLAN', 'STATUS_COMPLETED', 'STATUS_HOLD_ON', 'STATUS_DROPPED'];
const statusOf = (x) => {
  const s = x && typeof x === 'object' ? x.status : x;
  const v = s && typeof s === 'object' ? s.value : s;
  return typeof v === 'number' ? v : STATUS_ENUM.indexOf(v);
};
// озвучка в ответе — { type: { id, name } } (ProfileTypeNotificationPreference), на всякий случай и просто id
const typeIdOf = (x) => (x && typeof x === 'object' ? (x.type?.id ?? x.id) : x);
const EP_MODES = [['all', 'Из всех моих списков'], ['some', 'Из выбранных списков…'], ['releases', 'По выбранным релизам']];

// Диалог с галочками («Выберите списки»): выбранные номера по порядку или null (отмена)
function checkDialog(title, labels, selected, emptyText) {
  return new Promise((resolve) => {
    const on = new Set(selected);
    const box = h('div', { class: 'pick-list' }, labels.map((l, i) => {
      const cb = h('input', { type: 'checkbox' }); cb.checked = on.has(i);
      cb.onchange = () => { if (cb.checked) on.add(i); else on.delete(i); };
      return h('label', { class: 'sheet-item' }, cb, l);
    }));
    let done = false;
    dialog({
      title, content: box,
      actions: [{ label: 'Отмена' }, {
        label: 'Выбрать', primary: true,
        onClick: () => { if (!on.size) { toast(emptyText); return true; } done = true; resolve([...on].sort((a, b) => a - b)); },
      }],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

// Выбор озвучек (ChooseTypeDialogFragment): «От всех», «От выбранных…» (список галочек), у релиза ещё «Не получать».
// Возвращает id озвучек или null (отмена)
function chooseTypes(title, types, selected, { nothing = false } = {}) {
  return new Promise((resolve) => {
    const on = new Set(selected);
    let mode = nothing && !on.size ? 'none' : types.length && types.every((ty) => on.has(ty.id)) ? 'all' : 'some';
    const boxes = types.map((ty) => {
      const cb = h('input', { type: 'checkbox' }); cb.checked = on.has(ty.id);
      cb.onchange = () => { if (cb.checked) on.add(ty.id); else on.delete(ty.id); mode = 'some'; paint(); };
      return { id: ty.id, cb, el: h('label', { class: 'sheet-item' }, cb, ty.name) };
    });
    const modes = [['all', 'От всех озвучек'], ['some', 'От выбранных озвучек…'], nothing ? ['none', 'Не получать'] : null].filter(Boolean);
    const opts = h('div', { class: 'pick-list' });
    const scroll = types.length
      ? h('div', { class: 'pick-list scroll' }, boxes.map((b) => b.el))
      : h('div', { class: 'muted', style: { padding: '8px 0' } }, 'У релиза пока нет озвучек');
    const pick = (v) => {
      mode = v;
      if (v !== 'some') for (const b of boxes) { b.cb.checked = v === 'all'; if (v === 'all') on.add(b.id); else on.delete(b.id); }
      paint();
    };
    // список галочек — только для «От выбранных»: при «всех» и «не получать» он ничего не добавляет
    function paint() {
      opts.replaceChildren(...modes.map(([v, l]) => h('button', { class: `sheet-item ${mode === v ? 'checked' : ''}`, onclick: () => pick(v) },
        h('span', null, l), mode === v ? icon('ic_check', 'end') : null)));
      scroll.style.display = mode === 'some' ? '' : 'none';
    }
    paint();
    let done = false;
    dialog({
      title, content: h('div', null, opts, scroll),
      actions: [{ label: 'Отмена' }, {
        label: 'Сохранить', primary: true,
        onClick: () => {
          if (mode === 'some' && !on.size && !nothing) { toast('Вы не выбрали ни одного варианта'); return true; }
          done = true;
          resolve(mode === 'none' ? [] : mode === 'all' ? types.map((ty) => ty.id) : [...on]);
        },
      }],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

// Откуда присылать уведомления о сериях (NotificationsPreferenceFragment): из всех списков, из выбранных или только по
// выбранным релизам, и от каких озвучек. В режиме «По выбранным релизам» озвучки и «только одно уведомление» задаются
// у каждого релиза отдельно — эти пункты неактивны, а активен переход к релизам
function episodeFilters(my, allTypes, firstRow) {
  const st = {
    statuses: new Set((my.profileStatusNotificationPreferences || my.profile_status_notification_preferences || []).map(statusOf).filter((v) => v >= 0)),
    types: new Set((my.profileTypeNotificationPreferences || my.profile_type_notification_preferences || []).map(typeIdOf)),
    byRelease: !!my.is_release_type_notifications_enabled,
  };
  const mode = () => (st.byRelease ? 'releases' : st.statuses.size === LISTS.length ? 'all' : 'some');
  const row = (ic, title, sub, onClick) => h('div', { class: 'menu-item', onclick: onClick }, icon(ic), h('div', { class: 'grow' }, h('div', null, title), sub));
  const modeSub = h('div', { class: 'sub' }); const listsSub = h('div', { class: 'sub' }); const typesSub = h('div', { class: 'sub' });
  const modeRow = row('ic_bookmarks', 'Уведомления о новых сериях', modeSub,
    () => sheet('Уведомления о новых сериях', EP_MODES.map(([v, l]) => ({ label: l, checked: v === mode(), onClick: () => pickMode(v) }))));
  const listsRow = row('ic_checklist', 'Уведомления из списков', listsSub, () => chooseLists());
  const typesRow = row('ic_voice', 'Уведомления от озвучек', typesSub, () => chooseAllTypes());
  const releasesRow = row('ic_tune', 'Настроить уведомления по отдельным релизам', h('div', { class: 'sub' }, 'Свои озвучки для каждого релиза'),
    () => navigate('notification-releases'));

  function paint() {
    const m = mode();
    modeSub.textContent = EP_MODES.find((x) => x[0] === m)[1];
    listsRow.style.display = m === 'some' ? '' : 'none';
    listsSub.textContent = [...st.statuses].sort((a, b) => a - b).map((i) => LISTS[i]).join(', ') || 'Ни одного списка';
    const names = allTypes.filter((ty) => st.types.has(ty.id)).map((ty) => ty.name);
    typesSub.textContent = !allTypes.length ? 'Список озвучек не загрузился'
      : names.length === allTypes.length ? 'От всех озвучек'
        : !names.length ? 'Не выбрано ни одной озвучки'
          : names.length > 3 ? `${names.slice(0, 3).join(', ')} и ещё ${names.length - 3}` : names.join(', ');
    typesRow.classList.toggle('off', st.byRelease || !allTypes.length);
    firstRow.classList.toggle('off', st.byRelease);
    releasesRow.classList.toggle('off', !st.byRelease);
  }
  // как l1II11lIll в Anixart: сначала режим «по релизам» (GET-переключатель — только если он меняется), затем списки
  async function apply(statuses, byRelease) {
    try {
      if (st.byRelease !== byRelease) {
        const r = await notifSelectedReleasesToggle(); if (r.code !== 0) throw new Error();
        st.byRelease = byRelease;
      }
      if (statuses) {
        const r = await notifStatusEdit(statuses); if (r.code !== 0) throw new Error();
        st.statuses = new Set(statuses);
      }
    } catch { toast(t('error_load')); }
    paint();
  }
  function pickMode(v) {
    if (v === 'all') apply(LISTS.map((_, i) => i), false);
    else if (v === 'releases') apply(null, true);
    else chooseLists();
  }
  async function chooseLists() {
    // как в Anixart: из «всех списков» выбор начинается с пустого
    const picked = await checkDialog('Выберите списки', LISTS, st.statuses.size === LISTS.length ? [] : [...st.statuses], 'Вы не выбрали ни одного варианта');
    if (picked) apply(picked, false);
  }
  async function chooseAllTypes() {
    const picked = await chooseTypes('Уведомления от озвучек', allTypes, st.types);
    if (!picked) return;
    try { const r = await notifTypeEdit(picked); if (r.code !== 0) throw new Error(); st.types = new Set(picked); } catch { toast(t('error_load')); }
    paint();
  }
  paint();
  return [modeRow, listsRow, typesRow, releasesRow];
}

registerScreen('notification-settings', async () => {
  const root = h('div', null, backToolbar('Уведомления'));
  // справочник озвучек (TypeApi) — как в Anixart, вместе с настройками; не загрузился — пункт озвучек неактивен
  const [my, allTypes] = await Promise.all([api.get('profile/preference/notification/my'), A.types_all().then((r) => r.types || []).catch(() => [])]);
  const list = h('div', { class: 'menu-list', style: { maxWidth: '760px' } });
  if (pushSupported()) { // телефон: присылать ли уведомления системными (NotifyJob.kt)
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!prefs.get('PHONE_NOTIFY');
    cb.onchange = async () => {
      prefs.set('PHONE_NOTIFY', cb.checked);
      if (!cb.checked) { syncPush(); return; }
      if (!(await askPush()) && pushPermission() !== 'ask') { toast('Уведомления выключены в настройках Android'); openPushSettings(); }
    };
    list.append(h('label', { class: 'menu-item' }, icon('ic_bell'), h('div', { class: 'grow' }, h('div', null, 'Уведомления на телефоне'),
      h('div', { class: 'sub' }, 'Новые серии, ответы и друзья — уведомлениями телефона, даже когда приложение закрыто')), h('span', { class: 'switch' }, cb, h('span'))));
  }
  const rows = NOTIF_PREFS.map(([key, label, path]) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = !!my[key];
    cb.onchange = async () => {
      try { const r = await api.get(path); if (r.code !== 0) throw new Error(); } catch { cb.checked = !cb.checked; toast(t('error_load')); }
    };
    return h('label', { class: 'menu-item' }, icon('ic_bell'), h('div', { class: 'grow' }, label), h('span', { class: 'switch' }, cb, h('span')));
  });
  // как в Anixart: «О выходе новых серий», откуда и от каких озвучек, затем «Получать только одно уведомление»
  list.append(rows[0], ...episodeFilters(my, allTypes, rows[1]), ...rows.slice(1));
  root.append(list);
  return root;
}, () => [backToolbar('Уведомления'), skeleton('switches', NOTIF_PREFS.length + 3)]);

// Количество выбранных озвучек у релиза (plurals release_types)
const typesCount = (n) => (n ? `${plural(n, 'Выбрана', 'Выбрано', 'Выбрано')} ${n} ${plural(n, 'озвучка', 'озвучки', 'озвучек')}` : 'Не выбрано ни одной озвучки');

// Строка релиза с озвучками для уведомлений (ReleaseNotificationPreferenceModel): обычная строка списка, снизу — сколько
// выбрано и «Выбрать озвучки». В выборе — озвучки этого релиза (как на экране серий) и уже включённые, которых у
// релиза больше нет, — чтобы их можно было снять
function releaseTypesRow(rel) {
  const row = releaseRow(rel);
  const count = h('span', { class: 'muted grow' }, typesCount(rel.profile_release_type_notification_preference_count || 0));
  const btn = h('button', {
    class: 'btn btn-tonal',
    onclick: async (e) => {
      e.stopPropagation();
      try {
        const [types, cur] = await Promise.all([typesOf(rel.id), notifReleaseTypes(rel.id)]);
        const sel = (cur.profile_release_type_notification_preferences || []).map(typeIdOf);
        let list = types;
        const gone = sel.filter((id) => !types.some((ty) => ty.id === id));
        if (gone.length) list = list.concat(((await A.types_all()).types || []).filter((ty) => gone.includes(ty.id)));
        const picked = await chooseTypes(rel.title_ru || rel.title_original || t('unnamed'), list, sel, { nothing: true });
        if (!picked) return;
        const r = await notifReleaseTypesEdit(rel.id, picked); if (r.code !== 0) throw new Error();
        rel.profile_release_type_notification_preference_count = picked.length;
        count.textContent = typesCount(picked.length);
      } catch { toast(t('error_load')); }
    },
  }, 'Выбрать озвучки');
  row.querySelector('.info')?.append(h('div', { class: 'row', style: { marginTop: '8px', gap: '12px' } }, count, btn));
  return row;
}

// Уведомления по отдельным релизам (ProfileReleaseNotificationPreferencesFragment) — для режима «По выбранным релизам»
registerScreen('notification-releases', () => h('div', null,
  backToolbar('Уведомления по релизам'),
  pagedList({ load: (page) => notifReleases(page), render: releaseTypesRow, empty: () => emptyView('Релизов нет') })));
