// Закладки: вкладки списков
import { h, icon, actionIcon, tabs, pagedList, emptyView, sheet } from '../ui.js';
import { A, auth } from '../api.js';
import { t, prefs } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { mainToolbar, releaseRow, releaseCard, collectionCard, needAuthView, digits } from './common.js';
import { viewType } from './home.js';

const SORTS = [
  [1, 'sort_profile_list', 'sort_profile_list_desc'], [2, 'sort_profile_list', 'sort_profile_list_asc'],
  [3, 'sort_release', 'sort_release_desc'], [4, 'sort_release', 'sort_release_asc'],
  [5, 'sort_title', 'sort_title_desc'], [6, 'sort_title', 'sort_title_asc'],
  [7, 'sort_rating', 'sort_rating_desc'], [8, 'sort_rating', 'sort_rating_asc'],
];

export const BOOKMARK_TABS = [
  { key: 'collections', title: 'tab_title_collections', empty: 'empty_suggestion_collections' },
  { key: 'history', title: 'tab_title_history', empty: 'empty_suggestion_history' },
  { key: 'favorites', title: 'tab_title_favourites', empty: 'empty_suggestion_favorites', sortKey: 'BOOKMARKS_FAVORITES_SORT', filter: true },
  { key: 'watching', title: 'tab_title_watching', status: 1, empty: 'empty_suggestion_watching', sortKey: 'BOOKMARKS_WATCHING_SORT' },
  { key: 'plans', title: 'tab_title_plans', status: 2, empty: 'empty_suggestion_plans', sortKey: 'BOOKMARKS_PLANS_SORT', filter: true },
  { key: 'completed', title: 'tab_title_completed', status: 3, empty: 'empty_suggestion_completed', sortKey: 'BOOKMARKS_COMPLETED_SORT' },
  { key: 'hold_on', title: 'tab_title_hold_on', status: 4, empty: 'empty_suggestion_hold_on', sortKey: 'BOOKMARKS_HOLD_ON_SORT' },
  { key: 'dropped', title: 'tab_title_dropped', status: 5, empty: 'empty_suggestion_dropped', sortKey: 'BOOKMARKS_DROPPED_SORT' },
];

export function bookmarkReleaseTab(def, { profileId = null } = {}) {
  const wrap = h('div');
  let sort = prefs.get(def.sortKey) || 1;
  let filterAnnounce = 0;
  function build() {
    const grid = viewType() === 1;
    const totalEl = h('span', { class: 'muted' });
    const sortLabel = SORTS.find((s) => s[0] === sort);
    const header = h('div', { class: 'row', style: { padding: '10px var(--gutter)', gap: '10px' } },
      totalEl, h('div', { class: 'grow' }),
      h('button', { class: 'chip', onclick: () => sheet('Сортировка', SORTS.map(([v, g, l]) => ({ label: `${t(g)}: ${t(l)}`, checked: v === sort, onClick: () => { sort = v; prefs.set(def.sortKey, v); build(); } }))) },
        icon(sort % 2 ? 'sort_desc' : 'sort_asc', 'sm'), `${t(sortLabel[1])}`),
      def.filter && !profileId ? h('button', { class: `chip ${filterAnnounce ? 'on' : ''}`, onclick: () => sheet(t('filter'), [
        { label: t('no_matter'), checked: filterAnnounce === 0, onClick: () => { filterAnnounce = 0; build(); } },
        { label: t('only_announces'), checked: filterAnnounce === 1, onClick: () => { filterAnnounce = 1; build(); } },
        { label: t('exclude_announces'), checked: filterAnnounce === 2, onClick: () => { filterAnnounce = 2; build(); } },
      ]) }, icon('sort_filter', 'sm'), t('filter')) : null,
      !profileId ? h('button', {
        class: 'icon-btn sm', title: t('label_random'),
        onclick: () => navigate('release', def.status ? { random: 2, profileId: auth.profileId, status: def.status } : { random: 3 }),
      }, actionIcon('ic_shuffle')) : null);
    const load = (page) => (def.status
      ? (profileId ? A.profileListBy(profileId, def.status, page, sort, filterAnnounce) : A.profileList(def.status, page, sort, filterAnnounce))
      : A.favorites(page, sort, filterAnnounce));
    // первая страница — из памяти (повторное переключение на вкладку — сразу, без скелетона), свежая — фоном
    const list = pagedList({
      load, grid, remember: `bookmarks:${def.key}:${profileId || 'me'}:${sort}:${filterAnnounce}`,
      onFirst: (r) => { totalEl.textContent = t('total_count', digits(r.total_count ?? 0)); },
      render: (r) => (grid ? releaseCard(r) : releaseRow(r)),
      empty: () => emptyView(t(def.empty)),
    });
    wrap.replaceChildren(header, list);
  }
  build();
  return wrap;
}

function tabContent(def) {
  if (def.key === 'collections') {
    return pagedList({ skeleton: 'collections', load: (page) => A.collectionFavorites(page), remember: 'bookmarks:collections', render: collectionCard, grid: true, empty: () => emptyView(t(def.empty)) });
  }
  if (def.key === 'history') {
    // как и остальные вкладки — первая страница из памяти: раз в 5–10 переключений ответ шёл дольше 250 мс и
    // мелькал скелетон (вкладка пересобирается при каждом выборе: cache: false)
    return pagedList({ load: (page) => A.history(page), remember: 'bookmarks:history', render: (r) => releaseRow(r, { history: true }), empty: () => emptyView(t(def.empty)) });
  }
  return bookmarkReleaseTab(def);
}

registerScreen('tab:bookmarks', (_p, ctx) => {
  if (!auth.loggedIn) return needAuthView();
  let current = prefs.get('BOOKMARKS_DEFAULT_PAGE') ?? 2;
  const hintFor = (i) => t('search_for_something', t(BOOKMARK_TABS[i].title));
  const toolbar = mainToolbar({
    hint: hintFor(current),
    onSearch: () => navigate('search', { scope: BOOKMARK_TABS[current].key }),
  });
  // Списки всегда свежие: вкладка перерисовывается при выборе, а при возврате на экран
  // (после просмотра серии, смены статуса и т.п.) обновляется текущая
  const tb = tabs(BOOKMARK_TABS.map((d) => ({ title: t(d.title), render: () => tabContent(d) })), {
    initial: current,
    cache: false,
    onChange: (i) => {
      current = i;
      const ph = toolbar.querySelector('.placeholder');
      if (ph) ph.textContent = hintFor(i);
    },
  });
  ctx.setOnShow(({ returning }) => {
    if (!returning) return;
    // тихо: прежний список виден, пока не придут свежие данные
    const list = tb.querySelector('.tabbody .paged');
    if (list?.refresh) list.refresh(); else tb.refresh();
  });
  return h('div', null, toolbar, tb);
});
