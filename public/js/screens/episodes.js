// Озвучки, источники и серии; выбор плеера
import { h, icon, iconButton, img, toast, dialog, sheet, errorView, emptyView, skeleton, skParts, skeletonSettled, markAppeared } from '../ui.js';
import { A, auth } from '../api.js';
import { t, prefs, db } from '../store.js';
import { registerScreen, replace } from '../router.js';
import { backToolbar, digits } from './common.js';
import { resolveEpisode, openBuiltinPlayer, openWebPlayer, openThirdParty } from '../player.js';
import { party, canControl } from '../party/room.js';
import { partyPick, queueAdd, suggestMode, partyInfo } from '../party/ui.js';

const epSort = () => Number(localStorage.getItem('anixart.pref.EPISODES_SORT') || 1);
const sortIcon = (sort) => (sort === 1 ? 'ic_sort_ascending' : 'ic_sort_descending');
const epContainer = (...c) => h('div', { class: 'container', style: { padding: 0, maxWidth: '900px' } }, ...c);

// --- Озвучки, источники, серии: запрос заранее ---
// Страница релиза запрашивает их в фоне (prefetchWatch): «Воспроизвести» открывает экран быстрее, а пока он
// грузится, скелетон уже знает, чем экран станет — списком озвучек, источников или серий.
// Озвучки и источники живут минуту; серии — до первого показа (отметки просмотра должны быть свежими).
const CACHE_TTL = 60000;
const cache = new Map(); // ключ → { promise, value, at }
function cached(key, load) {
  let c = cache.get(key);
  if (!c || c.failed || performance.now() - c.at > CACHE_TTL) {
    c = { at: performance.now(), value: undefined, failed: false };
    c.promise = load().then((v) => { c.value = v; return v; }, (e) => { c.failed = true; throw e; });
    cache.set(key, c);
  }
  return c;
}
const peek = (key) => { const c = cache.get(key); return c && !c.failed && performance.now() - c.at <= CACHE_TTL ? c.value : undefined; };
const typesOf = (rid) => cached(`t${rid}`, () => A.types(rid).then((r) => r.types || [])).promise;
const sourcesOf = (rid, tid) => cached(`s${rid}:${tid}`, () => A.sources(rid, tid).then((r) => r.sources || [])).promise;
const episodesKey = (rid, tid, sid, sort) => `e${rid}:${tid}:${sid}:${sort}`;
function takeEpisodes(rid, tid, sid, sort) {
  const key = episodesKey(rid, tid, sid, sort);
  const p = cached(key, () => A.episodes(rid, tid, sid, sort)).promise;
  cache.delete(key);
  return p;
}

// Автопереход: запомненные озвучка/источник (IS_REMEMBERING_TYPE_SOURCE) или единственный вариант
function autoType(release, types, pick) {
  if (pick) return null;
  const last = prefs.get('IS_REMEMBERING_TYPE_SOURCE') ? db.lastWatched(release.id) : null;
  const ty = last && types.find((x) => x.id === last.typeId);
  if (ty) return { type: ty, sourceId: last.sourceId };
  return types.length === 1 ? { type: types[0], sourceId: null } : null;
}
function autoSource(sources, sourceId, pick) {
  if (pick) return null;
  return (sourceId && sources.find((s) => s.id === sourceId)) || (sources.length === 1 ? sources[0] : null);
}

// Со страницы релиза: озвучки, источники выбранной озвучки и её серии — к нажатию «Воспроизвести»
export function prefetchWatch(release) {
  typesOf(release.id).then((types) => {
    const at = autoType(release, types, false);
    if (!at) return;
    return sourcesOf(release.id, at.type.id).then((sources) => {
      const s = autoSource(sources, at.sourceId, false);
      if (s) cached(episodesKey(release.id, at.type.id, s.id, epSort()), () => A.episodes(release.id, at.type.id, s.id, epSort()));
    });
  }).catch(() => {});
}

// Каким станет экран: { kind: 'types' | 'sources' | 'episodes', type, source }. Из уже известных
// (запрошенных заранее) озвучек и источников; чего ещё нет — угадываем по запомненному выбору.
function predict({ release, type, source, sourceId, pick }) {
  if (type && source) return { kind: 'episodes', type, source };
  let ty = type; let sid = sourceId;
  if (!ty) {
    const types = release && peek(`t${release.id}`);
    if (!types) {
      const last = !pick && release && prefs.get('IS_REMEMBERING_TYPE_SOURCE') ? db.lastWatched(release.id) : null;
      return last ? { kind: 'episodes', type: last.typeName && { name: last.typeName }, source: last.sourceName && { name: last.sourceName } } : { kind: 'types' };
    }
    const at = autoType(release, types, pick);
    if (!at) return { kind: 'types' };
    ty = at.type; sid = at.sourceId;
  }
  const sources = peek(`s${release.id}:${ty.id}`);
  if (!sources) return { kind: 'episodes', type: ty }; // у большинства озвучек один источник
  const s = autoSource(sources, sid, pick);
  return s ? { kind: 'episodes', type: ty, source: s } : { kind: 'sources', type: ty };
}

// Скелетон в раскладке того экрана, которым он станет: серии — та же панель (озвучка • источник,
// сортировка, «Ещё») и та же колонка списка; озвучки и источники — заголовок раздела и строки type-row.
function episodesSkeleton(params) {
  const p = predict(params);
  if (p.kind === 'episodes') {
    const title = p.type?.name && p.source?.name ? `${p.type.name} • ${p.source.name}` : skParts.line('180px', 'title');
    const noop = () => {};
    return [backToolbar(title, [iconButton(sortIcon(epSort()), 'Сортировка', noop), iconButton('ic_more', 'Ещё', noop)]), epContainer(skeleton('episodes'))];
  }
  const bar = backToolbar(p.kind === 'sources' ? p.type.name : params.release?.title_ru || t('unnamed'));
  return [bar, h('div', { class: 'section-head' }, skParts.line('170px', 'title', { height: '20px' })), skeleton('types', 4)];
}

// Экран 1: варианты озвучки (types). Автопереход к запомненным или единственным озвучке/источнику
// идёт внутри этого же экрана: один скелетон на весь путь до серий, без промежуточных экранов
registerScreen('episodes', async ({ release, type, source, sourceId, pick }, ctx) => {
  if (type && source) return episodesList(release, type, source, ctx);
  if (type) return sourcesList(release, type, sourceId, pick, ctx);
  const types = await typesOf(release.id);
  const at = autoType(release, types, pick);
  if (at) return sourcesList(release, at.type, at.sourceId, false, ctx);
  const root = h('div', null, backToolbar(release.title_ru || t('unnamed')));
  if (!types.length) { root.append(emptyView('Серии пока не добавлены')); return root; }
  root.append(h('div', { class: 'section-head' }, h('div', { class: 'section-title' }, 'Выберите озвучку')));
  root.append(h('div', { class: 'list' }, types.map((ty) => h('div', { class: 'type-row', onclick: () => ctxNavigate(release, ty) },
    ty.icon ? img(ty.icon) : h('div', { class: 'ph' }, icon(ty.is_sub ? 'ic_text_search_variant' : 'ic_voice')),
    h('div', { class: 'grow' },
      h('div', { style: { fontWeight: 500 } }, ty.name, ty.pinned ? icon('ic_pin', 'xs') : null),
      h('div', { class: 'muted', style: { fontSize: '13px' } }, [ty.workers, ty.episodes_count != null ? `${ty.episodes_count} эп.` : "", ty.view_count ? `${digits(ty.view_count)} просмотров` : ''].filter(Boolean).join(' • '))),
    icon('ic_chevron_end')))));
  return root;
}, episodesSkeleton);

function ctxNavigate(release, type) {
  import('../router.js').then(({ navigate }) => navigate('episodes', { release, type }));
}

async function sourcesList(release, type, sourceId, pick, ctx) {
  const sources = await sourcesOf(release.id, type.id);
  const auto = autoSource(sources, sourceId, pick);
  if (auto) return episodesList(release, type, auto, ctx);
  const root = h('div', null, backToolbar(type.name));
  if (!sources.length) { root.append(emptyView('Источники не найдены')); return root; }
  root.append(h('div', { class: 'section-head' }, h('div', { class: 'section-title' }, 'Выберите источник')));
  root.append(h('div', { class: 'list' }, sources.map((s) => h('div', {
    class: 'type-row',
    onclick: () => import('../router.js').then(({ navigate }) => navigate('episodes', { release, type, source: s })),
  }, h('div', { class: 'ph' }, icon('ic_source')), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 500 } }, s.name), h('div', { class: 'muted', style: { fontSize: '13px' } }, s.episodes_count != null ? `${s.episodes_count} эп.` : "")), icon('ic_chevron_end')))));
  return root;
}

async function episodesList(release, type, source, ctx) {
  let sort = epSort();
  const root = h('div');
  const listEl = h('div', { class: 'ep-list' });
  let episodes = [];

  let instant = false; // серии сменили видимый скелетон — ставим сразу, без проявления
  let firstLoad = true; // первая загрузка берёт серии, запрошенные заранее со страницы релиза
  async function load() {
    listEl.replaceChildren(skeleton('episodes'));
    try {
      const r = await (firstLoad ? takeEpisodes(release.id, type.id, source.id, sort) : A.episodes(release.id, type.id, source.id, sort));
      firstLoad = false;
      episodes = r.episodes || [];
      instant = await skeletonSettled(listEl);
    } catch (e) { await skeletonSettled(listEl); listEl.replaceChildren(errorView(e, load)); return; }
    // Слияние с локальной БД
    const local = db.watchedOf(release.id, source.id);
    for (const ep of episodes) {
      ep.releaseId = release.id; ep.sourceId = source.id;
      if (auth.loggedIn) {
        if (ep.is_watched && !(ep.position in local)) db.putEpisode(release.id, source.id, ep.position, { isWatched: true });
        if (!ep.is_watched && ep.position in local) db.putEpisode(release.id, source.id, ep.position, { isWatched: false, playbackPosition: 0 });
      } else ep.is_watched = ep.position in local;
    }
    paint({ first: true });
  }

  // first — первая отрисовка после загрузки: строки проявляются (если не сменили видимый скелетон),
  // список прокручивается к последней просмотренной. Повторные (отметка, запуск серии) меняют строки
  // разом и без анимации, прокрутка остаётся на месте — иначе список мигает и прыгает.
  function paint({ first = false } = {}) {
    if (!episodes.length) { listEl.replaceChildren(emptyView('Серии не найдены')); return; }
    let lastIdx = -1;
    episodes.forEach((ep, i) => { if (ep.is_watched) lastIdx = i; });
    const rows = episodes.map((ep, i) => {
      const row = h('div', { class: `ep-row ${ep.is_watched ? 'watched' : ''} ${i === lastIdx ? 'last' : ''}`, onclick: () => onEpisode(i) },
        h('div', { class: 'num' }, ep.is_watched ? icon('ic_check', 'sm') : String(ep.position)),
        h('div', { class: 'grow' },
          h('div', { style: { fontWeight: 500 } }, ep.name || `${ep.position} серия`, ep.is_filler ? h('span', { class: 'badge', style: { marginLeft: '8px' } }, 'филлер') : null),
          h('div', { class: 'muted', style: { fontSize: '12px' } }, [source.name, ep.addedDate ? new Date(ep.addedDate * 1000).toLocaleDateString('ru-RU') : ''].filter(Boolean).join(' • '))),
        iconButton(ep.is_watched ? 'ic_eye_off_outline' : 'ic_eye_outline', ep.is_watched ? 'Снять отметку' : 'Отметить просмотренной', (e) => { e.stopPropagation(); toggleWatched(ep); }, 'sm'));
      return first && !instant ? row : markAppeared(row);
    });
    listEl.replaceChildren(...rows);
    instant = false;
    if (!first) return;
    // к последней просмотренной; после первой загрузки список попадает на страницу чуть позже
    const last = listEl.querySelector('.ep-row.last');
    if (!last) return;
    let tries = 60;
    const scroll = () => { if (last.isConnected) last.scrollIntoView({ block: 'center' }); else if (tries-- > 0) requestAnimationFrame(scroll); };
    requestAnimationFrame(scroll);
  }

  async function toggleWatched(ep) {
    const v = !ep.is_watched;
    if (auth.loggedIn) {
      try { await (v ? A.episodeWatch(release.id, source.id, ep.position) : A.episodeUnwatch(release.id, source.id, ep.position)); } catch { /* ignore */ }
    }
    db.putEpisode(release.id, source.id, ep.position, v ? { isWatched: true } : { isWatched: false, playbackPosition: 0 });
    ep.is_watched = v;
    paint();
  }

  async function markAll(v) {
    if (auth.loggedIn) {
      try { await (v ? A.episodeWatch(release.id, source.id) : A.episodeUnwatch(release.id, source.id)); } catch { /* ignore */ }
    }
    db.setAllWatched(release.id, source.id, episodes.map((e) => e.position), v);
    episodes.forEach((e) => { e.is_watched = v; });
    paint();
  }

  async function onEpisode(i) {
    const ep = episodes[i];
    if (!prefs.get('ON_EPISODE_DISCLAIMER')) {
      const ok = await new Promise((resolve) => dialog({
        title: 'Внимание', content: h('p', null, t('on_episode_disclaimer')),
        actions: [{ label: 'Отмена', onClick: () => resolve(false) }, { label: 'Понятно', primary: true, onClick: () => { prefs.set('ON_EPISODE_DISCLAIMER', true); resolve(true); } }],
        onClose: () => resolve(false),
      }));
      if (!ok) return;
    }
    // В комнате совместного просмотра — встроенный плеер (синхронизируется только он); серия другого аниме или
    // озвучки — «включить для всех» или в очередь «Дальше» (party/ui.js)
    if (party.room) {
      const content = { releaseId: release.id, typeId: type.id, sourceId: source.id, position: ep.position, sort,
        title: release.title_ru || release.title_original || '', image: release.image || '', dub: type.name || '', epName: ep.name || `${ep.position} серия` };
      // в комнате ничего не идёт — серия включается сразу (очередь нужна, только когда что-то уже смотрят);
      // иначе «Предложить …» — сразу в очередь, а без него — спросить
      const idle = !party.room.state?.content;
      const how = idle && canControl() ? 'play' : party.intent?.queue ? 'queue' : await partyPick(content);
      suggestMode(false);
      if (!how) return;
      if (how === 'queue') { queueAdd(content); partyInfo(`Добавлено в очередь «Дальше»: ${content.title} · ${content.epName}`); return; }
      play(i, 2);
      return;
    }
    let player = prefs.get('SELECTED_PLAYER');
    if (player === 0) player = await choosePlayer();
    if (!player) return;
    play(i, player);
  }

  async function play(i, player) {
    const ep = episodes[i];
    // До начала воспроизведения
    db.addLastWatched(release.id, type.id, source.id, ep.position, { typeName: type.name, sourceName: source.name });
    if (auth.loggedIn) {
      A.historyAdd(release.id, source.id, ep.position).then(() => { release.is_viewed = true; release.last_view_episode = ep; release.last_view_timestamp = Math.floor(Date.now() / 1000); }).catch(() => {});
      A.episodeWatch(release.id, source.id, ep.position).catch(() => {});
    }
    db.putEpisode(release.id, source.id, ep.position, { isWatched: true });
    ep.is_watched = true;
    paint();
    if (player === 1) { openWebPlayer(ep, release, type.name); return; }
    // Встроенный / сторонний: episode/target → парсер. Пока готовится ссылка — спиннер на месте номера
    // нажатой серии (появляется через SK_DELAY, как все индикаторы); повторный клик не запускает вторую загрузку
    if (starting) return;
    starting = true;
    listEl.children[i]?.querySelector('.num')?.replaceChildren(h('div', { class: 'load-reveal' }, h('div', { class: 'spinner' })));
    try {
      const res = await resolveEpisode(ep);
      if (player === 2) openBuiltinPlayer({ release, episodes, index: i, sort, resolved: res, dub: type.name, typeId: type.id });
      else openThirdParty(ep, release, res);
    } catch (e) {
      dialog({
        title: t('error_cannot_launch_player'),
        content: h('p', null, `${t('error_cannot_play_in_selected_player')}`),
        actions: [{ label: t('close') }, { label: t('player_web'), primary: true, onClick: () => openWebPlayer(ep, release, type.name) }],
      });
    } finally { starting = false; paint(); }
  }
  let starting = false;

  // Сортировка — перезагрузка списка на месте, без пересоздания экрана
  const sortButton = () => iconButton(sortIcon(sort), 'Сортировка', (e) => {
    sort = sort === 1 ? 2 : 1;
    localStorage.setItem('anixart.pref.EPISODES_SORT', String(sort));
    e.currentTarget.replaceWith(sortButton());
    load();
  });
  const toolbar = backToolbar(`${type.name} • ${source.name}`, [
    sortButton(),
    iconButton('ic_more', 'Ещё', () => sheet(null, [
      { label: t('watch_marks_add') !== 'watch_marks_add' ? t('watch_marks_add') : 'Отметить все', icon: 'ic_done_all', onClick: () => markAll(true) },
      { label: t('watch_marks_remove') !== 'watch_marks_remove' ? t('watch_marks_remove') : 'Снять все отметки', icon: 'ic_remove_done', onClick: () => markAll(false) },
      { label: 'Сменить озвучку', icon: 'ic_voice', onClick: () => replace('episodes', { release, pick: true }) },
      { label: t('player'), icon: 'ic_play_circle', onClick: () => choosePlayer(true) },
    ])),
  ]);
  root.append(toolbar, epContainer(listEl));
  // первая загрузка — до возврата экрана: пока идёт, на экране остаётся его скелетон из роутера
  await load();
  window.addEventListener('player-closed', function onClose(e) {
    if (!root.isConnected) { window.removeEventListener('player-closed', onClose); return; }
    if (e.detail.releaseId === release.id) { const local = db.watchedOf(release.id, source.id); episodes.forEach((x) => { if (x.position in local) x.is_watched = true; }); paint(); }
  });
  void ctx;
  return root;
}

// Диалог выбора плеера
export function choosePlayer(settingsOnly = false) {
  return new Promise((resolve) => {
    let remember = prefs.get('SELECTED_PLAYER') !== 0;
    const cb = h('input', { type: 'checkbox' }); cb.checked = !remember;
    const items = [
      [2, t('player_embedded'), t('player_embedded_desc'), 'ic_play_circle'],
      [1, t('player_web'), t('player_web_desc'), 'ic_open_in_new'],
      [3, t('player_third_party'), 'mpv или VLC, установленный на компьютере', 'ic_open_link'],
    ];
    let done = false;
    const list = h('div', { class: 'sheet-list' }, items.map(([id, title, desc, ic]) => h('button', {
      class: `sheet-item ${prefs.get('LAST_SELECTED_PLAYER') === id ? 'checked' : ''}`,
      onclick: () => {
        done = true;
        prefs.set('LAST_SELECTED_PLAYER', id);
        prefs.set('SELECTED_PLAYER', cb.checked ? 0 : id);
        d.close();
        resolve(settingsOnly ? null : id);
      },
    }, icon(ic), h('div', { class: 'grow' }, h('div', null, title), h('div', { class: 'muted', style: { fontSize: '12px' } }, desc)))));
    const d = dialog({
      title: t('title_choose_player'), cls: 'sheet',
      content: h('div', null, list, h('label', { class: 'row', style: { padding: '10px 24px 4px' } }, cb, t('player_always_ask'))),
      onClose: () => { if (!done) resolve(null); },
    });
    void remember;
  });
}
