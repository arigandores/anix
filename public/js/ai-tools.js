// Инструменты AI-помощника: описание (уходит агенту через MCP) и реализация на стороне приложения.
// Все инструменты выполняются без отдельного подтверждения: если пользователь попросил — помощник делает.
// Изменять что-либо без просьбы помощнику запрещает системный промпт.
import { A, auth, dropPrefetchedRelease } from './api.js';
import { arr } from './store.js';
import { navigate } from './router.js';

// Кэш полученных релизов: карточки в чате и описания действий в диалоге подтверждения
export const releaseCache = new Map();
const remember = (r) => { if (r && r.id) releaseCache.set(r.id, { ...(releaseCache.get(r.id) || {}), ...r }); return r; };

const LISTS = ['none', 'watching', 'plan', 'completed', 'hold_on', 'dropped']; // profile_list_status 0..5
export const LIST_RU = { none: 'Не смотрю', watching: 'Смотрю', plan: 'В планах', completed: 'Просмотрено', hold_on: 'Отложено', dropped: 'Брошено', favorites: 'Избранное' };
const AGE = ['', '0+', '6+', '12+', '16+', '18+'];
const SEASONS = ['', 'зима', 'весна', 'лето', 'осень'];
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || undefined);

// Компактный релиз для модели: только то, что нужно для совета
function brief(r, { full = false } = {}) {
  if (!r || typeof r !== 'object') return r;
  remember(r);
  const R = r.episodes_released; const T = r.episodes_total;
  const out = {
    id: r.id,
    title: r.title_ru || r.title_original,
    title_original: r.title_original || undefined,
    year: r.year || undefined,
    season: SEASONS[r.season] || undefined,
    category: r.category?.name,
    status: r.status?.name,
    episodes: R != null || T != null ? `${R ?? '?'} из ${T ?? '?'}` : undefined,
    episode_minutes: r.duration || undefined,
    rating: r.vote_count > 50 ? Math.round(r.grade * 100) / 100 : undefined,
    votes: r.vote_count || undefined,
    genres: r.genres || undefined,
    studio: r.studio || undefined,
    country: r.country || undefined,
    age: AGE[r.age_rating] || undefined,
    my_list: r.profile_list_status ? LIST_RU[LISTS[r.profile_list_status]] : undefined,
    favorite: r.is_favorite || undefined,
    my_vote: r.your_vote || r.my_vote || undefined,
    description: clip(r.description, full ? 1200 : 260),
  };
  if (full) {
    Object.assign(out, {
      source: r.source || undefined,
      director: r.director || undefined,
      translators: r.translators || undefined,
      aired: r.aired_on_date ? new Date(r.aired_on_date * 1000).toISOString().slice(0, 10) : undefined,
      in_lists: { watching: r.watching_count, plan: r.plan_count, completed: r.completed_count, hold_on: r.hold_on_count, dropped: r.dropped_count },
      related: (r.related_releases || []).filter((x) => x && x.id !== r.id).slice(0, 12).map((x) => ({ id: remember(x).id, title: x.title_ru, year: x.year, category: x.category?.name })),
      recommended: (r.recommended_releases || []).slice(0, 10).map((x) => ({ id: remember(x).id, title: x.title_ru, year: x.year })),
    });
  }
  return JSON.parse(JSON.stringify(out)); // без undefined
}
const page = (r, items) => ({ total: r.total_count ?? undefined, page: r.current_page ?? undefined, has_more: (items || []).length >= 25, items });

const GENRES = () => arr('genres').filter((g) => !g.startsWith('@'));
const SORT = { recent: 0, oldest: 4, rating: 1, rating_low: 5, year_new: 2, year_old: 6, popular: 3, unpopular: 7 };
const STATUS = { finished: 1, ongoing: 2, announce: 3 };
const CATEGORY = { series: 1, movie: 2, ova: 3, dorama: 4 };
const SEASON = { winter: 1, spring: 2, summer: 3, autumn: 4 };
const EPISODES = { '1-12': [1, 12], '13-25': [13, 25], '26-100': [26, 100], '100+': [100, null] };
const EXCLUDE = { favorites: 0, watching: 1, plan: 2, completed: 3, hold_on: 4, dropped: 5 };
const idArg = { type: 'integer', description: 'id релиза' };
const pageArg = { type: 'integer', minimum: 0, description: 'страница с 0, по 25 элементов' };

async function currentStatus(id) {
  const c = releaseCache.get(id);
  if (c && c.profile_list_status != null && c._fresh) return c;
  const r = (await A.release(id, false)).release;
  if (!r) throw new Error('Релиз не найден');
  return remember({ ...r, _fresh: true });
}

// Коллекции: ограничения и коды ответов бекенда
function checkCollection(title, description) {
  const t = String(title || '').trim();
  if (t.length < 10 || t.length > 60) throw new Error(`Название коллекции: от 10 до 60 символов (сейчас ${t.length})`);
  if (String(description || '').length > 1000) throw new Error('Описание коллекции: максимум 1000 символов');
}
function collectionError(code) {
  return ({ 2: 'Неверное название: от 10 до 60 символов', 3: 'Неверное описание: максимум 1000 символов', 4: 'Неверный список релизов',
    5: 'Превышен лимит на создание коллекций, попробуйте позже', 6: 'Коллекция не найдена', 7: 'Это не ваша коллекция', 8: 'Коллекция удалена',
    9: 'Превышен лимит релизов в коллекции' })[code] || `Ошибка сервера (код ${code})`;
}
// Своя коллекция и полный список id её релизов (edit заменяет состав целиком)
async function myCollection(id, { withReleases = true } = {}) {
  const c = await A.collection(id);
  const col = c.collection;
  if (!col) throw new Error(c.code === 4 ? 'Коллекция удалена' : 'Коллекция не найдена');
  if (col.creator?.id !== auth.profileId) throw new Error('Это не ваша коллекция — менять можно только свои');
  if (!withReleases) return { col, ids: [] };
  let ids = [];
  try { ids = ((await A.collectionMyReleases(id)).content || []).map((r) => r.id); } catch { ids = []; }
  if (!ids.length) {
    for (let p = 0; p < 40; p++) { const r = await A.collectionReleases(id, p); const items = r.content || []; ids.push(...items.map((x) => x.id)); if (items.length < 25) break; }
  }
  return { col, ids: [...new Set(ids)] };
}

export const TOOLS = [
  {
    name: 'search_releases', readOnly: true,
    description: 'Поиск аниме в каталоге Anixart по названию (русскому, оригинальному или альтернативному).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, page: pageArg }, required: ['query'] },
    run: async ({ query, page: p = 0 }) => { const r = await A.searchReleases(p, { query, searchBy: 0 }); const items = (r.releases || []).map((x) => brief(x)); return page(r, items); },
  },
  {
    name: 'filter_releases', readOnly: true,
    description: 'Подбор аниме по фильтрам каталога (как экран «Фильтр»). Жанры — точные названия из get_genres. exclude_my_lists убирает то, что уже есть в списках пользователя.',
    inputSchema: {
      type: 'object',
      properties: {
        genres: { type: 'array', items: { type: 'string' } },
        genres_mode: { type: 'string', enum: ['all', 'any', 'exclude'], description: 'all — все выбранные жанры, any — хотя бы один, exclude — без этих жанров' },
        year_from: { type: 'integer' }, year_to: { type: 'integer' },
        status: { type: 'string', enum: Object.keys(STATUS) },
        category: { type: 'string', enum: Object.keys(CATEGORY) },
        country: { type: 'string', enum: ['Япония', 'Китай', 'Южная Корея'] },
        season: { type: 'string', enum: Object.keys(SEASON) },
        episodes: { type: 'string', enum: Object.keys(EPISODES) },
        age: { type: 'array', items: { type: 'string', enum: AGE.slice(1) } },
        sort: { type: 'string', enum: Object.keys(SORT) },
        exclude_my_lists: { type: 'array', items: { type: 'string', enum: Object.keys(EXCLUDE) } },
        page: pageArg,
      },
    },
    run: async (a) => {
      const body = {
        age_ratings: (a.age || []).map((x) => AGE.indexOf(x)).filter((x) => x > 0), category_id: CATEGORY[a.category] || null, country: a.country || null,
        end_year: a.year_to ?? null, start_year: a.year_from ?? null, episode_duration_from: null, episode_duration_to: null,
        episodes_from: EPISODES[a.episodes]?.[0] ?? null, episodes_to: EPISODES[a.episodes]?.[1] ?? null,
        genres: a.genres || [], genres_mode: null, is_genres_exclude_mode_enabled: false,
        profile_list_exclusions: (a.exclude_my_lists || []).map((x) => EXCLUDE[x]).filter((x) => x != null),
        season: SEASON[a.season] || null, sort: SORT[a.sort] ?? 0, source: null, status_id: STATUS[a.status] || null, studio: null, types: [],
      };
      if (body.genres.length) { const m = { all: 0, any: 1, exclude: 2 }[a.genres_mode || 'all']; body.genres_mode = m; body.is_genres_exclude_mode_enabled = m === 2; }
      const r = await A.filter(a.page || 0, body, true);
      return page(r, (r.content || []).map((x) => brief(x)));
    },
  },
  {
    name: 'get_genres', readOnly: true,
    description: 'Список жанров и тематик каталога (для filter_releases).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => GENRES(),
  },
  {
    name: 'get_release', readOnly: true,
    description: 'Подробно о релизе: описание, жанры, серии, рейтинг, статус в списках пользователя, его оценка, связанные части франшизы и рекомендации.',
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'] },
    run: async ({ id }) => { const r = (await A.release(id, true)).release; if (!r) throw new Error('Релиз не найден'); remember({ ...r, _fresh: true }); return brief(r, { full: true }); },
  },
  {
    name: 'get_my_list', readOnly: true,
    description: 'Релизы из закладок пользователя: watching (Смотрю), plan (В планах), completed (Просмотрено), hold_on (Отложено), dropped (Брошено), favorites (Избранное).',
    inputSchema: { type: 'object', properties: { list: { type: 'string', enum: ['watching', 'plan', 'completed', 'hold_on', 'dropped', 'favorites'] }, page: pageArg }, required: ['list'] },
    run: async ({ list, page: p = 0 }) => {
      const r = list === 'favorites' ? await A.favorites(p, 1, 0) : await A.profileList(LISTS.indexOf(list), p, 1, 0);
      return page(r, (r.content || []).map((x) => brief(x)));
    },
  },
  {
    name: 'get_history', readOnly: true,
    description: 'История просмотров пользователя (последнее сверху): релиз, последняя просмотренная серия и озвучка, когда.',
    inputSchema: { type: 'object', properties: { page: pageArg } },
    run: async ({ page: p = 0 }) => {
      const r = await A.history(p);
      return page(r, (r.content || []).map((x) => ({ ...brief(x), last_episode: x.last_view_episode?.name || (x.last_view_episode?.position ? `${x.last_view_episode.position} серия` : undefined), voiceover: x.last_view_episode?.source?.type?.name, viewed_at: x.last_view_timestamp ? new Date(x.last_view_timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ') : undefined })));
    },
  },
  {
    name: 'get_my_profile', readOnly: true,
    description: 'Профиль пользователя: число релизов в каждом списке, любимые жанры/аудитория/тематики (в процентах), сколько серий и времени просмотрено, последние оценки.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const p = (await A.profile(auth.profileId)).profile || {};
      const pref = (x) => (x || []).slice().sort((a, b) => b.percentage - a.percentage).map((g) => `${g.name} ${g.percentage}%`);
      return {
        login: p.login, status: p.status || undefined,
        lists: { watching: p.watching_count, plan: p.plan_count, completed: p.completed_count, hold_on: p.hold_on_count, dropped: p.dropped_count, favorites: p.favorite_count },
        preferred_genres: pref(p.preferred_genres), preferred_audiences: pref(p.preferred_audiences), preferred_themes: pref(p.preferred_themes),
        watched_episodes: p.watched_episode_count, watched_minutes: p.watched_time,
        recent_votes: (p.votes || []).slice(0, 15).map((r) => ({ id: remember(r).id, title: r.title_ru, my_vote: r.my_vote })),
      };
    },
  },
  {
    name: 'get_my_votes', readOnly: true,
    description: 'Оценки пользователя (1–5 звёзд). sort: newest, oldest, 5..1 — только с такой оценкой.',
    inputSchema: { type: 'object', properties: { sort: { type: 'string', enum: ['newest', 'oldest', '5', '4', '3', '2', '1'] }, page: pageArg } },
    run: async ({ sort = 'newest', page: p = 0 }) => {
      const code = { newest: 1, oldest: 2, 5: 3, 4: 4, 3: 5, 2: 6, 1: 7 }[sort] || 1;
      const r = await A.votedReleases(auth.profileId, p, code);
      return page(r, (r.content || []).map((x) => brief(x)));
    },
  },
  {
    name: 'get_recommendations', readOnly: true,
    description: 'Персональные рекомендации Anixart на основе оценок пользователя.',
    inputSchema: { type: 'object', properties: { page: pageArg } },
    run: async ({ page: p = 0 }) => { const r = await A.recommendations(p, -1); return page(r, (r.content || []).map((x) => brief(x))); },
  },
  {
    name: 'get_trending', readOnly: true,
    description: 'Что популярно сейчас: discussed — обсуждаемое сегодня, watching_now — смотрят прямо сейчас.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['discussed', 'watching_now'] } }, required: ['kind'] },
    run: async ({ kind }) => { const r = kind === 'discussed' ? await A.discussing() : await A.watching(0); return (r.content || []).map((x) => brief(x)); },
  },
  {
    name: 'get_schedule', readOnly: true,
    description: 'Расписание выхода серий онгоингов по дням недели (дни выхода в Японии/Китае; озвучка появляется позже).',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const r = await A.schedule();
      const days = { monday: 'понедельник', tuesday: 'вторник', wednesday: 'среда', thursday: 'четверг', friday: 'пятница', saturday: 'суббота', sunday: 'воскресенье' };
      const out = {};
      for (const [k, ru] of Object.entries(days)) out[ru] = (r[k] || []).map((x) => ({ id: remember(x).id, title: x.title_ru, episodes: `${x.episodes_released ?? '?'} из ${x.episodes_total ?? '?'}`, my_list: x.profile_list_status ? LIST_RU[LISTS[x.profile_list_status]] : undefined }));
      return out;
    },
  },
  {
    name: 'get_voiceovers', readOnly: true,
    description: 'Доступные озвучки и субтитры релиза с числом серий и просмотров.',
    inputSchema: { type: 'object', properties: { release_id: idArg }, required: ['release_id'] },
    run: async ({ release_id: id }) => { const r = await A.types(id); return (r.types || []).map((x) => ({ name: x.name, subtitles: !!x.is_sub || undefined, episodes: x.episodes_count, views: x.view_count, studio_workers: x.workers || undefined })); },
  },
  // --- навигация в приложении ---
  {
    name: 'open_release', readOnly: true,
    description: 'Открыть страницу релиза в приложении (пользователь увидит её на экране).',
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'] },
    run: async ({ id }) => { navigate('release', { id, preload: releaseCache.get(id) }); return 'Открыто'; },
  },
  {
    name: 'open_episodes', readOnly: true,
    description: 'Открыть выбор озвучки и серий релиза, чтобы пользователь начал смотреть.',
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'] },
    run: async ({ id }) => { const r = await currentStatus(id); navigate('episodes', { release: r }); return 'Открыто'; },
  },
  // --- коллекции пользователя ---
  {
    name: 'get_my_collections', readOnly: true,
    description: 'Коллекции пользователя (свои подборки релизов): id, название, приватность, описание.',
    inputSchema: { type: 'object', properties: { page: pageArg } },
    run: async ({ page: p = 0 }) => {
      const r = await A.profileCollections(auth.profileId, p);
      return page(r, (r.content || []).map((c) => ({ id: c.id, title: c.title, private: c.is_private || undefined, description: clip(c.description, 160), favorites: c.favorites_count, comments: c.comment_count })));
    },
  },
  {
    name: 'get_collection', readOnly: true,
    description: 'Коллекция по id: название, описание, автор и релизы в ней.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, page: pageArg }, required: ['id'] },
    run: async ({ id, page: p = 0 }) => {
      const [c, rel] = await Promise.all([A.collection(id), A.collectionReleases(id, p)]);
      if (!c.collection) throw new Error(c.code === 3 ? 'Коллекция приватная' : 'Коллекция не найдена');
      const col = c.collection;
      return { id: col.id, title: col.title, description: clip(col.description, 600), private: col.is_private || undefined, author: col.creator?.login, mine: col.creator?.id === auth.profileId, ...page(rel, (rel.content || []).map((x) => brief(x))) };
    },
  },
  {
    name: 'create_collection',
    description: 'Создать коллекцию пользователя. Название 10–60 символов, описание до 1000. release_ids — id релизов из каталога.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' }, release_ids: { type: 'array', items: { type: 'integer' } } }, required: ['title', 'release_ids'] },
    run: async ({ title, description = '', private: priv = false, release_ids: ids = [] }) => {
      checkCollection(title, description);
      const r = await A.collectionCreate({ title: title.trim(), description: description.trim(), is_private: !!priv, releases: [...new Set(ids)] });
      if (r.code !== 0) throw new Error(collectionError(r.code));
      window.dispatchEvent(new CustomEvent('collections-changed'));
      return `Коллекция создана: id ${r.collection?.id}, «${title.trim()}», релизов: ${new Set(ids).size}`;
    },
  },
  {
    name: 'edit_collection',
    description: 'Изменить название, описание или приватность своей коллекции (состав не трогает).',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['id'] },
    run: async ({ id, title, description, private: priv }) => {
      const { col, ids } = await myCollection(id);
      const body = { title: (title ?? col.title).trim(), description: (description ?? col.description ?? '').trim(), is_private: priv ?? !!col.is_private, releases: ids };
      checkCollection(body.title, body.description);
      const r = await A.collectionEdit(id, body);
      if (r.code !== 0) throw new Error(collectionError(r.code));
      window.dispatchEvent(new CustomEvent('collections-changed'));
      return `Коллекция «${body.title}» обновлена`;
    },
  },
  {
    name: 'add_to_collection',
    description: 'Добавить релизы в свою коллекцию.',
    inputSchema: { type: 'object', properties: { collection_id: { type: 'integer' }, release_ids: { type: 'array', items: { type: 'integer' } } }, required: ['collection_id', 'release_ids'] },
    run: async ({ collection_id: cid, release_ids: ids = [] }) => {
      const out = [];
      for (const rid of [...new Set(ids)]) {
        const r = await A.collectionMyReleaseAdd(cid, rid);
        out.push(`${rid}: ${r.code === 0 ? 'добавлен' : r.code === 5 ? 'уже был в коллекции' : r.code === 7 ? 'лимит релизов в коллекции' : collectionError(r.code)}`);
        if (r.code === 7) break;
      }
      window.dispatchEvent(new CustomEvent('collections-changed'));
      return out.join('; ');
    },
  },
  {
    name: 'remove_from_collection',
    description: 'Убрать релизы из своей коллекции.',
    inputSchema: { type: 'object', properties: { collection_id: { type: 'integer' }, release_ids: { type: 'array', items: { type: 'integer' } } }, required: ['collection_id', 'release_ids'] },
    run: async ({ collection_id: cid, release_ids: ids = [] }) => {
      const { col, ids: cur } = await myCollection(cid);
      const drop = new Set(ids);
      const rest = cur.filter((x) => !drop.has(x));
      if (rest.length === cur.length) return 'Этих релизов в коллекции нет';
      const r = await A.collectionEdit(cid, { title: col.title, description: col.description || '', is_private: !!col.is_private, releases: rest });
      if (r.code !== 0) throw new Error(collectionError(r.code));
      window.dispatchEvent(new CustomEvent('collections-changed'));
      return `Убрано релизов: ${cur.length - rest.length}, осталось ${rest.length}`;
    },
  },
  {
    name: 'delete_collection',
    description: 'Удалить свою коллекцию целиком (необратимо) — только по явной просьбе пользователя.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    run: async ({ id }) => {
      const { col } = await myCollection(id, { withReleases: false });
      const r = await A.collectionDelete(id);
      if (r.code !== 0) throw new Error(collectionError(r.code));
      window.dispatchEvent(new CustomEvent('collections-changed'));
      return `Коллекция «${col.title}» удалена`;
    },
  },
  {
    name: 'open_collection', readOnly: true,
    description: 'Открыть коллекцию на экране приложения.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    run: async ({ id }) => { navigate('collection', { id }); return 'Открыто'; },
  },
  // --- изменения закладок и оценок (по просьбе пользователя) ---
  {
    name: 'set_list_status',
    description: 'Поменять статус релиза в закладках пользователя (none — убрать из списков).',
    inputSchema: { type: 'object', properties: { release_id: idArg, status: { type: 'string', enum: LISTS } }, required: ['release_id', 'status'] },
    run: async ({ release_id: id, status }) => {
      const r = await currentStatus(id);
      const cur = r.profile_list_status || 0; const next = LISTS.indexOf(status);
      if (next < 0) throw new Error('Неизвестный статус');
      if (cur === next) return `Уже в «${LIST_RU[status]}»`;
      if (next === 0) await A.listDelete(cur, id); else await A.listAdd(next, id);
      remember({ id, profile_list_status: next }); dropPrefetchedRelease(id);
      window.dispatchEvent(new CustomEvent('lists-changed'));
      return `Готово: «${r.title_ru}» → ${LIST_RU[status]}`;
    },
  },
  {
    name: 'set_favorite',
    description: 'Добавить релиз в «Избранное» или убрать оттуда.',
    inputSchema: { type: 'object', properties: { release_id: idArg, favorite: { type: 'boolean' } }, required: ['release_id', 'favorite'] },
    run: async ({ release_id: id, favorite }) => {
      const r = await currentStatus(id);
      if (!!r.is_favorite === !!favorite) return favorite ? 'Уже в избранном' : 'И так не в избранном';
      if (favorite) await A.favAdd(id); else await A.favDelete(id);
      remember({ id, is_favorite: !!favorite }); dropPrefetchedRelease(id);
      return favorite ? `«${r.title_ru}» добавлен в избранное` : `«${r.title_ru}» убран из избранного`;
    },
  },
  {
    name: 'rate_release',
    description: 'Поставить релизу оценку 1–5 звёзд (0 — удалить оценку).',
    inputSchema: { type: 'object', properties: { release_id: idArg, score: { type: 'integer', minimum: 0, maximum: 5 } }, required: ['release_id', 'score'] },
    run: async ({ release_id: id, score }) => {
      const r = await currentStatus(id);
      if (r.your_vote) await A.deleteVote(id);
      if (score > 0) { const res = await A.vote(id, score); if (res.code !== 0) throw new Error('Не удалось поставить оценку'); }
      remember({ id, your_vote: score || null }); dropPrefetchedRelease(id);
      return score ? `Оценка «${r.title_ru}»: ${score} из 5` : `Оценка «${r.title_ru}» удалена`;
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
export const toolSpecs = () => TOOLS.map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, readOnly: !!readOnly }));

export async function runTool(name, args) {
  const t = byName.get(name);
  if (!t) throw new Error(`Неизвестный инструмент ${name}`);
  return t.run(args || {});
}

// Человеческое описание действия для диалога подтверждения и подписи в чате
export function describeTool(rawName, args = {}) {
  const name = String(rawName || '').replace(/^mcp__anixart__/, '');
  const title = (id) => { const r = releaseCache.get(id); return r ? `«${r.title_ru || r.title || r.title_original}»` : `релиз #${id}`; };
  switch (name) {
    case 'search_releases': return `Ищу в каталоге: ${args.query || ''}`;
    case 'filter_releases': return 'Подбираю по фильтрам';
    case 'get_genres': return 'Смотрю список жанров';
    case 'get_release': return `Читаю о ${args.id ? title(args.id) : 'релизе'}`;
    case 'get_my_list': return `Смотрю ваш список «${LIST_RU[args.list] || ''}»${args.page ? `, стр. ${args.page + 1}` : ''}`;
    case 'get_history': return 'Смотрю историю просмотров';
    case 'get_my_profile': return 'Смотрю ваш профиль';
    case 'get_my_votes': return 'Смотрю ваши оценки';
    case 'get_recommendations': return 'Смотрю рекомендации';
    case 'get_trending': return args.kind === 'discussed' ? 'Смотрю обсуждаемое сегодня' : 'Смотрю, что смотрят сейчас';
    case 'get_schedule': return 'Смотрю расписание';
    case 'get_voiceovers': return `Смотрю озвучки ${title(args.release_id)}`;
    case 'open_release': return `Открываю ${title(args.id)}`;
    case 'open_episodes': return `Открываю серии ${title(args.id)}`;
    case 'set_list_status': return args.status === 'none' ? `Убрать ${title(args.release_id)} из списков` : `Перенести ${title(args.release_id)} в «${LIST_RU[args.status] || args.status}»`;
    case 'set_favorite': return args.favorite ? `Добавить ${title(args.release_id)} в «Избранное»` : `Убрать ${title(args.release_id)} из «Избранного»`;
    case 'rate_release': return args.score ? `Поставить ${title(args.release_id)} оценку ${args.score} из 5` : `Удалить оценку ${title(args.release_id)}`;
    case 'get_my_collections': return 'Смотрю ваши коллекции';
    case 'get_collection': return 'Смотрю коллекцию';
    case 'create_collection': return `Создаю коллекцию «${args.title || ''}»`;
    case 'edit_collection': return 'Изменяю коллекцию';
    case 'add_to_collection': return `Добавляю в коллекцию релизов: ${(args.release_ids || []).length}`;
    case 'remove_from_collection': return `Убираю из коллекции релизов: ${(args.release_ids || []).length}`;
    case 'delete_collection': return 'Удаляю коллекцию';
    case 'open_collection': return 'Открываю коллекцию';
    case 'remember': return `Запоминаю: ${args.text || ''}`;
    case 'update_memory': return `Обновляю память: ${args.text || ''}`;
    case 'forget': return 'Забываю устаревшую запись';
    case 'WebSearch': return `Ищу в интернете: ${args.query || ''}`;
    case 'WebFetch': return `Читаю страницу ${(args.url || '').replace(/^https?:\/\//, '').slice(0, 60)}`;
    default: return name;
  }
}
