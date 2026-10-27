// Серии аниме — один экран: над списком чипы озвучки, источника и плеера (выпадающие списки, смена на месте),
// а пока озвучка не выбрана — выбор озвучки прямо здесь. Кнопка «Продолжить» на странице аниме (watchBlock)
// запускает серию сразу, минуя этот экран.
import { h, icon, iconButton, img, dialog, sheet, popover, errorView, emptyView, skeleton, skParts, skeletonSettled, markAppeared, nudge } from '../ui.js';
import { A, auth } from '../api.js';
import { t, prefs, db } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { backToolbar, digits } from './common.js';
import { resolveEpisode, prefetchEpisode, openBuiltinPlayer, openWebPlayer, openThirdParty } from '../player.js';
import { eyeIcon } from '../lottie.js';
import { party, canControl, fillersText, roomSkip } from '../party/room.js';
import { partyPick, queueAdd, suggestMode, partyInfo } from '../party/ui.js';
import { has, touch } from '../platform.js';

const epSort = () => Number(localStorage.getItem('anixart.pref.EPISODES_SORT') || 1);
const sortIcon = (sort) => (sort === 1 ? 'ic_sort_ascending' : 'ic_sort_descending');
const epContainer = (...c) => h('div', { class: 'container', style: { padding: 0, maxWidth: '900px' } }, ...c);
const notify = (releaseId) => window.dispatchEvent(new CustomEvent('watch-changed', { detail: { releaseId } }));

// --- Озвучки, источники, серии: запрос заранее ---
// Страница релиза запрашивает их в фоне (prefetchWatch): экран серий открывается быстрее, а пока он грузится,
// скелетон уже знает, чем экран станет — списком серий с чипами или выбором озвучки.
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
export const typesOf = (rid) => cached(`t${rid}`, () => A.types(rid).then((r) => r.types || [])).promise;
const sourcesOf = (rid, tid) => cached(`s${rid}:${tid}`, () => A.sources(rid, tid).then((r) => r.sources || [])).promise;
const episodesKey = (rid, tid, sid, sort) => `e${rid}:${tid}:${sid}:${sort}`;
const episodesOf = (rid, tid, sid, sort) => cached(episodesKey(rid, tid, sid, sort), () => A.episodes(rid, tid, sid, sort)).promise;
function takeEpisodes(rid, tid, sid, sort) {
  const p = episodesOf(rid, tid, sid, sort);
  cache.delete(episodesKey(rid, tid, sid, sort));
  return p;
}

// --- Качество источника ---
// Проверено на сериях: Kodik отдаёт до 720p; Libria (AniLibria), Liberty (AniLiberty — она же, новое название) и
// TSM (Творческая студия МИР) — до 1080p. Остальные — каким оказалось при запуске
const SOURCE_QUALITY = { Kodik: '720p', Libria: '1080p', Liberty: '1080p', TSM: '1080p' };
const Q_RANK = ['360p', '480p', '720p', '1080p', '1440p', '2160p'];
export const qualityOf = (name) => SOURCE_QUALITY[name] || db.sourceQuality(name) || null;
// Лучшие источники — первыми: по качеству; пустые (0 серий) — в конце
function sortSources(sources) {
  const rank = (s) => (s.episodes_count === 0 ? -10 : Q_RANK.indexOf(qualityOf(s.name)));
  return sources.slice().sort((a, b) => rank(b) - rank(a));
}

// --- Последняя серия: своя или с сервера Anixart ---
// Сервер помнит последнюю серию аниме (last_view_episode) — и просмотренную на телефоне. Если там новее, чем
// на этом компьютере, берём её номер и озвучку; минуты внутри серии сервер не хранит — они только свои
export function lastOf(release) {
  const local = db.lastWatched(release.id);
  const ep = release.last_view_episode; const at = release.last_view_timestamp || 0;
  // источник бывает объектом или только номером; озвучки сервер может не прислать — тогда известен лишь номер серии
  const src = ep && typeof ep === 'object' && ep.source && typeof ep.source === 'object' ? ep.source : null;
  const sourceId = ep && typeof ep === 'object' ? ep.sourceId ?? src?.id ?? (typeof ep.source === 'number' ? ep.source : null) : null;
  if (ep && typeof ep === 'object' && ep.position != null && (!local || at > (local.timestamp || 0) + 60)) {
    const ty = src?.type && typeof src.type === 'object' ? src.type : null;
    const same = local && local.sourceId === sourceId;
    return { releaseId: release.id, typeId: ty?.id ?? (same ? local.typeId : null), sourceId, position: ep.position,
      typeName: ty?.name ?? (same ? local.typeName : null), sourceName: src?.name ?? (same ? local.sourceName : null), typeIcon: ty?.icon, timestamp: at, remote: true };
  }
  return local;
}

// --- Запомненный выбор: озвучка и источник аниме (чипы, последняя серия) ---
// с другого устройства новее — его озвучка; иначе выбранная чипом (или последней серией) здесь
function choiceOf(release) {
  const last = lastOf(release);
  if (last?.remote && last.typeId && last.sourceId) return last;
  return db.choice(release.id) || (last?.typeId ? last : null);
}
const remembered = (release) => (prefs.get('IS_REMEMBERING_TYPE_SOURCE') ? choiceOf(release) : null);
function autoType(release, types, pick) {
  if (pick) return null;
  const r = remembered(release);
  const ty = r && types.find((x) => x.id === r.typeId);
  if (ty) return { type: ty, sourceId: r.sourceId };
  return types.length === 1 ? { type: types[0], sourceId: null } : null;
}
const pickSource = (sources, sourceId) => sources.find((s) => s.id === sourceId) || sortSources(sources)[0] || null;

// Отметки «просмотрено» с сервера (по источнику: там же и отметки с телефона) — в локальную БД. Новая отметка
// запоминает, когда пришла (markedAt): так resumeOf отличает «досмотрели на телефоне» от давних отметок
export function mergeServerMarks(rid, sourceId, episodes) {
  if (!auth.loggedIn) return;
  const local = db.watchedOf(rid, sourceId);
  const now = Math.floor(Date.now() / 1000);
  for (const ep of episodes) {
    if (ep.is_watched && !(ep.position in local)) db.putEpisode(rid, sourceId, ep.position, { isWatched: true, markedAt: now });
    if (!ep.is_watched && ep.position in local) db.putEpisode(rid, sourceId, ep.position, { isWatched: false, playbackPosition: 0 });
  }
}

// --- Прогресс: какую серию предлагать ---
// Начатую — пока не досмотрена, досмотренную — следующую (db.progress: эндинг, конец файла или «⏭»).
// Дальше последней серии есть отметки «просмотрено» не отсюда (досмотрели на телефоне в официальном приложении —
// отметки приходят с сервера, а последнюю серию оно не обновляет) — следующую после самой дальней из них.
// Последней серии нет вовсе (ни здесь, ни на сервере), а отметки есть — так же: следующую после самой дальней
export function resumeOf(release) {
  const last = lastOf(release);
  if (!last) {
    const ch = db.choice(release.id);
    const pos = db.markedAfter(release.id, 0, 0, ch?.sourceId);
    return pos ? { last: { releaseId: release.id, ...ch, position: pos, timestamp: 0, elsewhere: true }, progress: null, finished: true, target: pos + 1 } : null;
  }
  const ahead = db.markedAfter(release.id, last.position, last.timestamp || 0, last.sourceId);
  if (ahead) return { last: { ...last, position: ahead, elsewhere: true }, progress: null, finished: true, target: ahead + 1 };
  const progress = db.progress(release.id, last.sourceId, last.position);
  const finished = !!progress?.finished;
  return { last, progress, finished, target: finished ? last.position + 1 : last.position };
}
// Следующая серия после pos: при «Пропускать филлеры» — первая не филлерная (если такая есть).
// episodes — список источника (null — ещё не загружен: просто следующий номер)
export function nextPlayable(episodes, pos) {
  if (!episodes) return { pos: pos + 1, skipped: 0 };
  const after = episodes.filter((e) => e.position > pos).sort((a, b) => a.position - b.position);
  if (!after.length) return { pos: pos + 1, skipped: 0 };
  if (!(party.room ? roomSkip('filler') : prefs.get('SKIP_FILLERS'))) return { pos: after[0].position, skipped: 0 }; // в комнате — её настройка
  const i = after.findIndex((e) => !e.is_filler);
  return i < 0 ? { pos: after[0].position, skipped: 0 } : { pos: after[i].position, skipped: i };
}
const skippedLine = (n) => (n ? `пропустим ${fillersText(n)}` : '');
export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600); const m = Math.floor(s / 60) % 60;
  return `${hh ? `${hh}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
}
const leftMin = (p) => Math.max(1, Math.round((p.dur - p.pos) / 60000));
const watchedLine = (p) => (p.dur ? `остановились на ${fmtTime(p.pos)} из ${fmtTime(p.dur)}` : `остановились на ${fmtTime(p.pos)}`);

// --- Плееры: от лучшего качества к худшему ---
// Встроенный и сторонний получают одни и те же потоки источника; встроенный ещё и улучшает картинку до 4K.
// На Android нет ни апскейла с ПК, ни стороннего плеера (platform.js)
const PLAYERS = [
  has.upscale ? { id: 2, icon: 'ic_play_circle', name: () => t('player_embedded'), sub: 'Улучшение картинки нейросетью до 4K', badge: (q) => (q ? `${q} → 4K` : 'до 4K'), hi: true }
    : { id: 2, icon: 'ic_play_circle', name: () => t('player_embedded'), sub: 'Плеер приложения: пропуски, скорость, звук', badge: (q) => q, hi: true },
  has.externalPlayer ? { id: 3, icon: 'ic_open_link', name: () => t('player_third_party'), sub: 'mpv или VLC, установленный на компьютере', badge: (q) => q } : null,
  { id: 1, icon: 'ic_open_in_new', name: () => t('player_web'), sub: 'Плеер источника, качество выбирает сайт', badge: () => 'как на сайте' },
].filter(Boolean);
const playerName = (id) => (PLAYERS.find((p) => p.id === id)?.name() || 'Спрашивать');

// Логотип озвучки: картинка или круг с иконкой (субтитры — своя)
export const typeLogo = (ty, cls = '') => (ty?.icon ? img(ty.icon, `ty-logo ${cls}`) : h('span', { class: `ty-logo ph ${cls}` }, icon(ty?.is_sub ? 'ic_text_search_variant' : 'ic_voice', 'sm')));
export const typeMeta = (ty) => [ty.workers, ty.episodes_count != null ? `${ty.episodes_count} эп.` : '', ty.view_count ? `${digits(ty.view_count)} просмотров` : ''].filter(Boolean).join(' • ');
const qBadge = (q, hi = false) => (q ? h('span', { class: `q-badge ${hi ? 'hi' : ''}` }, q) : null);
export const checkMark = (on) => h('span', { class: 'pop-check' }, on ? icon('ic_check', 'sm') : null);

// Выбор плеера в выпадающем меню (чип над серий и в плеере): запоминается сразу
// В комнате совместного просмотра — только встроенный (синхронизируется он): остальные видны, но неактивны, с пояснением;
// свой выбор не меняется и снова действует после выхода из комнаты
export function playerMenuItems(source, onPick) {
  const q = source ? qualityOf(source.name) : null;
  const room = !!party.room;
  const cur = room ? 2 : prefs.get('SELECTED_PLAYER');
  return [
    room ? h('div', { class: 'pop-note pop-room' }, icon('ic_group', 'sm'), h('span', null, 'В совместном просмотре — только встроенный плеер: синхронизируется он. ',
      prefs.get('SELECTED_PLAYER') !== 2 ? `Ваш выбор (${playerName(prefs.get('SELECTED_PLAYER'))}) вернётся после выхода из комнаты.` : '')) : null,
    ...PLAYERS.map((p) => h('button', {
      class: `pop-item ${cur === p.id ? 'on' : ''}`, role: 'menuitemradio', 'aria-checked': String(cur === p.id), disabled: room && p.id !== 2,
      onclick: () => { if (room) { onPick(null); return; } prefs.set('SELECTED_PLAYER', p.id); prefs.set('LAST_SELECTED_PLAYER', p.id); onPick(p.id); },
    }, icon(p.icon), h('span', { class: 'grow' }, h('span', { class: 'pop-title' }, p.name()), h('span', { class: 'pop-sub' }, p.sub)),
    qBadge(p.badge(q), p.hi), checkMark(cur === p.id))),
    source ? h('div', { class: 'pop-note' }, q ? `Качество задаёт источник: ${source.name} — до ${q}` : `Качество источника ${source.name} станет известно после запуска серии`) : null,
  ];
}

// Серии другой озвучки (переключатель в плеере): источник — запомненный для неё или лучший
export async function episodesOfType(release, ty, sort = epSort()) {
  const sources = await sourcesOf(release.id, ty.id);
  const ch = db.choice(release.id);
  const source = pickSource(sources, ch?.typeId === ty.id ? ch.sourceId : null);
  if (!source) return null;
  const r = await A.episodes(release.id, ty.id, source.id, sort);
  return { source, episodes: r.episodes || [] };
}

// Со страницы релиза: озвучки, источники выбранной озвучки и её серии — к открытию экрана серий
export function prefetchWatch(release) {
  typesOf(release.id).then((types) => {
    const at = autoType(release, types, false);
    if (!at) return;
    return sourcesOf(release.id, at.type.id).then((sources) => {
      const s = pickSource(sources, at.sourceId);
      if (s) episodesOf(release.id, at.type.id, s.id, epSort());
    });
  }).catch(() => {});
}

// --- Запуск серии ---
// Отметка «просмотрено», история и последняя серия ставятся при запуске (как в мобильном Anixart), затем плеер.
// В комнате совместного просмотра — встроенный плеер (синхронизируется только он) или очередь «Дальше».
// startAt (мс) — продолжить с этого места без вопроса «Продолжить?»; busy(true/false) — пока готовится ссылка
export async function startEpisode({ release, type, source, episodes, index, sort = epSort(), startAt, busy }) {
  const ep = episodes[index];
  if (!ep) return;
  let player;
  if (party.room) {
    // серия другого аниме или озвучки — «включить для всех» или в очередь «Дальше» (party/ui.js); в комнате, где
    // ничего не идёт, серия включается сразу; «Предложить …» — сразу в очередь
    const content = { releaseId: release.id, typeId: type.id, sourceId: source.id, position: ep.position, sort,
      title: release.title_ru || release.title_original || '', image: release.image || '', dub: type.name || '', epName: ep.name || `${ep.position} серия` };
    const idle = !party.room.state?.content;
    const how = idle && canControl() ? 'play' : party.intent?.queue ? 'queue' : await partyPick(content);
    suggestMode(false);
    if (!how) return;
    if (how === 'queue') { queueAdd(content); partyInfo(`Добавлено в очередь «Дальше»: ${content.title} · ${content.epName}`); return; }
    player = 2; // startAt — комната продолжит с этого места у всех (player.js → playerEpisode)
  } else {
    player = prefs.get('SELECTED_PLAYER');
    if (player === 0) player = await choosePlayer();
    if (!player) return;
  }
  ep.releaseId = release.id; ep.sourceId = source.id;
  db.addLastWatched(release.id, type.id, source.id, ep.position, { typeName: type.name, sourceName: source.name, typeIcon: type.icon });
  if (auth.loggedIn) {
    A.historyAdd(release.id, source.id, ep.position).then(() => { release.is_viewed = true; release.last_view_episode = ep; release.last_view_timestamp = Math.floor(Date.now() / 1000); }).catch(() => {});
    A.episodeWatch(release.id, source.id, ep.position).catch(() => {});
  }
  db.putEpisode(release.id, source.id, ep.position, { isWatched: true, startedAt: Date.now() }); // запускали здесь — не «с другого устройства» (resumeOf)
  ep.is_watched = true;
  notify(release.id);
  if (player === 1) { openWebPlayer(ep, release, type.name); return; }
  busy?.(true);
  try {
    const res = await resolveEpisode(ep);
    if (player === 2) openBuiltinPlayer({ release, episodes, index, sort, resolved: res, dub: type.name, typeId: type.id, startAt });
    else openThirdParty(ep, release, res, { start: startAt > 0 ? startAt / 1000 : 0 });
  } catch (e) {
    dialog({
      title: t('error_cannot_launch_player'),
      content: h('p', null, `${t('error_cannot_play_in_selected_player')}`),
      actions: [{ label: t('close') }, { label: t('player_web'), primary: true, onClick: () => openWebPlayer(ep, release, type.name) }],
    });
  } finally { busy?.(false); }
}

// --- Кнопка на странице аниме ---
// Не смотрели — «Смотреть» (экран серий). Начали — «Продолжить · N серия»: просмотренная часть кнопки залита,
// справа «ещё 12 мин», рядом «⏭ N+1 серия» (эту отметить досмотренной и включить следующую). Досмотрели —
// «Смотреть N+1 серию». Всё досмотрено — «Смотреть заново» или, пока аниме выходит, «Все серии».
// Серии запомненного источника и ссылка на предлагаемую серию запрашиваются заранее — запуск без ожидания.
export function watchBlock(release, extra) {
  const root = h('div', { class: 'watch' });
  let list = null; let listKey = ''; let starting = false;
  const sort = epSort();
  // серии запомненных озвучки и источника — { type, source, episodes }
  function ensureList() {
    const ch = choiceOf(release);
    if (!ch || !ch.typeId || !ch.sourceId) return Promise.resolve(null);
    const key = `${ch.typeId}:${ch.sourceId}`;
    if (listKey === key && list) return list;
    listKey = key;
    list = episodesOf(release.id, ch.typeId, ch.sourceId, sort).then((r) => (mergeServerMarks(release.id, ch.sourceId, r.episodes || []), { // отметки с телефона — и до экрана серий
      type: { id: ch.typeId, name: ch.typeName || '', icon: ch.typeIcon },
      source: { id: ch.sourceId, name: ch.sourceName || '' },
      episodes: r.episodes || [],
    })).catch(() => null);
    list.then((l) => { if (l && root.isConnected) { known = l; paint(); prefetchTarget(l); } });
    return list;
  }
  let known = null; // загруженный список (для «есть ли следующая серия»)
  function prefetchTarget(l) {
    const r = resumeOf(release);
    const p = prefs.get('SELECTED_PLAYER');
    if (!r || party.room || (p !== 2 && p !== 3)) return;
    const ep = l.episodes.find((e) => e.position === r.target);
    if (ep) prefetchEpisode({ ...ep, releaseId: release.id, sourceId: l.source.id }).catch(() => {});
  }
  // есть ли серия с номером n: по загруженному списку, а до него — по числу вышедших у аниме
  const has = (n) => (known ? known.episodes.some((e) => e.position === n) : n <= (release.episodes_released ?? Infinity));
  const busy = (btn) => (on) => {
    starting = on;
    btn.disabled = on;
    btn.querySelector('.ic')?.replaceWith(on ? h('span', { class: 'load-reveal' }, h('span', { class: 'spinner sm' })) : icon('ic_play'));
  };
  async function go(btn, position, startAt) {
    if (starting) return;
    const l = await ensureList();
    const i = l ? l.episodes.findIndex((e) => e.position === position) : -1;
    if (i < 0) { navigate('episodes', { release }); return; }
    await startEpisode({ release, ...l, index: i, sort, startAt, busy: busy(btn) });
    paint();
  }
  const toEpisodes = () => navigate('episodes', { release });

  function paint() {
    const r = resumeOf(release);
    const ch = choiceOf(release);
    const dubLine = ch ? [ch.typeName, ch.sourceName].filter(Boolean).join(' • ') : '';
    const nx = r ? nextPlayable(known?.episodes || null, r.last.position) : null; // следующая — с учётом филлеров
    if (r?.finished) r.target = nx.pos;
    let main; let next = null; let sub;
    if (!r) {
      main = h('button', { class: 'btn btn-primary lg btn-watch', onclick: toEpisodes }, icon('ic_play'), 'Смотреть');
      const u = release.episode_last_update;
      sub = u ? `Добавлено: ${u.last_episode_update_name || u.episode_name || 'неизвестная серия'} | ${u.lastEpisodeTypeUpdateName || u.last_episode_type_update_name || ''} | ${u.last_episode_source_update_name || ''}` : '';
    } else if (!r.finished) {
      const p = r.progress;
      main = h('button', { class: `btn btn-primary lg btn-watch ${p?.dur ? 'resume' : ''}`, style: p?.dur ? { '--p': `${Math.min(100, (p.pos / p.dur) * 100).toFixed(1)}%` } : null,
        onclick: (e) => go(e.currentTarget, r.last.position, p?.pos || 0) },
      icon('ic_play'), h('span', { class: 'lbl' }, `Продолжить · ${r.last.position} серия`), p?.dur ? h('span', { class: 'left' }, `ещё ${leftMin(p)} мин`) : null);
      if (has(nx.pos)) {
        next = h('button', { class: 'btn btn-tonal lg btn-next', title: `Смотреть ${nx.pos} серию, а ${r.last.position} отметить досмотренной${nx.skipped ? ` (${skippedLine(nx.skipped)})` : ''}`,
          onclick: (e) => { db.putEpisode(release.id, r.last.sourceId, r.last.position, { isWatched: true, finished: true }); return go(e.currentTarget, nx.pos, 0); } },
        icon('ic_player_next'), `${nx.pos} серия`);
      }
      sub = [dubLine, p ? watchedLine(p) : r.last.remote ? 'смотрели на другом устройстве' : ''].filter(Boolean).join(' • ');
    } else if (has(r.target)) {
      main = h('button', { class: 'btn btn-primary lg btn-watch', onclick: (e) => go(e.currentTarget, r.target, 0) }, icon('ic_play'), `Смотреть ${r.target} серию`);
      sub = [`${r.last.position} серия ${r.last.elsewhere ? 'просмотрена' : 'досмотрена'}`, skippedLine(nx.skipped), dubLine].filter(Boolean).join(' • ');
    } else {
      // всё вышедшее досмотрено: пока аниме выходит — ждём новую, иначе пересмотреть с первой
      const airing = (release.status?.id ?? release.status_id) === 2 || (release.episodes_total && release.episodes_released < release.episodes_total);
      if (airing) {
        main = h('button', { class: 'btn btn-primary lg btn-watch', onclick: toEpisodes }, icon('ic_episodes'), 'Все серии');
        sub = `${r.last.position} серия ${r.last.elsewhere ? 'просмотрена' : 'досмотрена'} • следующая ещё не вышла`;
      } else {
        const first = known?.episodes.reduce((m, e) => Math.min(m, e.position), Infinity) ?? 1;
        main = h('button', { class: 'btn btn-primary lg btn-watch', onclick: (e) => go(e.currentTarget, first, 0) }, icon('ic_play'), `Смотреть заново · ${first} серия`);
        sub = ['Все серии просмотрены', dubLine].filter(Boolean).join(' • ');
      }
    }
    const all = r ? h('button', { class: 'btn btn-tonal lg', onclick: toEpisodes }, icon('ic_episodes'), 'Все серии') : null;
    root.replaceChildren(...[ // replaceChildren(null) вставил бы текст «null»
      h('div', { class: 'watch-row' }, main, next, r && !(r.finished && !has(r.target) && main.textContent === 'Все серии') ? all : null, extra),
      sub ? h('div', { class: 'watch-sub' }, sub) : null].filter(Boolean));
  }
  paint();
  if (choiceOf(release)) ensureList();
  // страница аниме может быть скрыта (открыт экран серий) — перерисуется, когда её покажут снова (repaint)
  const onChange = (e) => { if (e.detail?.releaseId === release.id && root.isConnected) { paint(); ensureList(); } };
  window.addEventListener('watch-changed', onChange);
  window.addEventListener('player-closed', onChange);
  root.repaint = () => { paint(); ensureList(); }; // экран аниме показан снова (вернулись назад)
  root.dispose = () => { window.removeEventListener('watch-changed', onChange); window.removeEventListener('player-closed', onChange); };
  return root;
}

// --- Экран серий ---
// Чипы над списком; пока грузится — те же чипы с запомненными названиями (логотип — скелетон) и скелетон списка,
// а при первом просмотре — скелетон выбора озвучки
function chipButton({ cls, label, lead, tail, title, onclick }) {
  return h('button', { class: `wchip ${cls || ''}`, title, 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick }, lead, h('span', { class: 'wchip-lbl' }, label), tail, icon('ic_arrow_drop_down', 'sm'));
}
function playerChip(onclick) {
  // в комнате — встроенный, со значком комнаты (серии в комнате идут только в нём)
  if (party.room) return chipButton({ cls: 'wchip-player in-room', label: playerName(2), lead: icon('ic_group', 'sm'), title: 'В совместном просмотре — только встроенный плеер', onclick });
  const id = prefs.get('SELECTED_PLAYER');
  return chipButton({ cls: 'wchip-player', label: playerName(id), lead: icon(PLAYERS.find((p) => p.id === id)?.icon || 'ic_play_circle', 'sm'), title: 'Плеер', onclick });
}

function predictChoice({ release, type, source, pick }) {
  if (type) return { typeName: type.name, typeIcon: type.icon, sourceName: source?.name };
  if (pick || !release) return null;
  const types = peek(`t${release.id}`);
  const r = remembered(release);
  if (types) {
    const at = autoType(release, types, false);
    return at ? { typeName: at.type.name, typeIcon: at.type.icon, sourceName: r?.typeId === at.type.id ? r.sourceName : null } : null;
  }
  return r ? { typeName: r.typeName, typeIcon: r.typeIcon, sourceName: r.sourceName } : null;
}
function episodesSkeleton(params) {
  const title = params.release?.title_ru || params.release?.title_original || t('unnamed');
  const ch = predictChoice(params);
  const noop = () => {};
  if (ch) {
    const dub = chipButton({ cls: 'wchip-dub', label: ch.typeName || skParts.line('90px'), lead: [icon('ic_voice', 'sm'), skParts.circle('24px')] });
    const src = ch.sourceName ? chipButton({ cls: 'wchip-src', label: ch.sourceName, lead: icon('ic_source', 'sm'), tail: qBadge(qualityOf(ch.sourceName)) }) : null;
    return [backToolbar(title, [iconButton(sortIcon(epSort()), 'Сортировка', noop), iconButton('ic_more', 'Ещё', noop)]),
      epContainer(h('div', { class: 'wchips' }, dub, src, h('div', { class: 'grow' }), playerChip(noop)), skeleton('episodes'))];
  }
  return [backToolbar(title), epContainer(h('div', { class: 'section-head pick-head' }, skParts.col('8px', skParts.line('190px', 'title', { height: '20px' }), skParts.line('380px'))), skeleton('types', 6))];
}

registerScreen('episodes', async (params, ctx) => {
  const { release } = params;
  const rid = release.id;
  let sort = epSort();
  let types = []; let type = null; let sources = []; let source = null; let episodes = [];
  let firstLoad = true; // первая загрузка берёт серии, запрошенные заранее со страницы релиза
  let starting = false;

  const chips = h('div', { class: 'wchips' });
  const listEl = h('div', { class: 'ep-list' });
  const body = h('div');
  const sortButton = () => iconButton(sortIcon(sort), 'Сортировка', (e) => {
    sort = sort === 1 ? 2 : 1;
    localStorage.setItem('anixart.pref.EPISODES_SORT', String(sort));
    e.currentTarget.replaceWith(sortButton());
    loadEpisodes();
  });
  const more = iconButton('ic_more', 'Ещё', () => sheet(null, [
    { label: t('watch_marks_add') !== 'watch_marks_add' ? t('watch_marks_add') : 'Отметить все', icon: 'ic_done_all', onClick: () => markAll(true) },
    { label: t('watch_marks_remove') !== 'watch_marks_remove' ? t('watch_marks_remove') : 'Снять все отметки', icon: 'ic_remove_done', onClick: () => markAll(false) },
  ]));
  const actions = [sortButton(), more];
  const toolbar = backToolbar(release.title_ru || release.title_original || t('unnamed'), actions);
  const showActions = (on) => actions.forEach((a) => { a.hidden = !on; });
  const root = h('div', null, toolbar, epContainer(chips, body));

  // --- Чипы ---
  function paintChips() {
    if (!type) { chips.replaceChildren(); chips.hidden = true; return; }
    chips.hidden = false;
    const dub = chipButton({ cls: 'wchip-dub', label: type.name, lead: [icon('ic_voice', 'sm'), typeLogo(type, 'sm')], title: 'Озвучка', onclick: (e) => openDubMenu(e.currentTarget) });
    // источник виден всегда — откуда видео и в каком качестве, даже когда он у озвучки один
    const src = source ? chipButton({ cls: 'wchip-src', label: source.name, lead: icon('ic_source', 'sm'), tail: qBadge(qualityOf(source.name)), title: 'Источник', onclick: (e) => openSourceMenu(e.currentTarget) }) : null;
    chips.replaceChildren(...[dub, src, h('div', { class: 'grow' }), playerChip((e) => openPlayerMenu(e.currentTarget))].filter(Boolean));
  }
  function openDubMenu(anchor) {
    const listBox = h('div', { class: 'pop-list' });
    const fill = (q) => {
      const s = q.trim().toLowerCase();
      const found = types.filter((ty) => !s || ty.name.toLowerCase().includes(s) || (ty.workers || '').toLowerCase().includes(s));
      listBox.replaceChildren(...(found.length ? found.map((ty) => h('button', {
        class: `pop-item ${ty.id === type.id ? 'on' : ''}`, role: 'menuitemradio', 'aria-checked': String(ty.id === type.id),
        onclick: () => { pop.close(); if (ty.id !== type.id) setType(ty); },
      }, typeLogo(ty), h('span', { class: 'grow' }, h('span', { class: 'pop-title' }, ty.name, ty.pinned ? icon('ic_pin', 'xs') : null), h('span', { class: 'pop-sub' }, typeMeta(ty))),
      checkMark(ty.id === type.id))) : [h('div', { class: 'pop-note' }, 'Ничего не нашлось')]));
    };
    const search = types.length > 6 ? h('input', { class: 'pop-search', placeholder: 'Найти озвучку', 'aria-label': 'Найти озвучку', oninput: (e) => fill(e.target.value) }) : null;
    fill('');
    const pop = popover(anchor, [search, listBox], { cls: 'pop-dub' });
    if (pop && search && !touch) setTimeout(() => search.focus(), 30);
  }
  function openSourceMenu(anchor) {
    const pop = popover(anchor, sortSources(sources).map((s) => h('button', {
      class: `pop-item ${s.id === source.id ? 'on' : ''}`, role: 'menuitemradio', 'aria-checked': String(s.id === source.id),
      onclick: () => { pop.close(); if (s.id !== source.id) setSource(s); },
    }, icon('ic_source'), h('span', { class: 'grow' }, h('span', { class: 'pop-title' }, s.name), h('span', { class: 'pop-sub' }, s.episodes_count != null ? `${s.episodes_count} эп.` : '')),
    qBadge(qualityOf(s.name) && `до ${qualityOf(s.name)}`), checkMark(s.id === source.id))).concat(
      sources.length === 1 ? [h('div', { class: 'pop-note' }, 'Другого источника у этой озвучки нет')] : []));
  }
  function openPlayerMenu(anchor) {
    const pop = popover(anchor, playerMenuItems(source, () => { pop.close(); paintChips(); }), { align: 'end', cls: 'pop-player' });
  }

  // --- Выбор озвучки и источника: на месте, список перерисовывается ---
  const remember = () => { db.setChoice(rid, { typeId: type.id, sourceId: source.id, typeName: type.name, sourceName: source.name, typeIcon: type.icon }); notify(rid); };
  async function setType(ty) {
    type = ty; source = null; sources = [];
    showActions(true);
    paintChips();
    listEl.replaceChildren(skeleton('episodes'));
    body.replaceChildren(listEl);
    try {
      sources = await sourcesOf(rid, ty.id);
    } catch (e) { await skeletonSettled(listEl); listEl.replaceChildren(errorView(e, () => setType(ty))); return; }
    if (type !== ty) return; // успели выбрать другую
    const ch = db.choice(rid);
    source = pickSource(sources, ch?.typeId === ty.id ? ch.sourceId : null);
    if (!source) { paintChips(); await skeletonSettled(listEl); listEl.replaceChildren(emptyView('Источники не найдены')); return; }
    remember();
    paintChips();
    await loadEpisodes();
  }
  function setSource(s) { source = s; remember(); paintChips(); loadEpisodes(); }

  // --- Выбор озвучки при первом просмотре ---
  function paintPicker() {
    type = null; showActions(false); paintChips();
    if (!types.length) { body.replaceChildren(emptyView('Серии пока не добавлены')); return; }
    body.replaceChildren(
      h('div', { class: 'section-head pick-head' }, h('div', { class: 'grow' }, h('div', { class: 'section-title' }, 'Выберите озвучку'),
        h('div', { class: 'muted', style: { fontSize: '14px', marginTop: '2px' } }, 'Запомним выбор — в следующий раз сразу откроются серии. Сменить можно в любой момент.'))),
      h('div', { class: 'list' }, types.map((ty) => h('div', { class: 'type-row', role: 'button', tabindex: '0', onclick: () => setType(ty), onkeydown: (e) => { if (e.key === 'Enter') setType(ty); } },
        typeLogo(ty, 'lg'),
        h('div', { class: 'grow' },
          h('div', { style: { fontWeight: 500 } }, ty.name, ty.pinned ? icon('ic_pin', 'xs') : null),
          h('div', { class: 'muted', style: { fontSize: '13px' } }, typeMeta(ty))),
        icon('ic_chevron_end')))));
  }

  // --- Список серий ---
  let instant = false; // серии сменили видимый скелетон — ставим сразу, без проявления
  let loadSeq = 0;
  async function loadEpisodes() {
    const seq = ++loadSeq;
    const ty = type; const src = source;
    if (!listEl.isConnected || !listEl.querySelector('.sk-root')) listEl.replaceChildren(skeleton('episodes'));
    body.replaceChildren(listEl);
    let r;
    try {
      r = await (firstLoad ? takeEpisodes(rid, ty.id, src.id, sort) : A.episodes(rid, ty.id, src.id, sort));
    } catch (e) { if (seq !== loadSeq) return; await skeletonSettled(listEl); listEl.replaceChildren(errorView(e, loadEpisodes)); return; }
    if (seq !== loadSeq) return; // пока грузилось, выбрали другую озвучку, источник или сортировку
    firstLoad = false;
    episodes = r.episodes || [];
    instant = await skeletonSettled(listEl);
    // Слияние с локальной БД — для этого источника (сервер хранит отметки по источнику)
    for (const ep of episodes) { ep.releaseId = rid; ep.sourceId = src.id; }
    mergeServerMarks(rid, src.id, episodes);
    paint({ first: true });
  }

  // first — первая отрисовка после загрузки: строки проявляются (если не сменили видимый скелетон),
  // список прокручивается к предлагаемой серии. Повторные (отметка, запуск серии) меняют строки разом
  // и без анимации, прокрутка остаётся на месте — иначе список мигает и прыгает.
  function paint({ first = false } = {}) {
    if (!episodes.length) { listEl.replaceChildren(emptyView('Серии не найдены')); return; }
    const watched = db.watchedOfRelease(rid); // отметки общие для аниме: серия просмотрена в любой озвучке
    const r = resumeOf(release);
    if (r?.finished) r.target = nextPlayable(episodes, r.last.position).pos;
    const target = r && episodes.some((e) => e.position === r.target) ? r.target : null;
    const rows = episodes.map((ep, i) => {
      const cur = ep.position === target;
      const isW = !cur && watched.has(ep.position);
      ep.is_watched = watched.has(ep.position);
      const p = cur && !r.finished ? r.progress : null;
      // просмотренная: где остановились, если это известно (смотрели здесь) — «до конца» или «остановились на …»
      const pw = isW ? db.progressAny(rid, ep.position, source.id) : null;
      const sub = cur ? (p ? `${watchedLine(p)[0].toUpperCase()}${watchedLine(p).slice(1)}${p.dur ? ` • осталось ${leftMin(p)} мин` : ''}` : r.finished ? 'Следующая серия' : 'Продолжить отсюда')
        : isW ? ['Просмотрена', pw?.toEnd ? 'до конца' : pw?.pos ? watchedLine(pw) : ''].filter(Boolean).join(' • ')
          : [source.name, ep.addedDate ? new Date(ep.addedDate * 1000).toLocaleDateString('ru-RU') : ''].filter(Boolean).join(' • ');
      const bar = p?.dur ? (p.pos / p.dur) * 100 : pw?.toEnd ? 100 : pw?.dur ? (pw.pos / pw.dur) * 100 : null;
      const row = h('div', { class: `ep-row ${isW ? 'watched' : ''} ${cur ? 'current' : ''}`, 'data-pos': ep.position, onclick: () => onEpisode(i) },
        h('div', { class: 'num' }, isW ? icon('ic_check', 'sm') : String(ep.position)),
        h('div', { class: 'grow' },
          h('div', { class: 'ep-title' }, ep.name || `${ep.position} серия`, ep.is_filler ? h('span', { class: 'badge', style: { marginLeft: '8px' } }, 'филлер') : null),
          h('div', { class: 'ep-sub' }, sub),
          bar != null ? h('div', { class: 'ep-progress' }, h('span', { style: { width: `${Math.min(100, bar).toFixed(1)}%` } })) : null),
        iconButton(ep.is_watched ? 'ic_eye_off_outline' : 'ic_eye_outline', ep.is_watched ? 'Снять отметку' : 'Отметить просмотренной', (e) => { e.stopPropagation(); toggleWatched(ep); }, 'sm'));
      return first && !instant ? row : markAppeared(row);
    });
    listEl.replaceChildren(...rows);
    instant = false;
    if (!first) return;
    // к предлагаемой серии, а если её нет (только отметки — например, с сервера) — к первой непросмотренной после
    // последней просмотренной; после первой загрузки список попадает на страницу чуть позже
    const rowsEls = [...listEl.querySelectorAll('.ep-row')];
    const w = rowsEls.map((x) => x.classList.contains('watched'));
    // по возрастанию — строка после последней просмотренной, по убыванию — перед первой
    const next = sort === 2 ? (w.includes(true) ? Math.max(0, w.indexOf(true) - 1) : -1) : (w.includes(true) ? Math.min(w.lastIndexOf(true) + 1, rowsEls.length - 1) : -1);
    const toRow = listEl.querySelector('.ep-row.current') || rowsEls[next] || null;
    if (!toRow) return;
    // строку ищем по номеру серии на каждом шаге: список могут перерисовать (отметки), пока ждём показа
    const pos = toRow.dataset.pos;
    const row = () => listEl.querySelector(`.ep-row[data-pos="${pos}"]`);
    // экран вставляется на страницу позже (роутер ждёт загрузки) и при показе сам ставит прокрутку в начало —
    // сразу и кадром позже; прокручиваем, когда строка уже на странице, через пару кадров после этого
    const t0 = performance.now(); let frames = 0;
    const scroll = () => {
      if (!row()?.isConnected) { frames = 0; if (performance.now() - t0 < 5000) requestAnimationFrame(scroll); return; }
      if (++frames < 3) { requestAnimationFrame(scroll); return; }
      row().scrollIntoView({ block: 'center' });
    };
    requestAnimationFrame(scroll);
  }

  async function toggleWatched(ep) {
    const v = !ep.is_watched;
    if (v) {
      if (auth.loggedIn) A.episodeWatch(rid, source.id, ep.position).catch(() => {});
      db.putEpisode(rid, source.id, ep.position, { isWatched: true, markedAt: Math.floor(Date.now() / 1000) }); // вручную — «Продолжить» учтёт (resumeOf)
    } else {
      // снять во всех источниках, где она отмечена (и на сервере — там отметки по источнику)
      const srcs = new Set([source.id, ...db.unwatchEverywhere(rid, ep.position)]);
      if (auth.loggedIn) for (const sid of srcs) A.episodeUnwatch(rid, sid, ep.position).catch(() => {});
    }
    paint(); notify(rid);
    // список перерисован целиком — откликается только отмеченная строка: плашка выпрыгивает, галочка прорисовывается
    const num = listEl.querySelector(`.ep-row[data-pos="${ep.position}"] .num`);
    nudge(num, [{ transform: 'scale(.8)' }, { transform: 'scale(1.1)', offset: 0.55 }, { transform: 'none' }], 360);
    if (v) nudge(num?.querySelector('.ic'), [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], 380);
    // глаз на кнопке строки — из прежнего состояния в новое (перечёркивание прорисовывается или убирается)
    const btn = listEl.querySelector(`.ep-row[data-pos="${ep.position}"] > .icon-btn`);
    if (btn?.firstChild) { const eye = eyeIcon(!v); btn.firstChild.replaceWith(eye); eye.set(v); }
  }

  async function markAll(v) {
    if (auth.loggedIn) {
      try { await (v ? A.episodeWatch(rid, source.id) : A.episodeUnwatch(rid, source.id)); } catch { /* ignore */ }
    }
    if (v) db.setAllWatched(rid, source.id, episodes.map((e) => e.position), true);
    else for (const e of episodes) db.unwatchEverywhere(rid, e.position);
    paint(); notify(rid);
  }

  async function onEpisode(i) {
    if (starting) return;
    const numEl = listEl.children[i]?.querySelector('.num');
    await startEpisode({
      release, type, source, episodes, index: i, sort,
      // пока готовится ссылка — спиннер на месте номера (появляется через SK_DELAY); повторный клик не запускает вторую загрузку
      busy: (on) => { starting = on; if (on) numEl?.replaceChildren(h('div', { class: 'load-reveal' }, h('div', { class: 'spinner' }))); else paint(); },
    });
    paint();
  }

  // --- Первая загрузка: до возврата экрана (пока идёт, на экране остаётся его скелетон из роутера) ---
  types = await typesOf(rid);
  if (params.type) {
    type = types.find((x) => x.id === params.type.id) || params.type;
    sources = await sourcesOf(rid, type.id);
    source = params.source || pickSource(sources, params.sourceId);
  } else {
    const at = autoType(release, types, params.pick);
    if (at) {
      type = at.type;
      sources = await sourcesOf(rid, type.id);
      source = pickSource(sources, at.sourceId);
    }
  }
  if (type && source) {
    paintChips();
    body.append(listEl);
    await loadEpisodes();
  } else if (type) {
    paintChips(); body.replaceChildren(emptyView('Источники не найдены'));
  } else paintPicker();

  // вернулись из плеера или со страницы аниме — отметки и предлагаемая серия могли измениться
  const onChange = (e) => {
    if (!root.isConnected) { window.removeEventListener('player-closed', onChange); return; }
    if (e.detail.releaseId === rid && episodes.length) { paintChips(); paint(); }
  };
  window.addEventListener('player-closed', onChange);
  const offParty = party.on((type) => { if (type === 'joined' || type === 'left') paintChips(); });
  ctx.setDispose?.(() => { offParty(); window.removeEventListener('player-closed', onChange); });
  ctx.setOnShow?.(({ returning } = {}) => { if (returning && episodes.length) { paintChips(); paint(); } }); // вернулись на экран
  return root;
}, episodesSkeleton);

// Диалог выбора плеера — когда в настройках «Спрашивать перед каждой серией» (и выбор из настроек)
export function choosePlayer(settingsOnly = false) {
  return new Promise((resolve) => {
    const cb = h('input', { type: 'checkbox' }); cb.checked = prefs.get('SELECTED_PLAYER') === 0;
    let done = false;
    const list = h('div', { class: 'sheet-list' }, PLAYERS.map((p) => h('button', {
      class: `sheet-item ${prefs.get('LAST_SELECTED_PLAYER') === p.id ? 'checked' : ''}`,
      onclick: () => {
        done = true;
        prefs.set('LAST_SELECTED_PLAYER', p.id);
        prefs.set('SELECTED_PLAYER', cb.checked ? 0 : p.id);
        d.close();
        resolve(settingsOnly ? null : p.id);
      },
    }, icon(p.icon), h('div', { class: 'grow' }, h('div', null, p.name()), h('div', { class: 'muted', style: { fontSize: '12px' } }, p.sub)))));
    const d = dialog({
      title: t('title_choose_player'), cls: 'sheet',
      content: h('div', null, list, h('label', { class: 'row', style: { padding: '10px 24px 4px' } }, cb, t('player_always_ask'))),
      onClose: () => { if (!done) resolve(null); },
    });
  });
}
