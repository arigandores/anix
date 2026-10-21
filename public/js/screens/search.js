// Поиск: релизы, профили, коллекции
import { h, icon, iconButton, pagedList, emptyView, img } from '../ui.js';
import { A } from '../api.js';
import { t, db } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { releaseRow, releaseCard, collectionCard, avatarEl, profileName } from './common.js';
import { viewType } from './home.js';

const SCOPES = {
  releases: { hint: () => t('search_bar_text'), load: (page, body) => A.searchReleases(page, body).then((r) => ({ ...r, content: r.releases || [] })) },
  favorites: { hint: () => t('search_for_something', t('tab_title_favourites')), load: A.searchFavorites },
  history: { hint: () => t('search_for_something', t('tab_title_history')), load: A.searchHistory, history: true },
  watching: { hint: () => t('search_for_something', t('tab_title_watching')), load: (p, b) => A.searchProfileList(1, p, b) },
  plans: { hint: () => t('search_for_something', t('tab_title_plans')), load: (p, b) => A.searchProfileList(2, p, b) },
  completed: { hint: () => t('search_for_something', t('tab_title_completed')), load: (p, b) => A.searchProfileList(3, p, b) },
  hold_on: { hint: () => t('search_for_something', t('tab_title_hold_on')), load: (p, b) => A.searchProfileList(4, p, b) },
  dropped: { hint: () => t('search_for_something', t('tab_title_dropped')), load: (p, b) => A.searchProfileList(5, p, b) },
  collections: { hint: () => 'Поиск коллекций', load: A.searchFavoriteCollections, kind: 'collection' },
  allCollections: { hint: () => 'Поиск коллекций', load: A.searchCollections, kind: 'collection' },
  profiles: { hint: () => 'Поиск пользователей', load: A.searchProfiles, kind: 'profile' },
};

function profileRow(p) {
  return h('div', { class: 'type-row', onclick: () => navigate('profile', { id: p.id }) }, avatarEl(p), h('div', { class: 'grow' }, profileName(p)));
}

registerScreen('search', ({ scope = 'releases', query = '', searchBy = 0 }) => {
  const sc = SCOPES[scope] || SCOPES.releases;
  const input = h('input', { placeholder: sc.hint(), value: query });
  input.value = query;
  const results = h('div');
  let timer;
  function showHistory() {
    const hist = db.searchHistory();
    results.replaceChildren();
    if (!hist.length) { results.append(emptyView('Начните вводить запрос', null, 'ic_search')); return; }
    results.append(h('div', { class: 'section-head' }, h('div', { class: 'section-title grow' }, 'История поиска'),
      h('button', { class: 'section-more', onclick: () => { db.clearSearch(); showHistory(); } }, 'Очистить')));
    results.append(h('div', { class: 'menu-list' }, hist.map((q) => h('div', { class: 'menu-item', onclick: () => { input.value = q; run(); } },
      icon('ic_history'), h('div', { class: 'grow' }, q), iconButton('ic_close', 'Удалить', (e) => { e.stopPropagation(); db.removeSearch(q); showHistory(); }, 'sm')))));
  }
  function run() {
    const q = input.value.trim();
    if (!q) { showHistory(); return; }
    db.addSearch(q);
    const body = { query: q, searchBy };
    const grid = viewType() === 1 && !sc.kind;
    let relatedShown = false;
    const list = pagedList({ skeleton: sc.kind === 'collection' ? 'collections' : sc.kind === 'profile' ? 'profiles1' : undefined, 
      grid: grid || sc.kind === 'collection',
      load: async (page) => {
        const r = await sc.load(page, body);
        if (page === 0 && r.related && !relatedShown) {
          relatedShown = true;
          const rel = r.related;
          results.prepend(h('div', { class: 'card', style: { margin: '10px var(--card-inset)', cursor: 'pointer', display: 'flex', gap: '14px', alignItems: 'center' }, onclick: () => navigate('related', { related: rel }) },
            h('div', { class: 'row', style: { gap: '4px' } }, (rel.images || []).slice(0, 3).map((src) => h('div', { class: 'poster', style: { width: '54px' } }, img(src)))),
            h('div', { class: 'grow' }, h('b', null, rel.name_ru || rel.name), h('div', { class: 'muted clamp2' }, rel.description || ''), h('div', { class: 'muted' }, `${rel.release_count} релизов`)),
            icon('ic_chevron_end')));
        }
        return r;
      },
      render: (r) => (sc.kind === 'profile' ? profileRow(r) : sc.kind === 'collection' ? collectionCard(r) : grid ? releaseCard(r) : releaseRow(r, { history: sc.history })),
      empty: () => emptyView('Ничего не найдено', 'Попробуйте изменить запрос'),
    });
    results.replaceChildren(h('div', { class: 'section-head' }, h('div', { class: 'section-title' }, 'Результаты поиска')), list);
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 500); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  const bar = h('div', { class: 'appbar' },
    iconButton('ic_back', 'Назад', () => history.back()),
    h('div', { class: 'searchbar', style: { maxWidth: 'none' } }, icon('ic_search'), input,
      iconButton('ic_close', 'Очистить', () => { input.value = ''; showHistory(); input.focus(); }, 'sm'),
      // голосовой поиск (телефон, как в Anixart): распознавание речи Android, сказанное — в поле и сразу поиск
      window.anixartNative?.voice?.available() ? iconButton('ic_voice', 'Голосовой поиск', async () => {
        const said = await window.anixartNative.voice.listen();
        if (said) { input.value = said; clearTimeout(timer); run(); }
      }, 'sm voice-btn') : null),
    scope === 'releases' ? iconButton('ic_tune', t('filter'), () => navigate('filter', {})) : null);
  setTimeout(() => input.focus(), 50);
  if (query) run(); else showHistory();
  return h('div', null, bar, results);
});
