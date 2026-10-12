// Релиз, связанные, коллекции релиза, видео, онлайн-платформы
import { h, icon, iconButton, img, toast, dialog, sheet, pagedList, emptyView, spinner, skeleton, skLine, skParts, errorView } from '../ui.js';
import { A, api, auth, takePrefetchedRelease } from '../api.js';
import { t, tp, prefs } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import {
  gradeText, digits, seasonName, LIST_NAMES, chooseListStatus, toggleFavorite, requireAuth, commentItem, commentComposer,
  openRelease, imageViewer, report, backToolbar, sectionHead, collectionCard, relTime, releaseRow,
} from './common.js';

const AGE = ['', '0+', '6+', '12+', '16+', '18+'];
const BROADCAST = ['', 'каждый понедельник', 'каждый вторник', 'каждую среду', 'каждый четверг', 'каждую пятницу', 'каждую субботу', 'каждое воскресенье'];
const STAR_LABELS = ['', 'Ужасно', 'Плохо', 'Нормально', 'Хорошо', 'Отлично'];
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function bigGrade(g) {
  const v = Math.trunc(Number(g) * 100) / 100;
  const s = String(v).replace(/\.?0+$/, '');
  const [a, b = ''] = s.split('.');
  return h('span', null, a, b ? `.${b[0]}` : '', b[1] ? h('span', { style: { fontSize: '0.7em' } }, b[1]) : '');
}

function linkJoin(prefix, value, searchBy) {
  if (!value) return null;
  const parts = String(value).split(', ').filter(Boolean);
  const out = [prefix ? `${prefix} ` : ''];
  parts.forEach((p, i) => {
    if (i) out.push(', ');
    out.push(h('a', { onclick: () => navigate('search', { query: p, searchBy }) }, p));
  });
  return out;
}

// Пока грузится release/{id}: шапка из данных карточки списка,
// остальное — скелетоны в той же раскладке, чтобы страница не прыгала.
function previewPage(p) {
  const title = p && (p.title_ru || p.title_original);
  const sk = (style) => h('div', { class: 'sk', style });
  return [
    h('div', { class: 'rel-hero' },
      p?.image ? h('div', { class: 'bg', style: { backgroundImage: `url("${p.image}")` } }) : null,
      h('div', { class: 'inner' },
        h('div', { class: `poster ${p?.image ? '' : 'sk'}` }, p?.image ? img(p.image) : null),
        h('div', { class: 'head' },
          title ? h('h1', { class: 'rel-title' }, title) : skLine('55%', 'big'),
          p?.title_ru && p?.title_original ? h('div', { class: 'rel-orig' }, p.title_original) : skLine('35%'),
          h('div', { class: 'row', style: { gap: '6px', marginTop: '4px' } }, sk({ width: '42px', height: '22px' }), sk({ width: '96px', height: '22px' })),
          p?.note ? h('div', { class: 'rel-note', html: p.note, style: noteStyle(p) }) : null,
          h('div', { class: 'rel-actions' }, sk({ width: '150px', height: '40px', borderRadius: '20px' }), sk({ width: '84px', height: '40px', borderRadius: '20px' }), sk({ width: '84px', height: '40px', borderRadius: '20px' })),
          h('div', { style: { marginTop: '14px' } }, sk({ width: '100%', height: '48px', borderRadius: '24px' }))))),
    h('div', { class: 'rel-body skeleton' },
      h('div', null, h('div', { class: 'card' },
        h('div', { class: 'info-rows' }, ['48%', '30%', '42%', '56%', '64%'].map((w) => h('div', { class: 'info-row' }, sk({ width: '20px', height: '20px', borderRadius: '50%', flex: 'none' }), skLine(w)))),
        h('div', { style: { marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '9px' } }, ['98%', '94%', '97%', '90%', '60%'].map((w) => skLine(w))))),
      h('div', null, h('div', { class: 'card' }, skLine('40%', 'title'), sk({ height: '96px', borderRadius: '12px', marginTop: '14px' })),
        h('div', { class: 'card' }, skLine('55%', 'title'), sk({ height: '10px', borderRadius: '5px', marginTop: '14px' }), h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '14px' } }, ['70%', '62%', '74%', '58%', '66%'].map((w) => skLine(w)))))),
  ];
}

registerScreen('release', ({ id, random, profileId, status, collectionId, preload }, ctx) => {
  const root = h('div', null);
  let rel;
  // 18+ без подтверждения возраста — без постера и названия до экрана предупреждения
  let usePreload = !random && preload && !(preload.age_rating === 5 && !prefs.get('IS_ADULT')) ? preload : null;
  async function fetchRelease() {
    let r;
    if (random === 1) r = await A.random(true);
    else if (random === 2) r = await A.randomProfileList(profileId, status, true);
    else if (random === 3) r = await A.randomFavorite(true);
    else if (random === 4) r = await A.randomCollection(collectionId, true);
    else r = await (takePrefetchedRelease(id) || A.release(id, true));
    return r;
  }
  async function render() {
    root.replaceChildren(backToolbar(''), ...previewPage(usePreload));
    usePreload = null; // «Случайный» и повторная загрузка — без старых данных
    let r;
    try { r = await fetchRelease(); } catch (e) { root.replaceChildren(backToolbar(''), errorView(e, render)); return; }
    rel = r.release;
    if (!rel || r.code !== 0 || rel.is_deleted) {
      root.replaceChildren(backToolbar(''), h('div', { class: 'empty' }, icon('ic_error', 'big'),
        h('div', { class: 'empty-title' }, 'Страница не найдена'), h('div', { class: 'empty-sub' }, 'Возможно, она была удалена и больше недоступна'),
        h('button', { class: 'btn btn-tonal', onclick: () => history.back() }, 'Назад')));
      return;
    }
    if (rel.age_rating === 5 && !prefs.get('IS_ADULT')) {
      root.replaceChildren(backToolbar(''), h('div', { class: 'empty' }, h('div', { class: 'empty-title' }, 'Возрастное ограничение'),
        h('div', { class: 'empty-sub' }, 'Для просмотра подтвердите, что Вам уже исполнилось 18 лет'),
        h('div', { class: 'row' }, h('button', { class: 'btn btn-tonal', onclick: () => history.back() }, 'Назад'),
          h('button', { class: 'btn btn-primary', onclick: () => { prefs.set('IS_ADULT', true); build(); } }, 'Да, мне есть 18')),
        h('div', { class: 'muted3', style: { fontSize: '12px', marginTop: '8px' } }, 'При нажатии на кнопку «Подтвердить» данное сообщение больше показываться не будет.')));
      return;
    }
    build();
  }

  function build() {
    const title = rel.title_ru || rel.title_original || t('unnamed');
    const sub = rel.title_ru && rel.title_original ? rel.title_original : '';
    const toolbar = backToolbar(title, [
      random ? iconButton('ic_shuffle', t('label_random'), () => render()) : null,
      iconButton('ic_bell', 'Уведомления о новых сериях', () => typeNotifications(rel)),
      iconButton('ic_more', 'Ещё', () => moreSheet(rel)),
    ]);
    toolbar.querySelector('.title').style.opacity = '0';
    ctx.entry.node.closest('#viewport')?.addEventListener('scroll', function onS(e) {
      if (!toolbar.isConnected) { e.currentTarget.removeEventListener('scroll', onS); return; }
      toolbar.querySelector('.title').style.opacity = e.currentTarget.scrollTop > 240 ? '1' : '0';
    });

    // --- Панель: список / избранное / комментарии ---
    const listBtn = h('button', { class: 'btn list-btn' });
    const favBtn = h('button', { class: 'btn list-btn' });
    const paintPanel = () => {
      const s = rel.profile_list_status || 0;
      listBtn.replaceChildren(icon('ic_arrow_drop_down', 'sm'), t(LIST_NAMES[s]));
      // button_tag_{color}: цвет по статусу; 0 «Не смотрю» — обычная серая кнопка
      listBtn.className = `btn list-btn ${s ? `tag tag-${s}` : ''}`;
      favBtn.className = `btn list-btn ${rel.is_favorite ? 'tag tag-fav' : ''}`;
      favBtn.replaceChildren(icon(rel.is_favorite ? 'ic_favorite' : 'ic_favorite_border', 'sm'), digits(rel.favorites_count));
    };
    listBtn.onclick = () => chooseListStatus(rel, paintPanel);
    favBtn.onclick = () => toggleFavorite(rel, paintPanel);
    paintPanel();

    // --- Кнопка просмотра ---
    const st = rel.status?.id ?? rel.status_id;
    let watch;
    if (rel.is_view_blocked) watch = h('div', { class: 'muted' }, 'Недоступно в вашей стране');
    else if (rel.is_play_disabled) watch = h('div', { class: 'muted' }, 'Недоступно');
    else if (st === 3 && !rel.episodes_released) watch = h('div', { class: 'rel-note' }, rel.aired_on_date ? `Анонс: ${new Date(rel.aired_on_date * 1000).toLocaleDateString('ru-RU')}` : 'Анонс');
    else {
      watch = h('div', { class: 'col', style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('button', { class: 'btn btn-primary lg btn-watch', onclick: () => openWatch(rel) }, icon('ic_play'), 'Воспроизвести'),
        rel.episode_last_update ? h('div', { class: 'muted', style: { fontSize: '13px' } }, `Добавлено: ${rel.episode_last_update.last_episode_update_name || rel.episode_last_update.episode_name || 'неизвестная серия'} | ${rel.episode_last_update.lastEpisodeTypeUpdateName || rel.episode_last_update.last_episode_type_update_name || ''} | ${rel.episode_last_update.last_episode_source_update_name || ''}`) : null);
    }

    const hero = h('div', { class: 'rel-hero' },
      h('div', { class: 'bg', style: { backgroundImage: `url("${rel.image}")` } }),
      h('div', { class: 'inner' },
        h('div', { class: 'poster', onclick: () => imageViewer(rel.image) }, img(rel.image)),
        h('div', { class: 'head' },
          h('h1', { class: 'rel-title' }, title),
          sub ? h('div', { class: 'rel-orig' }, sub) : null,
          h('div', { class: 'row', style: { gap: '6px', marginTop: '4px', flexWrap: 'wrap' } },
            rel.age_rating > 0 ? h('button', { class: 'badge', onclick: () => dialog({ title: t('information'), content: h('p', { style: { whiteSpace: 'pre-line' } }, t('age_rating_info')), actions: [{ label: t('close'), primary: true }] }) }, AGE[rel.age_rating]) : null,
            rel.title_alt || rel.title_original ? h('button', { class: 'badge', onclick: () => titleInfo(rel) }, icon('ic_info_outline', 'xs'), 'Названия') : null),
          rel.note ? h('div', { class: 'rel-note', html: rel.note, style: noteStyle(rel) }) : null,
          h('div', { class: 'rel-actions' }, listBtn, favBtn,
            h('button', { class: 'btn list-btn', onclick: () => navigate('comments', { kind: 'release', id: rel.id, release: rel }) }, icon('ic_comment_outline', 'sm'), digits(rel.comment_count ?? rel.comments_count ?? 0))),
          h('div', { style: { marginTop: '14px' } }, watch))));

    // --- Информация ---
    const infoRows = [];
    const countryParts = [rel.country, [seasonName(rel.season), rel.year ? `${rel.year} г.` : ''].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (countryParts) infoRows.push(['ic_flag_' + (rel.country === 'Япония' ? 'japan' : rel.country === 'Китай' ? 'chinese' : 'unknown'), cap(countryParts), true]);
    const R = rel.episodes_released; const T = rel.episodes_total;
    if (R || T || rel.duration) {
      let e = R != null && R === T ? `${R} эп.` : R != null && T != null ? `${R} из ${T} эп.` : R != null ? `${R} из ? эп.` : T != null ? `? из ${T} эп.` : '? эп.';
      if (rel.duration > 0) e += ` по ~${rel.duration} мин.`;
      infoRows.push(['ic_episodes', e]);
    }
    if (rel.category || rel.status) {
      let s = [rel.category?.name?.toLowerCase(), rel.status?.name?.toLowerCase()].filter(Boolean).join(', ');
      if (st === 2 && rel.broadcast >= 1 && rel.broadcast <= 7) s += ` ${BROADCAST[rel.broadcast]}`;
      infoRows.push(['ic_schedule', cap(s)]);
    }
    const studioParts = [linkJoin('студия', rel.studio, 1), linkJoin('автор', rel.author, 3), linkJoin('режиссёр', rel.director, 2)].filter(Boolean);
    if (studioParts.length) {
      const span = h('span');
      studioParts.forEach((p, i) => { if (i) span.append(', '); span.append(...p); });
      infoRows.push(['ic_studio', span]);
    }
    if (rel.source) infoRows.push(['ic_source', h('span', null, 'Первоисточник ', rel.source)]);
    if (rel.genres) infoRows.push(['ic_tune_variant', h('span', null, ...linkJoin('', rel.genres, 4))]);
    if (rel.translators) infoRows.push(['ic_voice', rel.translators]);
    if (rel.release_date) infoRows.push(['ic_calendar', rel.release_date]);

    const desc = h('div', { class: 'desc-text collapsed' }, rel.description || t('description_not_specified'));
    const descToggle = h('button', { class: 'btn btn-text', style: { paddingLeft: 0 } }, 'Подробнее…');
    descToggle.onclick = () => { const c = desc.classList.toggle('collapsed'); descToggle.textContent = c ? 'Подробнее…' : 'Скрыть'; };

    const left = h('div', null,
      h('div', { class: 'card' },
        h('div', { class: 'info-rows' }, infoRows.map(([ic, txt, raw]) => h('div', { class: 'info-row' }, raw ? h('img', { src: `/icons/${ic}.svg`, style: { width: '20px', height: '20px' } }) : icon(ic), h('div', null, txt)))),
        h('div', { style: { marginTop: '14px' } }, desc, (rel.description || '').length > 300 ? descToggle : null)),
      videoBanners(rel),
      screenshots(rel),
      relatedBlock(rel),
      recommendedBlock(rel),
      commentsBlock(rel, () => build()));
    const right = h('div', null, ratingBlock(rel), statsBlock(rel), collectionsBlock(rel));

    root.replaceChildren(toolbar, hero, h('div', { class: 'rel-body' }, left, right));
  }

  render();
  return root;
});

function noteStyle(rel) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const bg = dark ? rel.note_background_color_dark : rel.note_background_color_light;
  const fg = dark ? rel.note_text_color_dark : rel.note_text_color_light;
  return { background: bg || '', color: fg || '' };
}

function titleInfo(rel) {
  const row = (label, val) => (val ? h('div', { class: 'menu-item', style: { padding: '10px 0' }, onclick: () => { navigator.clipboard?.writeText(val); toast('Скопировано'); } },
    h('div', { class: 'grow' }, h('div', { class: 'sub' }, label), h('div', { style: { whiteSpace: 'pre-line' } }, val)), icon('ic_copy')) : null);
  dialog({ title: 'Названия', content: h('div', null, row('Название', rel.title_ru), row('Оригинальное название', rel.title_original), row('Альтернативные названия', rel.title_alt)), actions: [{ label: t('close') }] });
}

function moreSheet(rel) {
  const base = (window.__toggles && window.__toggles.baseUrl) || 'https://anixart-app.com/';
  const link = `${base}release/${rel.id}`;
  sheet(null, [
    { label: 'Онлайн просмотр', icon: 'ic_streaming_platform', onClick: () => navigate('streaming', { release: rel }) },
    { label: 'Поделиться', icon: 'ic_export_variant', onClick: () => { const text = `${rel.title_ru}\n${link}`; if (navigator.share) navigator.share({ text }).catch(() => {}); else { navigator.clipboard?.writeText(text); toast('Скопировано'); } } },
    { label: 'Скопировать ссылку', icon: 'ic_link', onClick: () => { navigator.clipboard?.writeText(link); toast('Скопировано'); } },
    { label: 'Пожаловаться', icon: 'ic_alert', onClick: () => report('release', rel.id) },
  ]);
}

async function typeNotifications(rel) {
  if (!requireAuth()) return;
  try {
    const [types, cur] = await Promise.all([A.types_all(), api.get(`profile/preference/notification/release/type/${rel.id}`)]);
    const all = types.types || [];
    const selected = new Set((cur.profile_release_type_notification_preferences || cur.types || []).map((x) => (typeof x === 'object' ? x.id : x)));
    const box = h('div', { class: 'sheet-list' }, all.map((ty) => {
      const cb = h('input', { type: 'checkbox' }); cb.checked = selected.has(ty.id);
      cb.onchange = () => { if (cb.checked) selected.add(ty.id); else selected.delete(ty.id); };
      return h('label', { class: 'sheet-item', style: { cursor: 'pointer' } }, cb, ty.name);
    }));
    dialog({
      title: 'Уведомления о новых сериях', content: box,
      actions: [{ label: 'Отмена' }, {
        label: 'Сохранить', primary: true,
        onClick: async () => {
          await api.post('profile/preference/notification/release/type/edit', { release_id: rel.id, profile_release_type_notification_preferences: [...selected] });
          toast(selected.size ? 'Уведомления о новых сериях включены' : 'Уведомления о новых сериях отключены');
        },
      }],
    });
  } catch { toast(t('error_load')); }
}

function ratingBlock(rel) {
  const st = rel.status?.id ?? rel.status_id;
  if (st === 3) return null;
  const card = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Рейтинг'));
  if (!(rel.vote_count > 50)) card.append(h('div', { class: 'muted' }, 'Недостаточно голосов для отображения рейтинга'));
  else {
    const sum = [1, 2, 3, 4, 5].reduce((a, i) => a + (rel[`vote_${i}_count`] || 0), 0) || 1;
    card.append(h('div', { class: 'rating-box' },
      h('div', null, h('div', { class: 'rating-big' }, bigGrade(rel.grade)), h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '4px' } }, `${digits(rel.vote_count)} ${tp('votes', rel.vote_count)}`)),
      h('div', { class: 'rating-bars' }, [5, 4, 3, 2, 1].map((i) => h('div', { class: 'rating-bar' }, h('span', null, String(i)),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${((rel[`vote_${i}_count`] || 0) * 100) / sum}%` } })))))));
  }
  if (auth.loggedIn) {
    const zone = h('div', { style: { marginTop: '14px' } });
    const paint = () => {
      zone.replaceChildren();
      if (rel.your_vote) {
        zone.append(h('div', { class: 'row' },
          h('div', { class: 'stars' }, [1, 2, 3, 4, 5].map((i) => h('span', { class: i <= rel.your_vote ? 'on' : '', style: { color: i <= rel.your_vote ? 'var(--orange)' : 'var(--text4)' } }, icon('ic_star_rate')))),
          h('div', { class: 'grow' }, h('div', null, `${rel.your_vote} из 5`), h('div', { class: 'muted', style: { fontSize: '12px' } }, 'Вы проголосовали')),
          h('button', { class: 'btn btn-text', onclick: async () => { try { const r = await A.deleteVote(rel.id); if (r.code !== 0) throw 0; rel.your_vote = null; paint(); } catch { toast('Произошла ошибка при удалении голоса.'); } } }, 'Изменить')));
      } else {
        zone.append(h('div', { class: 'stars' }, [1, 2, 3, 4, 5].map((i) => h('button', { title: STAR_LABELS[i], onclick: () => confirmVote(i) }, icon('ic_star_rate')))));
      }
    };
    const confirmVote = (n) => dialog({
      title: STAR_LABELS[n], content: h('div', { class: 'stars' }, [1, 2, 3, 4, 5].map((i) => h('span', { style: { color: i <= n ? 'var(--orange)' : 'var(--text4)' } }, icon('ic_star_rate')))),
      actions: [{ label: 'Отмена' }, {
        label: 'Отправить', primary: true,
        onClick: async () => {
          try {
            const r = await A.vote(rel.id, n); if (r.code !== 0) throw 0;
            rel.your_vote = n; paint();
            afterVote(rel);
          } catch { toast('Произошла ошибка при отправке голоса.'); }
        },
      }],
    });
    paint();
    card.append(zone);
  }
  return card;
}

function afterVote(rel) {
  const ta = h('textarea', { class: 'input', rows: 4, placeholder: 'Ваш комментарий' });
  const sp = h('input', { type: 'checkbox' });
  dialog({
    title: 'Оценка принята',
    content: h('div', null, h('p', null, 'Поделись впечатлениями — что понравилось, а что разочаровало'), ta, h('label', { class: 'row', style: { marginTop: '10px' } }, sp, 'Содержит спойлер')),
    actions: [{ label: 'Нет, спасибо' }, {
      label: 'Отправить', primary: true,
      onClick: async () => {
        const m = ta.value.trim();
        if (m.length < 5) { toast('Ваш комментарий слишком короткий. Дайте свободу мысли!'); return true; }
        if (m.length > 720) { toast('Ваш комментарий слишком длинный. Краткость – сестра таланта!'); return true; }
        const r = await A.releaseCommentAdd(rel.id, { parentCommentId: null, replyToProfileId: null, message: m, spoiler: sp.checked });
        toast(r.code === 0 ? 'Комментарий отправлен' : commentAddError(r.code));
        return false;
      },
    }],
  });
}

export function commentAddError(code) {
  return ({
    2: 'Вы не можете комментировать этот релиз, поскольку он был удалён.',
    5: 'Ваш комментарий слишком короткий. Дайте свободу мысли!',
    6: 'Ваш комментарий слишком длинный. Краткость – сестра таланта!',
    7: 'Вы превысили допустимый лимит по комментариям за сутки. Попробуйте оставить комментарий позже.',
    8: 'Пользователь внёс Вас в свой блоклист. Вы не можете отвечать на его комментарии.',
    402: 'Вы не можете оставлять комментарии в связи с нарушением правил. Подробную информацию вы можете найти на странице своего профиля.',
  })[code] || t('error_load');
}

function statsBlock(rel) {
  const st = rel.status?.id ?? rel.status_id;
  const card = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'В списках у людей'));
  if (st === 3) {
    card.append(h('div', null, `${digits(rel.plan_count)} ${tp('users', rel.plan_count, '').trim() || 'пользователей'} ${tp('planning', rel.plan_count, '').trim() || 'планируют'}`), h('div', { class: 'muted' }, 'смотреть этот релиз'));
    return card;
  }
  const rows = [['list_watching', rel.watching_count, 'green'], ['list_plan', rel.plan_count, 'purple'], ['list_completed', rel.completed_count, 'blue'], ['list_hold_on', rel.hold_on_count, 'yellow'], ['list_dropped', rel.dropped_count, 'red']];
  const total = rows.reduce((a, r) => a + (r[1] || 0), 0) || 1;
  card.append(h('div', { class: 'progress-multi' }, rows.map(([, n, c]) => h('div', { style: { width: `${((n || 0) * 100) / total}%`, background: `var(--${c})` } }))));
  card.append(h('div', { class: 'info-rows' }, rows.map(([k, n, c]) => h('div', { class: 'row' }, h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: `var(--${c})` } }), h('span', { class: 'grow' }, t(k)), h('b', null, digits(n))))));
  return card;
}

function collectionsBlock(rel) {
  return h('div', { class: 'card' },
    h('div', { class: 'menu-item', style: { padding: '8px 0' }, onclick: () => navigate('release-collections', { release: rel }) },
      icon('ic_collection'), h('div', { class: 'grow' }, 'Показать в коллекциях'), rel.collection_count > 0 ? h('span', { class: 'badge' }, digits(rel.collection_count)) : null),
    h('div', { class: 'menu-item', style: { padding: '8px 0' }, onclick: () => addToCollection(rel) },
      icon('ic_collection_add'), h('div', { class: 'grow' }, 'Добавить к себе в коллекцию')));
}

async function addToCollection(rel) {
  if (!requireAuth()) return;
  const list = h('div', { class: 'sheet-list' }, spinner());
  const d = dialog({ title: 'Мои коллекции', content: list, cls: 'sheet' });
  try {
    const r = await A.profileCollections(auth.profileId, 0);
    list.replaceChildren();
    if (!r.content?.length) list.append(h('div', { class: 'muted', style: { padding: '12px 24px' } }, 'У вас нет коллекций'));
    for (const c of r.content || []) {
      list.append(h('button', {
        class: 'sheet-item', onclick: async () => {
          d.close();
          const res = await A.collectionMyReleaseAdd(c.id, rel.id);
          toast(res.code === 0 ? `Релиз был успешно добавлен в вашу коллекцию ${c.title}` : res.code === 5 ? 'Этот релиз уже находится в вашей коллекции' : res.code === 7 ? 'Вы превысили допустимый лимит релизов в коллекции' : t('error_load'));
        },
      }, icon('ic_collection'), c.title));
    }
  } catch { list.replaceChildren(h('div', { class: 'muted', style: { padding: '12px 24px' } }, t('error_load'))); }
}

function videoBanners(rel) {
  const banners = rel.video_banners || [];
  if (!banners.length && !rel.can_video_appeal) return null;
  const card = h('div', { class: 'card' }, h('div', { class: 'card-title' }, h('span', { class: 'grow' }, 'Видео'),
    h('button', { class: 'section-more', onclick: () => navigate('release-videos', { release: rel }) }, 'Показать все', icon('ic_chevron_end', 'sm'))));
  if (!banners.length) card.append(h('div', { class: 'muted' }, 'Ой, а тут пока ничего нет! Вы можете отправить нам заявку на добавление первого видео'));
  else card.append(h('div', { class: 'screens' }, banners.map((b) => h('div', { style: { position: 'relative', cursor: 'pointer', flex: 'none' }, onclick: () => navigate('release-videos', { release: rel, categoryId: Number(b.value), categoryName: b.name }) },
    h('img', { src: b.image, referrerpolicy: 'no-referrer' }), h('div', { style: { position: 'absolute', left: '10px', bottom: '8px', color: '#fff', fontWeight: 500, textShadow: '0 1px 4px #000' } }, b.name),
    b.is_new ? h('span', { class: 'badge', style: { position: 'absolute', top: '6px', left: '6px', background: 'var(--carmine)', color: '#fff' } }, 'NEW') : null))));
  return card;
}

function screenshots(rel) {
  const s = rel.screenshot_images || [];
  if (!s.length) return null;
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Кадры'),
    h('div', { class: 'screens' }, s.map((src) => { const i = h('img', { src, loading: 'lazy', referrerpolicy: 'no-referrer' }); i.onclick = () => imageViewer(src); return i; })));
}

function relatedBlock(rel) {
  const list = rel.related_releases || [];
  if (!list.length) return null;
  return h('div', { class: 'card' },
    h('div', { class: 'card-title' }, h('span', { class: 'grow' }, 'Связанные релизы'),
      rel.related ? h('button', { class: 'section-more', onclick: () => navigate('related', { related: rel.related }) }, 'Показать все', icon('ic_chevron_end', 'sm')) : null),
    h('div', { class: 'screens', style: { gap: '14px' } }, list.map((r) => {
      const here = r.id === rel.id;
      return h('div', { class: 'release-card', style: { width: '128px', flex: 'none', opacity: here ? 0.55 : 1 }, onclick: () => !here && openRelease(r) },
        h('div', { class: 'poster', style: { width: '100%' } }, img(r.image), here ? h('div', { class: 'player-msg', style: { background: 'rgba(0,0,0,.5)', whiteSpace: 'pre-line', fontWeight: 500 } }, 'Вы\nздесь') : null),
        h('div', { class: 't clamp2', style: { fontSize: '13px' } }, r.title_ru || t('unnamed')),
        h('div', { class: 'meta' }, [r.year ? `${r.year} год` : '', r.category?.name, r.vote_count > 50 ? `★ ${gradeText(r.grade)}` : ''].filter(Boolean).join(' • ')));
    })));
}

function recommendedBlock(rel) {
  const list = rel.recommended_releases || [];
  if (!list.length) return null;
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Рекомендуем также'),
    h('div', { class: 'screens', style: { gap: '14px' } }, list.map((r) => h('div', { class: 'release-card', style: { width: '128px', flex: 'none' }, onclick: () => openRelease(r) },
      h('div', { class: 'poster', style: { width: '100%' } }, img(r.image)), h('div', { class: 't clamp2', style: { fontSize: '13px' } }, r.title_ru || t('unnamed'))))));
}

function commentsBlock(rel, rebuild) {
  const card = h('div', { class: 'card', style: { padding: '16px 0 0' } },
    h('div', { class: 'card-title', style: { padding: '0 16px' } }, h('div', { class: 'grow' }, 'Комментарии', h('div', { class: 'muted', style: { fontSize: '13px', fontWeight: 400 } }, 'Популярные и актуальные')),
      h('button', { class: 'section-more', onclick: () => navigate('comments', { kind: 'release', id: rel.id, release: rel }) }, 'Показать все', icon('ic_chevron_end', 'sm'))));
  const list = rel.comments || [];
  if (!list.length) card.append(h('div', { class: 'muted', style: { padding: '8px 16px 12px' } }, 'Еще никто не оставлял комментарии. Будьте первыми!'));
  list.forEach((c) => card.append(commentItem(c, { kind: 'release', release: rel })));
  card.append(commentComposer({
    onSend: async (body) => {
      const r = await A.releaseCommentAdd(rel.id, body);
      if (r.code === 0) { toast('Комментарий отправлен'); const fresh = await A.release(rel.id, true); Object.assign(rel, fresh.release); rebuild(); return true; }
      toast(commentAddError(r.code));
      return false;
    },
  }));
  return card;
}

// Связанные релизы (франшиза)
registerScreen('related', ({ related }) => h('div', null,
  backToolbar(related.name_ru || related.name || 'Связанные релизы'),
  related.description ? h('div', { class: 'muted', style: { padding: '0 20px 10px' } }, related.description) : null,
  pagedList({ load: (page) => A.related(related.id, page), render: (r) => releaseRow(r) })));

// Коллекции с релизом
registerScreen('release-collections', ({ release }) => {
  let sort = 1;
  const holder = h('div');
  const mk = () => pagedList({ skeleton: 'collections', load: (page) => A.releaseCollections(release.id, page, sort), render: (c) => collectionCard(c), grid: true, empty: () => emptyView('Коллекций пока нет') });
  holder.append(mk());
  return h('div', null, backToolbar('Коллекции', [iconButton('ic_sort', 'Сортировка', () => sheet('Сортировка', [
    { label: 'Сначала популярные', checked: sort === 1, onClick: () => { sort = 1; holder.replaceChildren(mk()); } },
    { label: 'Недавно добавленные', checked: sort === 5, onClick: () => { sort = 5; holder.replaceChildren(mk()); } },
  ]))]), holder);
});

// Видео релиза
function videoCard(v) {
  return h('div', { class: 'release-card', style: { width: '260px', flex: 'none' }, onclick: () => playVideo(v) },
    h('div', { class: 'poster', style: { aspectRatio: '16/9', width: '100%' } }, img(v.image), v.hosting?.icon ? h('img', { src: v.hosting.icon, style: { position: 'absolute', right: '8px', bottom: '8px', width: '22px', height: '22px' } }) : null),
    h('div', { class: 't clamp2' }, v.title), h('div', { class: 'meta' }, [v.category?.name, v.profile?.login, relTime(v.timestamp)].filter(Boolean).join(' • ')));
}
function playVideo(v) {
  const url = v.player_url || v.url;
  import('../player.js').then(({ openWebPlayer }) => openWebPlayer({ url, iframe: false, name: v.title }, { title_ru: v.release?.title_ru || v.title }));
}
registerScreen('release-videos', async ({ release, categoryId, categoryName }) => {
  const root = h('div', null, backToolbar(categoryName || 'Видео'));
  if (categoryId) {
    root.append(pagedList({ skeleton: 'collections', load: (page) => A.videoCategory(release.id, categoryId, page), render: videoCard, grid: true }));
    return root;
  }
  const r = await A.videoMain(release.id);
  for (const p of r.streaming_platforms || []) void p;
  if ((r.streaming_platforms || []).length) {
    root.append(sectionHead('Онлайн-кинотеатры'), h('div', { class: 'hscroll' }, r.streaming_platforms.map((p) => h('a', { class: 'tile', href: p.url, target: '_blank' }, p.icon ? h('img', { src: p.icon, style: { width: '28px', height: '28px', borderRadius: '6px' } }) : null, p.name))));
  }
  for (const b of r.blocks || []) {
    root.append(sectionHead(b.category?.name || 'Видео', (b.videos || []).length >= 25 ? () => navigate('release-videos', { release, categoryId: b.category.id, categoryName: b.category.name }) : null));
    root.append(h('div', { class: 'hscroll' }, (b.videos || []).map(videoCard)));
  }
  root.append(sectionHead('Последние видео'));
  root.append(pagedList({ skeleton: 'collections', load: (page) => A.videos(release.id, page), render: videoCard, grid: true, empty: () => emptyView('Видео пока нет') }));
  return root;
}, ({ categoryName, categoryId }) => [backToolbar(categoryName || 'Видео'), categoryId ? skeleton('collections') : skeleton('videos')]);

// «Воспроизвести»: сразу к вариантам, если включено «Непроверенные источники» и они не скрыты в регионе,
// иначе — экран «Онлайн просмотр» с официальными платформами
function openWatch(rel) {
  if (prefs.get('IS_REMEMBERING_SKIP_THIRD_PARTY_PLATFORM') && !rel.is_tpp_disabled) navigate('episodes', { release: rel });
  else navigate('streaming', { release: rel });
}

// «Искать другие варианты / Из непроверенных источников»
function onThirdParty(release) {
  const count = prefs.get('COUNT_SKIP_STREAMING_PLATFORM') || 0;
  const toEpisodes = () => navigate('episodes', { release });
  if (count === 4 && !prefs.get('IS_REMEMBERING_SKIP_THIRD_PARTY_PLATFORM') && !prefs.get('IS_ASKED_SKIP_THIRD_PARTY_PLATFORM')) {
    // после нескольких переходов — предложить запомнить выбор
    prefs.set('IS_ASKED_SKIP_THIRD_PARTY_PLATFORM', true);
    dialog({
      title: t('remembering_skip_third_party_platform_title'), content: h('p', null, t('remembering_skip_third_party_platform_desc')),
      actions: [{ label: t('cancel'), onClick: toEpisodes },
        { label: t('yes'), primary: true, onClick: () => { prefs.set('IS_REMEMBERING_SKIP_THIRD_PARTY_PLATFORM', true); prefs.set('SEARCH_VIDEO_TPP', true); toEpisodes(); } }],
    });
  } else if (!prefs.get('SEARCH_VIDEO_TPP')) {
    dialog({
      title: t('search_video_title'), content: h('p', null, t('search_video_desc')),
      actions: [{ label: t('cancel') },
        { label: t('search_video'), primary: true, onClick: () => { prefs.set('SEARCH_VIDEO_TPP', true); prefs.set('COUNT_SKIP_STREAMING_PLATFORM', count + 1); toEpisodes(); } }],
    });
  } else {
    if (count < 4) prefs.set('COUNT_SKIP_STREAMING_PLATFORM', count + 1);
    toEpisodes();
  }
}

// Онлайн просмотр (стриминговые платформы)
registerScreen('streaming', async ({ release }) => {
  const root = h('div', null, backToolbar(t('title_streaming_platform')));
  let items = [];
  try { items = (await A.streaming(release.id)).content || []; } catch { /* как пустой список */ }
  const list = h('div', { class: 'menu-list', style: { maxWidth: '760px' } }, h('div', { class: 'menu-cat' }, t('streaming_platform_official')));
  if (!items.length) list.append(h('div', { class: 'muted', style: { padding: '8px 24px 12px' } }, t('streaming_platform_no_result')));
  list.append(...items.map((p) => h('a', { class: 'menu-item', href: p.url, target: '_blank', rel: 'noopener' },
    p.icon ? h('img', { src: p.icon, referrerpolicy: 'no-referrer', style: { width: '36px', height: '36px', borderRadius: '8px' } }) : icon('ic_streaming_platform'),
    h('div', { class: 'grow' }, p.name), icon('ic_open_in_new'))));
  if (!release.is_tpp_disabled) {
    list.append(h('div', { class: 'menu-cat' }, t('streaming_platform_unofficial')),
      h('div', { class: 'menu-item', onclick: () => onThirdParty(release) }, icon('ic_search'),
        h('div', { class: 'grow' }, h('div', null, t('streaming_platform_search_services')), h('div', { class: 'sub' }, t('streaming_platform_unofficial'))), icon('ic_chevron_end')));
  } else {
    list.append(h('div', { class: 'card', style: { margin: '16px 20px', cursor: 'pointer' },
      onclick: () => dialog({ title: t('third_party_disabled_title'), content: h('p', null, t('third_party_disabled_message')), actions: [{ label: t('close'), primary: true }] }) },
    h('b', null, t('third_party_disabled_hint_title')), h('div', { class: 'muted', style: { marginTop: '4px' } }, t('third_party_disabled_hint_message'))));
  }
  root.append(list);
  return root;
}, () => {
  const { line, circle } = skParts;
  // «Официальный источник» (обычно — текст «не удалось найти»), «Из непроверенных источников» + строка поиска
  return [backToolbar(t('title_streaming_platform')), h('div', { class: 'menu-list', style: { maxWidth: '760px' } },
    h('div', { class: 'menu-cat' }, line('150px', '', { height: '14px' })),
    h('div', { style: { padding: '10px 24px 14px' } }, line('70%')),
    h('div', { class: 'menu-cat' }, line('190px', '', { height: '14px' })),
    h('div', { class: 'menu-item' }, circle('24px'), skParts.col('7px', line('180px', 'title'), line('160px'))))];
});
