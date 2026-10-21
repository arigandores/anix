// Релиз, связанные, коллекции релиза, видео
import { h, icon, iconButton, guardClick, growBars, nudge, rollTo, joinEnter, morph, img, toast, dialog, sheet, pagedList, emptyView, spinner, skeleton, errorView, skeletonSettled, markAppeared, skParts } from '../ui.js';
import { A, api, auth, takePrefetchedRelease, recentRelease, rememberRelease, releaseGen } from '../api.js';
import { t, tp } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import {
  gradeText, digits, seasonName, LIST_NAMES, chooseListStatus, toggleFavorite, requireAuth, commentItem, commentComposer,
  openRelease, imageViewer, report, backToolbar, sectionHead, collectionCard, relTime, releaseRow,
} from './common.js';
import { prefetchWatch, watchBlock, typesOf, typeLogo } from './episodes.js';
import { partyWatchButton } from '../party/ui.js';
import { haptic } from '../platform.js';
import { heartIcon, lottieIcon, copyIcon } from '../lottie.js';

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

// Строки сведений: страна и сезон, серии, тип и статус, студия/автор/режиссёр, первоисточник, жанры, озвучка, даты.
// preview — из данных строки списка (страница ещё грузится): там нет типа и статуса — на их месте серая полоска,
// чтобы строк было столько же и ничего не сдвинулось, когда придёт страница
function infoRowsView(rel, { preview = false } = {}) {
  const st = rel.status?.id ?? rel.status_id; // статус — свежий (после фонового обновления)
  const infoRows = [];
  const countryParts = [rel.country, [seasonName(rel.season), rel.year ? `${rel.year} г.` : ''].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (countryParts) infoRows.push(['ic_flag_' + (rel.country === 'Япония' ? 'japan' : rel.country === 'Китай' ? 'chinese' : 'unknown'), cap(countryParts), true]);
  const R = rel.episodes_released; const T = rel.episodes_total;
  if (R || T || rel.duration) {
    let e = R != null && R === T ? `${R} эп.` : R != null && T != null ? `${R} из ${T} эп.` : R != null ? `${R} из ? эп.` : T != null ? `? из ${T} эп.` : '? эп.';
    if (rel.duration > 0) e += ` по ~${rel.duration} мин.`;
    infoRows.push(['ic_episodes', e]);
  }
  if (!rel.category && !rel.status && preview) infoRows.push(['ic_schedule', h('span', { class: 'sk sk-line', style: { display: 'inline-block', width: '150px', height: '12px', verticalAlign: 'middle' } })]);
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
  return h('div', { class: 'info-rows' }, infoRows.map(([ic, txt, raw]) => h('div', { class: 'info-row' }, raw ? h('img', { src: `/icons/${ic}.svg`, style: { width: '20px', height: '20px' } }) : icon(ic), h('div', null, txt))));
}

// Пока грузится release/{id}: шапка из данных карточки списка,
// остальное — скелетоны в той же раскладке, чтобы страница не прыгала.
// Скелетон страницы аниме — из тех же классов, что настоящая страница (.rel-actions, .watch-row, .card-title,
// .info-rows, .screens, .rating-box…), поэтому размеры и отступы совпадают; секции — как у обычной страницы, до
// комментариев внизу (раньше — только первая карточка и две справа, ниже пустота). Из данных строки списка
// (preload) — сразу настоящие постер, название, фон и примечание
// Блок сведений в предпросмотре. Из данных строки списка (в них почти все поля страницы) — настоящие строки и
// описание: совпадают с пришедшей страницей до пикселя (серые полоски не совпадали: другие высота строк и описания,
// жёсткое число строк). Без них — серые полоски в размерах настоящих: строка — 21 px (высота строки текста),
// описание — свёрнутые 6 строк .desc-text
function infoPreview(p) {
  const { line, circle } = skParts;
  if (p && (p.description != null || p.genres || p.country)) {
    const longDesc = (p.description || '').length > 300;
    return h('div', { class: 'card' }, infoRowsView(p, { preview: true }),
      h('div', { style: { marginTop: '14px' } }, h('div', { class: 'desc-text collapsed' }, p.description || t('description_not_specified')),
        longDesc ? h('button', { class: 'btn btn-text', style: { paddingLeft: 0, pointerEvents: 'none' }, tabindex: '-1' }, 'Подробнее…') : null));
  }
  // высота строки — как у строки сведений с текстом (21 px; в две строки — 39) и строки описания (1lh)
  const textLine = (w, hgt = '21px') => h('div', { style: { height: hgt, display: 'flex', alignItems: 'center', flex: '1' } }, line(w));
  return h('div', { class: 'card' },
    // страна, серии, статус, студия, первоисточник, жанры (обычно в две строки), озвучка, даты
    h('div', { class: 'info-rows' }, ['34%', '30%', '26%', '62%', '28%', ['92%', '40%'], '44%', '32%'].map((w, i) => h('div', { class: 'info-row' }, circle('20px'),
      // первая строка (страна) — с флагом-картинкой, без текстовой высоты: 20 px
      Array.isArray(w) ? h('div', { style: { flex: '1' } }, textLine(w[0], '19.5px'), textLine(w[1], '19.5px')) : textLine(w, i ? '21px' : '20px')))),
    // описание (свёрнуто до 6 строк) и «Подробнее…»
    h('div', { style: { marginTop: '14px' } }, h('div', { class: 'desc-text collapsed', style: { maskImage: 'none', webkitMaskImage: 'none' } }, ...['98%', '95%', '97%', '93%', '96%', '60%'].map((w) => textLine(w, '1lh'))),
      h('div', { style: { height: '40px', display: 'flex', alignItems: 'center' } }, line('84px'))));
}

function previewPage(p) {
  const { line, block, circle, pill, col } = skParts;
  const title = p && (p.title_ru || p.title_original);
  const card = (...c) => h('div', { class: 'card' }, ...c);
  const cardTitle = (w) => h('div', { class: 'card-title' }, line(w, 'title'));
  const thumbs = (n) => h('div', { class: 'screens' }, Array.from({ length: n }, () => block({ width: '231px', height: '130px', borderRadius: '10px', flex: 'none' })));
  const relCards = (n) => h('div', { class: 'screens', style: { gap: '14px' } }, Array.from({ length: n }, () => h('div', { class: 'release-card', style: { width: '128px', flex: 'none' } },
    block({ width: '100%', aspectRatio: '2 / 3', borderRadius: '10px' }), line('90%'), line('60%'))));
  const comment = (w) => h('div', { class: 'comment', style: { padding: '12px 16px' } }, circle('40px'), col('8px', line('30%', 'title'), line(w), line('22%')));
  return [
    h('div', { class: 'rel-hero' },
      p?.image ? heroBg(p.image) : null,
      h('div', { class: 'inner' },
        h('div', { class: `poster ${p?.image ? '' : 'sk'}` }, p?.image ? img(p.image) : null),
        h('div', { class: 'head' },
          title ? h('h1', { class: 'rel-title' }, title) : line('55%', 'big'),
          p?.title_ru && p?.title_original ? h('div', { class: 'rel-orig' }, p.title_original) : line('35%'),
          h('div', { class: 'row', style: { gap: '6px', marginTop: '4px', flexWrap: 'wrap' } }, block({ width: '36px', height: '22px', borderRadius: '6px' }), block({ width: '86px', height: '22px', borderRadius: '6px' })),
          p?.note ? h('div', { class: 'rel-note', html: p.note, style: noteStyle(p) }) : null,
          // «Не смотрю», «♡ число», «💬 число»
          h('div', { class: 'rel-actions' }, pill('124px'), pill('96px'), pill('64px')),
          // «Смотреть» и «Смотреть вместе»
          h('div', { style: { marginTop: '14px' } }, h('div', { class: 'watch' }, h('div', { class: 'watch-row' },
            block({ flex: '1 1 260px', height: '48px', borderRadius: '24px' }), pill('190px', '48px'))))))), // ширина как у «Смотреть вместе» — так же переносится на узком окне
    h('div', { class: 'rel-body skeleton' },
      h('div', null,
        infoPreview(p),
        card(cardTitle('16%'), thumbs(2)),
        card(cardTitle('14%'), thumbs(4)),
        card(cardTitle('30%'), relCards(5)),
        card(cardTitle('34%'), relCards(5)),
        card(cardTitle('26%'), line('36%', '', { margin: '-4px 0 14px' }), block({ height: '46px', borderRadius: '23px', marginBottom: '8px' }),
          comment('70%'), comment('85%'), comment('55%'), comment('78%'), comment('62%'))),
      h('div', null,
        card(cardTitle('40%'), h('div', { class: 'rating-box' }, col('6px', block({ width: '64px', height: '44px', borderRadius: '8px' }), line('70px')),
          col('9px', ...[90, 30, 12, 6, 8].map((w) => line(`${w}%`, '', { height: '6px' }))))),
        card(cardTitle('60%'), block({ height: '10px', borderRadius: '5px', margin: '8px 0 12px' }),
          h('div', { class: 'info-rows' }, ['40%', '46%', '58%', '44%', '40%'].map((w) => h('div', { class: 'row' }, circle('10px'), h('div', { class: 'grow' }, line(w)), line('36px'))))),
        card(...[['62%', '44px'], ['78%', '']].map(([w, badge]) => h('div', { class: 'row', style: { gap: '16px', padding: '8px 0' } }, block({ width: '24px', height: '24px', borderRadius: '6px', flex: 'none' }), h('div', { class: 'grow' }, line(w)), badge ? block({ width: badge, height: '22px', borderRadius: '6px' }) : null))))),
  ];
}

registerScreen('release', ({ id, random, profileId, status, collectionId, preload }, ctx) => {
  const root = h('div', null);
  let rel;
  let usePreload = !random && preload ? preload : null;
  async function fetchRelease() {
    let r;
    const gen = releaseGen(); // ответ на запрос до смены аккаунта в память не кладём (api.js)
    if (random === 1) r = await A.random(true);
    else if (random === 2) r = await A.randomProfileList(profileId, status, true);
    else if (random === 3) r = await A.randomFavorite(true);
    else if (random === 4) r = await A.randomCollection(collectionId, true);
    else {
      const cached = recentRelease(id);
      if (cached) { // уже открывали — сразу из памяти; свежие данные фоном: изменилось важное — страница обновится
        A.release(id, true).then((fresh) => { rememberRelease(fresh, gen); if (gen === releaseGen()) refreshFrom(fresh); }, () => {});
        return cached;
      }
      r = await (takePrefetchedRelease(id) || A.release(id, true));
    }
    rememberRelease(r, gen);
    return r;
  }
  // Шапка одна на экран: колокольчик и «Ещё» видны сразу, пока страница грузится (до загрузки нажатие ничего
  // не делает) — раньше они появлялись после загрузки и сдвигали кнопку «Смотреть вместе»
  const toolbar = backToolbar('', [
    random ? iconButton('ic_shuffle', t('label_random'), () => render()) : null,
    iconButton('ic_bell', 'Уведомления о новых сериях', () => rel && typeNotifications(rel)),
    iconButton('ic_more', 'Ещё', () => rel && moreSheet(rel)),
  ], { party: true }); // 👥 «Смотреть вместе» — как в главной шапке
  const titleEl = toolbar.querySelector('.title');
  titleEl.style.opacity = '0';
  let scrollHooked = false; // название в шапке проявляется при прокрутке (подписка — при первой сборке страницы)
  async function render() {
    rel = null; titleEl.textContent = '';
    root.replaceChildren(toolbar, ...previewPage(usePreload));
    usePreload = null; // «Случайный» и повторная загрузка — без старых данных
    let r;
    try { r = await fetchRelease(); } catch (e) { await skeletonSettled(root); root.replaceChildren(toolbar, errorView(e, render)); return; }
    const instant = await skeletonSettled(root);
    rel = r.release;
    if (!rel || r.code !== 0 || rel.is_deleted) {
      // как «Коллекция не найдена» и «Профиль не найден» — пустой экран с привидением, а не своя статичная иконка
      const gone = emptyView('Страница не найдена', 'Возможно, она была удалена и больше недоступна');
      gone.append(h('button', { class: 'btn btn-tonal', onclick: () => history.back() }, 'Назад'));
      root.replaceChildren(toolbar, gone);
      return;
    }
    build();
    // страница сменила видимый скелетон — проявляется поверх, без рывка; шапка не трогается (она и так видна,
    // её проявление читалось как блик)
    // страница сменила видимый скелетон: одна анимация на весь переход — пока экран въезжает, контент подхватывает
    // этот въезд с того же места; въезд кончился — контент встаёт сразу (отдельное проявление было второй анимацией)
    markAppeared(root); // строки и карточки внутри — без своего проявления
    joinEnter(root);

  }

  // Фоновое обновление страницы, показанной из памяти: обновляются только изменившиеся блоки (livePatch в build) —
  // счётчики перекатываются на месте, рейтинг и «в списках» — числами без повторного роста полос; открытые ветки
  // ответов, начатый комментарий, сердце и звёзды не трогаются. Раньше пересобиралась вся страница
  let livePatch = null;
  function refreshFrom(fresh) {
    const f = fresh?.code === 0 && fresh.release;
    if (!f || !rel || f.id !== rel.id || !root.isConnected || !livePatch) return;
    livePatch(f);
  }

  function build() {
    const title = rel.title_ru || rel.title_original || t('unnamed');
    const sub = rel.title_ru && rel.title_original ? rel.title_original : '';
    titleEl.textContent = title;
    if (!scrollHooked) {
      scrollHooked = true;
      ctx.entry.node.closest('#viewport')?.addEventListener('scroll', function onS(e) {
        if (!toolbar.isConnected) { e.currentTarget.removeEventListener('scroll', onS); scrollHooked = false; return; }
        titleEl.style.opacity = e.currentTarget.scrollTop > 240 ? '1' : '0';
      });
    }

    // --- Панель: список / избранное / комментарии ---
    const listBtn = h('button', { class: 'btn list-btn' });
    const favBtn = h('button', { class: 'btn list-btn' });
    const heart = heartIcon(!!rel.is_favorite); // одно и то же сердце между перерисовками — анимация не обрывается
    const favCount = h('span');
    const paintFav = (on, animate) => {
      heart.set(on, animate); // до смены цвета кнопки (lottie.js, heartIcon)
      favBtn.className = `btn list-btn ${on ? 'tag tag-fav' : ''}`;
    };
    let shownStatus = null; let shownFavs = null;
    const paintPanel = () => {
      const s = rel.profile_list_status || 0;
      listBtn.replaceChildren(icon('ic_arrow_drop_down', 'sm'), t(LIST_NAMES[s]));
      // button_tag_{color}: цвет по статусу; 0 «Не смотрю» — обычная серая кнопка
      listBtn.className = `btn list-btn ${s ? `tag tag-${s}` : ''}`;
      // статус сменился — кнопка коротко откликается (не при первой отрисовке)
      if (shownStatus != null && shownStatus !== s) nudge(listBtn, [{ transform: 'scale(.94)' }, { transform: 'scale(1.04)', offset: 0.5 }, { transform: 'none' }], 300);
      shownStatus = s;
      paintFav(!!rel.is_favorite, false);
      const n = rel.favorites_count || 0;
      if (shownFavs == null) favCount.textContent = digits(n); else rollTo(favCount, digits(n), n > shownFavs);
      shownFavs = n;
    };
    favBtn.append(heart, favCount);
    listBtn.onclick = () => chooseListStatus(rel, paintPanel);
    // сердце выпрыгивает сразу по нажатию, ответ сервера — потом (не удалось — paintPanel вернёт как было)
    favBtn.onclick = guardClick(favBtn, () => toggleFavorite(rel, paintPanel, (on) => paintFav(on, true)));
    paintPanel();

    // --- Кнопка просмотра ---
    const st = rel.status?.id ?? rel.status_id;
    let watch;
    // анонс — раньше «недоступно»: у не вышедшего сервер тоже ставит is_play_disabled, и вместо «Анонс» было «Недоступно»
    if (st === 3 && !rel.episodes_released) watch = h('div', { class: 'muted' }, rel.aired_on_date ? `Анонс — выйдет ${new Date(rel.aired_on_date * 1000).toLocaleDateString('ru-RU')}` : 'Анонс — серии ещё не вышли');
    else if (rel.is_view_blocked) watch = h('div', { class: 'muted' }, 'Недоступно в вашей стране');
    else if (rel.is_play_disabled) watch = h('div', { class: 'muted' }, 'Недоступно');
    else if (rel.is_tpp_disabled) watch = h('div', { class: 'muted' }, 'Недоступно в вашем регионе');
    else {
      // «Смотреть» / «Продолжить» (episodes.js): озвучки, источники и серии запрашиваем заранее, в фоне
      prefetchWatch(rel);
      watch = watchBlock(rel, partyWatchButton(rel, () => navigate('episodes', { release: rel }))); // «Смотреть вместе» / «Предложить комнате» (party/ui.js)
      ctx.setOnShow(() => watch.repaint()); // вернулись со своей серии или с экрана серий — кнопка по свежему прогрессу
      ctx.setDispose(() => watch.dispose());
    }

    let commentsCount = null;
    const preComments = preCommentsOf(rel);
    const hero = h('div', { class: 'rel-hero' },
      heroBg(rel.image),
      h('div', { class: 'inner' },
        h('div', { class: 'poster', onclick: () => imageViewer(rel.image, { title: rel.title_ru || rel.title_original || '' }) }, img(rel.image)),
        h('div', { class: 'head' },
          h('h1', { class: 'rel-title' }, title),
          sub ? h('div', { class: 'rel-orig' }, sub) : null,
          h('div', { class: 'row rel-badges', style: { gap: '6px', marginTop: '4px', flexWrap: 'wrap' } },
            rel.age_rating > 0 ? h('button', { class: 'badge', onclick: () => dialog({ title: t('information'), content: h('p', { style: { whiteSpace: 'pre-line' } }, t('age_rating_info')), actions: [{ label: t('close'), primary: true }] }) }, AGE[rel.age_rating]) : null,
            rel.title_alt || rel.title_original ? h('button', { class: 'badge', onclick: () => titleInfo(rel) }, icon('ic_info_outline', 'xs'), 'Названия') : null),
          rel.note ? h('div', { class: 'rel-note', html: rel.note, style: noteStyle(rel) }) : null,
          h('div', { class: 'rel-actions' }, listBtn, favBtn,
            h('button', { class: 'btn list-btn', onclick: () => navigate('comments', { kind: 'release', id: rel.id, release: rel }), onpointerdown: preComments }, icon('ic_comment_outline', 'sm'), commentsCount = h('span', null, digits(rel.comment_count ?? rel.comments_count ?? 0)))),
          h('div', { style: { marginTop: '14px' } }, watch))));

    // --- Информация --- (функцией: при фоновом обновлении — новые серии/статус — блок пересобирается отдельно)
    const infoRowsEl = () => infoRowsView(rel);
    let infoEl = infoRowsEl();

    // Длинное описание свёрнуто: раскрывается и кнопкой, и нажатием на сам текст, сворачивается только кнопкой
    const longDesc = (rel.description || '').length > 300;
    const desc = h('div', { class: `desc-text collapsed ${longDesc ? 'expandable' : ''}` }, rel.description || t('description_not_specified'));
    const descToggle = h('button', { class: 'btn btn-text', style: { paddingLeft: 0 } }, 'Подробнее…');
    const setCollapsed = (c) => { desc.classList.toggle('collapsed', c); descToggle.textContent = c ? 'Подробнее…' : 'Скрыть'; };
    descToggle.onclick = () => setCollapsed(!desc.classList.contains('collapsed'));
    if (longDesc) desc.onclick = () => { if (desc.classList.contains('collapsed')) setCollapsed(false); };

    const left = h('div', null,
      h('div', { class: 'card' },
        infoEl,
        h('div', { style: { marginTop: '14px' } }, desc, longDesc ? descToggle : null)),
      videoBanners(rel),
      screenshots(rel),
      relatedBlock(rel),
      recommendedBlock(rel),
      commentsBlock(rel, () => build()));
    let ratingEl = ratingBlock(rel); let statsEl = statsBlock(rel); let collEl = collectionsBlock(rel);
    const right = h('div', null, ratingEl, statsEl, collEl);
    // свежие данные пришли фоном (refreshFrom): меняем только то, что изменилось
    // блок изменился — правим в нём только изменившееся и плавно (ui.js morph): числа перекатываются, полосы доезжают
    const swap = (old, fresh) => { if (old && fresh) { morph(old, markAppeared(fresh)); return old; } if (old) old.remove(); return fresh; };
    livePatch = (f) => {
      const was = { ...rel };
      const diff = (...keys) => keys.some((k) => f[k] !== was[k]);
      Object.assign(rel, f);
      paintPanel(); // статус, сердце, число «в избранном» (перекатывается)
      const nc = rel.comment_count ?? rel.comments_count ?? 0; const oc = was.comment_count ?? was.comments_count ?? 0;
      if (nc !== oc) rollTo(commentsCount, digits(nc), nc > oc);
      if (diff('grade', 'vote_count', 'your_vote', 'vote_1_count', 'vote_2_count', 'vote_3_count', 'vote_4_count', 'vote_5_count')) ratingEl = swap(ratingEl, ratingBlock(rel, { grow: false }));
      if (diff('watching_count', 'plan_count', 'completed_count', 'hold_on_count', 'dropped_count', 'status_id') || (f.status?.id !== was.status?.id)) statsEl = swap(statsEl, statsBlock(rel, { grow: false }));
      if (diff('collection_count')) collEl = swap(collEl, collectionsBlock(rel));
      if (diff('episodes_released', 'episodes_total', 'status_id', 'broadcast', 'duration') || (f.status?.id !== was.status?.id)) {
        morph(infoEl, infoRowsEl());
        watch.repaint?.(); // «Смотреть / Продолжить» — по новым сериям
      }
    };

    root.replaceChildren(toolbar, hero, h('div', { class: 'rel-body' }, left, right));
  }

  render();
  return root;
});

// Размытый постер за шапкой: проявляется, когда картинка загрузилась (а не вспыхивает поверх тёмного фона);
// уже в кэше — сразу, без проявления (иначе при смене скелетона на страницу фон бы перемигивал)
function heroBg(src) {
  const el = h('div', { class: 'bg', style: { backgroundImage: `url("${src}")` } });
  const im = new Image();
  im.src = src;
  if (im.complete && im.naturalWidth) el.classList.add('ready');
  else im.onload = () => el.classList.add('ready', 'fade-in');
  return el;
}

function noteStyle(rel) {
  const dark = document.documentElement.dataset.theme === 'dark';
  const bg = dark ? rel.note_background_color_dark : rel.note_background_color_light;
  const fg = dark ? rel.note_text_color_dark : rel.note_text_color_light;
  return { background: bg || '', color: fg || '' };
}

function titleInfo(rel) {
  // значок копирования на месте превращается в галочку (lottie.js copyIcon)
  const row = (label, val) => { if (!val) return null; const ic = copyIcon(); return h('div', { class: 'menu-item inset', onclick: () => { navigator.clipboard?.writeText(val); ic.done(); toast('Скопировано', { ok: true }); } },
    h('div', { class: 'grow' }, h('div', { class: 'sub' }, label), h('div', { style: { whiteSpace: 'pre-line' } }, val)), ic); };
  dialog({ title: 'Названия', content: h('div', null, row('Название', rel.title_ru), row('Оригинальное название', rel.title_original), row('Альтернативные названия', rel.title_alt)), actions: [{ label: t('close') }] });
}

function moreSheet(rel) {
  const base = (window.__toggles && window.__toggles.baseUrl) || 'https://anixart-app.com/';
  const link = `${base}release/${rel.id}`;
  sheet(null, [
    { label: 'Поделиться', icon: 'ic_export_variant', onClick: () => { const text = `${rel.title_ru}\n${link}`; if (navigator.share) navigator.share({ text }).catch(() => {}); else { navigator.clipboard?.writeText(text); toast('Скопировано', { ok: true }); } } },
    { label: 'Скопировать ссылку', icon: 'ic_link', onClick: () => { navigator.clipboard?.writeText(link); toast('Скопировано', { ok: true }); } },
    // ярлык аниме на рабочем столе телефона (как в Anixart): открывает его страницу (anixart://release?id=…)
    window.anixartNative?.pinShortcut ? { label: 'На рабочий стол', icon: 'ic_home', onClick: () => window.anixartNative.pinShortcut(`release-${rel.id}`, rel.title_ru || rel.title_original || 'Аниме', `anixart://release?id=${rel.id}`, rel.image || '') } : null,
    { label: 'Пожаловаться', icon: 'ic_alert', onClick: () => report('release', rel.id) },
  ]);
}

async function typeNotifications(rel) {
  if (!requireAuth()) return;
  try {
    // озвучки этого релиза (как на экране серий), а не весь справочник type/all; уже включённые, которых у релиза
    // больше нет, тоже в списке — чтобы их можно было снять
    const [types, cur] = await Promise.all([typesOf(rel.id), api.get(`profile/preference/notification/release/type/${rel.id}`)]);
    const selected = new Set((cur.profile_release_type_notification_preferences || cur.types || []).map((x) => (typeof x === 'object' ? x.type?.id ?? x.id : x)));
    let list = types;
    const gone = [...selected].filter((id) => !types.some((ty) => ty.id === id));
    if (gone.length) list = list.concat(((await A.types_all()).types || []).filter((ty) => gone.includes(ty.id)));
    const box = h('div', { class: 'sheet-list' }, list.length ? list.map((ty) => {
      const cb = h('input', { type: 'checkbox' }); cb.checked = selected.has(ty.id);
      cb.onchange = () => { if (cb.checked) selected.add(ty.id); else selected.delete(ty.id); };
      return h('label', { class: 'sheet-item', style: { cursor: 'pointer' } }, cb, typeLogo(ty, 'sm'), ty.name);
    }) : h('div', { class: 'muted', style: { padding: '12px 24px' } }, 'У релиза пока нет озвучек'));
    dialog({
      title: 'Уведомления о новых сериях', content: box,
      actions: [{ label: 'Отмена' }, {
        label: 'Сохранить', primary: true,
        onClick: async () => {
          await api.post('profile/preference/notification/release/type/edit', { release_id: rel.id, profile_release_type_notification_preferences: [...selected] });
          toast(selected.size ? 'Уведомления о новых сериях включены' : 'Уведомления о новых сериях отключены', { ok: true });
        },
      }],
    });
  } catch { toast(t('error_load')); }
}

function ratingBlock(rel, { grow = true } = {}) {
  const st = rel.status?.id ?? rel.status_id;
  if (st === 3) return null;
  const card = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Рейтинг'));
  if (!(rel.vote_count > 50)) card.append(h('div', { class: 'muted' }, 'Недостаточно голосов для отображения рейтинга'));
  else {
    const sum = [1, 2, 3, 4, 5].reduce((a, i) => a + (rel[`vote_${i}_count`] || 0), 0) || 1;
    card.append(h('div', { class: 'rating-box' },
      h('div', null, h('div', { class: 'rating-big' }, bigGrade(rel.grade)), h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '4px' } }, `${digits(rel.vote_count)} ${tp('votes', rel.vote_count)}`)),
      (grow ? (el) => growBars(el, '.fill', 60) : (el) => el)(h('div', { class: 'rating-bars' }, [5, 4, 3, 2, 1].map((i) => h('div', { class: 'rating-bar' }, h('span', null, String(i)),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${((rel[`vote_${i}_count`] || 0) * 100) / sum}%` } }))))))));
  }
  if (auth.loggedIn) {
    const zone = h('div', { style: { marginTop: '14px' } });
    // voted — только что проголосовали: звёзды по очереди выпрыгивают (lottie.js)
    const paint = (voted) => {
      zone.replaceChildren();
      if (rel.your_vote) {
        // до старта звёзды серые (начальный кадр), выпрыгивают по очереди, когда готовы все — иначе залитая
        // запасная иконка мелькала до загрузки анимации, а очерёдность сбивалась
        const pops = [];
        const star = (i) => {
          if (i > rel.your_vote) return icon('ic_star_rate');
          const el = lottieIcon('star', { fallback: 'ic_star_rate', pad: 0.5, rest: voted ? 0 : 'pop', muted: voted });
          if (voted) pops.push(el);
          return el;
        };
        if (voted) queueMicrotask(async () => {
          const ok = await Promise.all(pops.map((el) => el.ready));
          pops.forEach((el, k) => (ok[k] ? setTimeout(() => { el.play('pop'); el.classList.remove('lt-muted'); }, 120 + k * 70) : el.classList.remove('lt-muted')));
        });
        // звёзды — своей строкой, подпись и «Изменить» — под ними: в колонке 320 px рядом со звёздами подпись не помещалась
        zone.append(
          h('div', { class: 'stars' }, [1, 2, 3, 4, 5].map((i) => h('span', { class: i <= rel.your_vote ? 'on' : '', style: { color: i <= rel.your_vote ? 'var(--orange)' : 'var(--text4)' } }, star(i)))),
          h('div', { class: 'row vote-done' },
            h('div', { class: 'grow' }, h('b', null, `${rel.your_vote} из 5`), h('span', { class: 'muted' }, ' · Вы проголосовали')),
            h('button', { class: 'btn btn-text', onclick: async () => { try { const r = await A.deleteVote(rel.id); if (r.code !== 0) throw 0; rel.your_vote = null; paint(); } catch { toast('Произошла ошибка при удалении голоса.'); } } }, 'Изменить')));
      } else {
        zone.append(h('div', { class: 'stars pick' }, [1, 2, 3, 4, 5].map((i) => h('button', { title: STAR_LABELS[i], onclick: () => confirmVote(i) }, icon('ic_star_rate')))));
      }
    };
    const confirmVote = (n) => dialog({
      title: STAR_LABELS[n], content: h('div', { class: 'stars' }, [1, 2, 3, 4, 5].map((i) => h('span', { style: { color: i <= n ? 'var(--orange)' : 'var(--text4)' } }, icon('ic_star_rate')))),
      actions: [{ label: 'Отмена' }, {
        label: 'Отправить', primary: true,
        onClick: async () => {
          try {
            const r = await A.vote(rel.id, n); if (r.code !== 0) throw 0;
            rel.your_vote = n; paint(true); haptic();
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
    content: h('div', null, h('p', null, 'Поделитесь впечатлениями — что понравилось, а что разочаровало'), ta, h('label', { class: 'row', style: { marginTop: '10px' } }, sp, 'Содержит спойлер')),
    actions: [{ label: 'Нет, спасибо' }, {
      label: 'Отправить', primary: true,
      onClick: async () => {
        const m = ta.value.trim();
        if (m.length < 5) { toast('Ваш комментарий слишком короткий. Дайте свободу мысли!'); return true; }
        if (m.length > 720) { toast('Ваш комментарий слишком длинный. Краткость – сестра таланта!'); return true; }
        const r = await A.releaseCommentAdd(rel.id, { parentCommentId: null, replyToProfileId: null, message: m, spoiler: sp.checked });
        toast(r.code === 0 ? 'Комментарий отправлен' : commentAddError(r.code), { ok: r.code === 0 });
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

function statsBlock(rel, { grow = true } = {}) {
  const st = rel.status?.id ?? rel.status_id;
  const card = h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'В списках у людей'));
  if (st === 3) {
    card.append(h('div', null, `${digits(rel.plan_count)} ${tp('users', rel.plan_count, '').trim() || 'пользователей'} ${tp('planning', rel.plan_count, '').trim() || 'планируют'}`), h('div', { class: 'muted' }, 'смотреть этот релиз'));
    return card;
  }
  const rows = [['list_watching', rel.watching_count, 'green'], ['list_plan', rel.plan_count, 'purple'], ['list_completed', rel.completed_count, 'blue'], ['list_hold_on', rel.hold_on_count, 'yellow'], ['list_dropped', rel.dropped_count, 'red']];
  const total = rows.reduce((a, r) => a + (r[1] || 0), 0) || 1;
  const bars = h('div', { class: 'progress-multi' }, rows.map(([, n, c]) => h('div', { style: { width: `${((n || 0) * 100) / total}%`, background: `var(--${c})` } })));
  card.append(grow ? growBars(bars) : bars);
  card.append(h('div', { class: 'info-rows' }, rows.map(([k, n, c]) => h('div', { class: 'row' }, h('span', { style: { width: '10px', height: '10px', borderRadius: '50%', background: `var(--${c})` } }), h('span', { class: 'grow' }, t(k)), h('b', null, digits(n))))));
  return card;
}

function collectionsBlock(rel) {
  return h('div', { class: 'card' },
    h('div', { class: 'menu-item inset', onclick: () => navigate('release-collections', { release: rel }) },
      icon('ic_collection'), h('div', { class: 'grow' }, 'Показать в коллекциях'), rel.collection_count > 0 ? h('span', { class: 'badge' }, digits(rel.collection_count)) : null),
    h('div', { class: 'menu-item inset', onclick: () => addToCollection(rel) },
      icon('ic_collection_add'), h('div', { class: 'grow' }, 'Добавить к себе в коллекцию')));
}

async function addToCollection(rel) {
  if (!requireAuth()) return;
  const list = h('div', { class: 'sheet-list' }, spinner());
  const d = dialog({ title: 'Мои коллекции', content: list, cls: 'sheet' });
  try {
    const r = await A.profileCollections(auth.profileId, 0);
    list.replaceChildren();
    // как в Anixart: создать коллекцию прямо отсюда — этот релиз уже в её списке (collection-editor.js)
    list.append(h('button', { class: 'sheet-item', onclick: () => { d.close(); navigate('collection-editor', { releases: [rel] }); } }, icon('ic_plus'), 'Новая коллекция'));
    if (!r.content?.length) list.append(h('div', { class: 'muted', style: { padding: '12px 24px' } }, 'У вас нет коллекций'));
    for (const c of r.content || []) {
      list.append(h('button', {
        class: 'sheet-item', onclick: async () => {
          d.close();
          const res = await A.collectionMyReleaseAdd(c.id, rel.id);
          toast(res.code === 0 ? `Релиз был успешно добавлен в вашу коллекцию ${c.title}` : res.code === 5 ? 'Этот релиз уже находится в вашей коллекции' : res.code === 7 ? 'Вы превысили допустимый лимит релизов в коллекции' : t('error_load'), { ok: res.code === 0 });
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
  if (!banners.length) card.append(h('div', { class: 'muted' }, 'Ой, а тут пока ничего нет!'));
  // плитки ведут к видео раздела, а не увеличивают картинку — курсор-указатель, а не лупа скриншотов (.vb в app.css)
  else card.append(h('div', { class: 'screens' }, banners.map((b) => h('div', { class: 'vb', style: { position: 'relative', cursor: 'pointer', flex: 'none' }, onclick: () => navigate('release-videos', { release: rel, categoryId: Number(b.value), categoryName: b.name }) },
    h('img', { src: b.image, referrerpolicy: 'no-referrer' }), h('div', { style: { position: 'absolute', left: '10px', bottom: '8px', color: '#fff', fontWeight: 500, textShadow: '0 1px 4px #000' } }, b.name),
    b.is_new ? h('span', { class: 'badge', style: { position: 'absolute', top: '6px', left: '6px', background: 'var(--carmine)', color: '#fff' } }, 'NEW') : null))));
  return card;
}

function screenshots(rel) {
  const s = rel.screenshot_images || [];
  if (!s.length) return null;
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Кадры'),
    h('div', { class: 'screens' }, s.map((src, k) => { const i = h('img', { src, loading: 'lazy', referrerpolicy: 'no-referrer' }); i.onclick = () => imageViewer(src, { images: s, index: k, title: rel.title_ru || rel.title_original || '' }); return i; })));
}

// Связанные релизы — вся франшиза по порядку выхода. В ответе release/{id} только первые три, поэтому
// полный список (related/{id}, по годам и сезонам) догружается в фоне. Стрелки между карточками
// показывают порядок, лента прокручивается к текущему релизу («Вы здесь»).
async function loadRelated(relatedId) {
  let all = [];
  for (let page = 0; page < 8; page++) {
    const items = (await A.related(relatedId, page)).content || [];
    all = all.concat(items);
    if (items.length < 25) break;
  }
  return all;
}

function relatedBlock(rel) {
  const first = rel.related_releases || [];
  if (!first.length) return null;
  const strip = h('div', { class: 'screens related-strip', style: { gap: '6px' } });
  const paint = (list, instant) => {
    const cards = [];
    list.forEach((r, i) => {
      const here = r.id === rel.id;
      if (i) cards.push(h('div', { class: 'chain-arrow', 'aria-hidden': 'true' }, icon('ic_chevron_end', 'sm')));
      const card = h('div', { class: `release-card ${here ? 'here' : ''}`, style: { width: '128px', flex: 'none', opacity: here ? 0.55 : 1 }, onclick: () => !here && openRelease(r) },
        h('div', { class: 'poster', style: { width: '100%' } }, img(r.image), here ? h('div', { class: 'player-msg', style: { background: 'rgba(0,0,0,.5)', whiteSpace: 'pre-line', fontWeight: 500 } }, 'Вы\nздесь') : null),
        h('div', { class: 't clamp2', style: { fontSize: '13px' } }, r.title_ru || t('unnamed')),
        h('div', { class: 'meta' }, [r.year ? `${r.year} год` : '', r.category?.name, r.vote_count > 50 ? `★ ${gradeText(r.grade)}` : ''].filter(Boolean).join(' • ')));
      cards.push(instant ? markAppeared(card) : card);
    });
    strip.replaceChildren(...cards);
    // к текущему релизу: прокрутка только самой ленты (страница не сдвигается); блок может быть ещё не на странице
    let tries = 60;
    const center = () => {
      const cur = strip.querySelector('.here');
      if (!cur) return;
      if (!strip.isConnected || !strip.clientWidth) { if (tries-- > 0) requestAnimationFrame(center); return; }
      strip.scrollLeft += cur.getBoundingClientRect().left - strip.getBoundingClientRect().left - (strip.clientWidth - cur.offsetWidth) / 2;
    };
    requestAnimationFrame(center);
  };
  paint(first, false);
  // полный список — на место первых трёх, без повторного проявления уже видных карточек
  if (rel.related) loadRelated(rel.related.id).then((all) => { if (all.length > first.length) paint(all, true); }).catch(() => {});
  return h('div', { class: 'card' },
    h('div', { class: 'card-title' }, h('span', { class: 'grow' }, 'Связанные релизы'),
      rel.related ? h('button', { class: 'section-more', onclick: () => navigate('related', { related: rel.related, currentId: rel.id }) }, 'Показать все', icon('ic_chevron_end', 'sm')) : null),
    strip);
}

function recommendedBlock(rel) {
  const list = rel.recommended_releases || [];
  if (!list.length) return null;
  return h('div', { class: 'card' }, h('div', { class: 'card-title' }, 'Рекомендуем также'),
    h('div', { class: 'screens', style: { gap: '14px' } }, list.map((r) => h('div', { class: 'release-card', style: { width: '128px', flex: 'none' }, onclick: () => openRelease(r) },
      h('div', { class: 'poster', style: { width: '100%' } }, img(r.image)), h('div', { class: 't clamp2', style: { fontSize: '13px' } }, r.title_ru || t('unnamed'))))));
}

// первая страница комментариев — с нажатия кнопки мыши: успевает за ожидание перехода, экран — сразу с ними
const preCommentsOf = (rel) => (e) => { if (e.button === 0) import('./comments.js').then((m) => m.prefetchComments('release', rel.id)).catch(() => {}); };
function commentsBlock(rel, rebuild) {
  const preComments = preCommentsOf(rel);
  const card = h('div', { class: 'card', style: { padding: '16px 0 0' } },
    h('div', { class: 'card-title', style: { padding: '0 16px' } }, h('div', { class: 'grow' }, 'Комментарии', h('div', { class: 'muted', style: { fontSize: '13px', fontWeight: 400 } }, 'Популярные и актуальные')),
      h('button', { class: 'section-more', onclick: () => navigate('comments', { kind: 'release', id: rel.id, release: rel }), onpointerdown: preComments }, 'Показать все', icon('ic_chevron_end', 'sm'))));
  // написать — сразу под заголовком, над комментариями
  card.append(commentComposer({
    top: true,
    onSend: async (body) => {
      const r = await A.releaseCommentAdd(rel.id, body);
      if (r.code === 0) { toast('Комментарий отправлен'); const fresh = await A.release(rel.id, true); Object.assign(rel, fresh.release); rebuild(); return true; }
      toast(commentAddError(r.code));
      return false;
    },
  }));
  const list = rel.comments || [];
  if (!list.length) card.append(h('div', { class: 'muted', style: { padding: '8px 16px 12px' } }, 'Еще никто не оставлял комментарии. Будьте первыми!'));
  list.forEach((c) => card.append(commentItem(c, { kind: 'release', release: rel, ownerId: rel.id })));
  return card;
}

// Связанные релизы (франшиза)
// Вся франшиза хронологией: номер по порядку выхода и год на линии слева, текущий релиз выделен,
// список открывается на нём
registerScreen('related', ({ related, currentId }) => {
  let tries = 60;
  const toCurrent = () => {
    const cur = list.querySelector('.chain-row.current');
    // кадр спустя после показа: роутер в первом кадре выставляет прокрутку экрана
    if (cur?.isConnected) requestAnimationFrame(() => requestAnimationFrame(() => cur.scrollIntoView({ block: 'center' })));
    else if (tries-- > 0) requestAnimationFrame(toCurrent);
  };
  const list = pagedList({
    load: (page) => A.related(related.id, page),
    onFirst: () => requestAnimationFrame(toCurrent),
    render: (r, i) => h('div', { class: `chain-row ${r.id === currentId ? 'current' : ''}` },
      h('div', { class: 'chain-rail' }, h('div', { class: 'chain-mark' },
        h('span', { class: 'chain-num', title: r.id === currentId ? 'Вы здесь' : null }, String(i + 1)),
        r.year ? h('span', { class: 'chain-year' }, String(r.year)) : null)),
      releaseRow(r)),
  });
  return h('div', null,
    backToolbar(related.name_ru || related.name || 'Связанные релизы'),
    related.description ? h('div', { class: 'muted', style: { padding: '0 var(--gutter) 10px' } }, related.description) : null,
    list);
});

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

// Видео релиза. В ленте (hscroll) карточка 260px; в сетке — по ширине колонки (фиксированная ширина вылезала
// в соседние колонки: карточки и подписи накладывались)
function videoCard(v, { grid = false } = {}) {
  return h('div', { class: 'release-card', style: grid ? { minWidth: '0' } : { width: '260px', flex: 'none' }, onclick: () => playVideo(v) },
    // превью не загрузилось (Sibnet закрыт для IP вне России) — вместо сломанной картинки название сайта (app.css, .vid-poster)
    h('div', { class: 'poster vid-poster', 'data-host': videoHost(v), style: { aspectRatio: '16/9', width: '100%' } }, img(v.image), v.hosting?.icon ? h('img', { src: v.hosting.icon, referrerpolicy: 'no-referrer', alt: '', onerror: (e) => e.currentTarget.remove(), style: { position: 'absolute', right: '8px', bottom: '8px', width: '22px', height: '22px' } }) : null),
    h('div', { class: 't clamp2' }, v.title), h('div', { class: 'meta clamp2' }, [v.category?.name, v.profile?.login, relTime(v.timestamp)].filter(Boolean).join(' • ')));
}
const gridVideoCard = (v) => videoCard(v, { grid: true });
// сайт видео: название хостинга от сервера, а «Неизвестно» — по адресу (video.sibnet.ru → sibnet.ru)
function videoHost(v) {
  if (v.hosting?.name && v.hosting.name !== 'Неизвестно') return v.hosting.name;
  try { return new URL(v.player_url || v.url).host.replace(/^(www|video)\./, ''); } catch { return 'Видео'; }
}
// Не YouTube — сначала спрашиваем, открывается ли (сервер, /probe): Sibnet целиком закрыт для IP вне России, и вместо
// белой страницы «403 Forbidden» объясняем, в чём дело
async function playVideo(v) {
  const url = v.player_url || v.url;
  if (!/(^|\.)(youtube\.com|youtu\.be)\//i.test(url.replace(/^https?:\/\//, ''))) {
    const p = await fetch(`/probe?url=${encodeURIComponent(url)}`).then((r) => r.json()).catch(() => null);
    if (p && (p.status === 403 || p.status === 451)) {
      dialog({ title: 'Видео не открывается', content: h('p', null, `${p.host || videoHost(v)} не пускает из вашей страны — сайт отвечает «доступ запрещён». Откройте видео с VPN или выберите другое.`), actions: [{ label: t('close'), primary: true }] });
      return;
    }
  }
  const { openWebPlayer } = await import('../player.js');
  openWebPlayer({ url, iframe: false, name: v.title }, { title_ru: v.release?.title_ru || v.title });
}
registerScreen('release-videos', async ({ release, categoryId, categoryName }) => {
  const root = h('div', null, backToolbar(categoryName || 'Видео'));
  if (categoryId) {
    root.append(pagedList({ skeleton: 'collections', load: (page) => A.videoCategory(release.id, categoryId, page), render: gridVideoCard, grid: true }));
    return root;
  }
  const r = await A.videoMain(release.id);
  for (const b of r.blocks || []) {
    root.append(sectionHead(b.category?.name || 'Видео', (b.videos || []).length >= 25 ? () => navigate('release-videos', { release, categoryId: b.category.id, categoryName: b.category.name }) : null));
    root.append(h('div', { class: 'hscroll' }, (b.videos || []).map((v) => videoCard(v))));
  }
  root.append(sectionHead('Последние видео'));
  root.append(pagedList({ skeleton: 'collections', load: (page) => A.videos(release.id, page), render: gridVideoCard, grid: true, empty: () => emptyView('Видео пока нет') }));
  return root;
}, ({ categoryName, categoryId }) => [backToolbar(categoryName || 'Видео'), categoryId ? skeleton('collections') : skeleton('videos')]);

