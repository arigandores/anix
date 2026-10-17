// Главная: вкладки, «Моя вкладка», результаты фильтра
import { h, icon, iconButton, tabs, pagedList, emptyView, sheet, prompt, toast } from '../ui.js';
import { A } from '../api.js';
import { t, prefs } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { mainToolbar, releaseRow, releaseCard, emptyFilter, backToolbar } from './common.js';

export function viewType() { return prefs.get('VIEW_TYPE') || 0; }

export function releaseList(load, { empty, rank = false, remember = null } = {}) {
  const grid = viewType() === 1;
  return pagedList({
    load, grid, remember,
    render: (r, i) => (grid ? releaseCard(r) : releaseRow(r, { rank: rank ? i + 1 : undefined })),
    empty: empty || (() => emptyView(t('empty') !== 'empty' ? t('empty') : 'Ой, а тут ничего нет!')),
  });
}

// --- Своя вкладка (localStorage) ---
const CF_KEY = 'anixart.db.customFilter';
export function getCustomFilter() { try { return JSON.parse(localStorage.getItem(CF_KEY) || 'null'); } catch { return null; } }
export function setCustomFilter(f) { try { if (f) localStorage.setItem(CF_KEY, JSON.stringify(f)); else localStorage.removeItem(CF_KEY); } catch { /* ignore */ } }

// Поля формы фильтра → тело запроса filter
export function formToRequest(f) {
  const r = emptyFilter();
  if (!f) return r;
  r.category_id = f.category || null;
  r.status_id = f.status || null;
  r.start_year = f.startYear ?? null;
  r.end_year = f.endYear ?? null;
  if (f.studio) r.studio = f.studio;
  if (f.source) r.source = f.source;
  if (f.country) r.country = f.country;
  r.season = f.season || null;
  if (f.episodes === 1) { r.episodes_from = 1; r.episodes_to = 12; }
  if (f.episodes === 2) { r.episodes_from = 13; r.episodes_to = 25; }
  if (f.episodes === 3) { r.episodes_from = 26; r.episodes_to = 100; }
  if (f.episodes === 4) { r.episodes_from = 100; }
  if (f.duration === 1) { r.episode_duration_from = 1; r.episode_duration_to = 10; }
  if (f.duration === 2) { r.episode_duration_from = 11; r.episode_duration_to = 30; }
  if (f.duration === 3) { r.episode_duration_from = 31; }
  r.sort = f.sort ?? 0;
  r.genres = f.genres || [];
  r.profile_list_exclusions = f.exclusions || [];
  r.types = f.types || [];
  r.age_ratings = f.ageRatings || [];
  if (r.genres.length) {
    const mode = f.genresMode ?? 1;
    r.genres_mode = mode;
    r.is_genres_exclude_mode_enabled = mode === 2;
  }
  return r;
}

function customTab() {
  const f = getCustomFilter();
  if (!f) {
    return h('div', { class: 'empty' },
      icon('ic_custom_filter_rocket', 'big'),
      h('div', { class: 'empty-title' }, t('title_this_is_your_tab')),
      h('div', { class: 'empty-sub', style: { whiteSpace: 'pre-line' } }, t('desc_customize_tab')),
      h('button', { class: 'btn btn-primary', onclick: () => navigate('filter', { customTab: true }) }, t('btn_customize')));
  }
  const body = formToRequest(f);
  return releaseList((page) => A.filter(page, body, true), {
    empty: () => h('div', { class: 'empty' },
      h('div', { class: 'empty-title' }, t('empty')),
      h('div', { class: 'empty-sub', style: { whiteSpace: 'pre-line' } }, t('desc_custom_filter_empty')),
      h('button', { class: 'btn btn-tonal', onclick: () => navigate('filter', { customTab: true }) }, t('btn_customize'))),
  });
}

function filterTab(patch) {
  const body = { ...emptyFilter(), ...patch };
  return () => releaseList((page) => A.filter(page, body, true));
}

registerScreen('tab:home', () => {
  const customName = prefs.get('HOME_CUSTOM_FILTER_TAB_NAME') || t('my_custom_filter_tab');
  const defs = [
    { title: customName, render: customTab },
    { title: t('tab_title_anime'), render: filterTab({ country: t('country_japan') !== 'country_japan' ? t('country_japan') : 'Япония' }) },
    { title: t('tab_title_donghua'), render: filterTab({ country: t('country_china') !== 'country_china' ? t('country_china') : 'Китай' }) },
    { title: t('tab_title_actual'), render: filterTab({}) },
    { title: t('tab_title_ongoing'), render: filterTab({ status_id: 2 }) },
    { title: t('tab_title_upcoming'), render: filterTab({ status_id: 3 }) },
    { title: t('tab_title_finished'), render: filterTab({ status_id: 1 }) },
    { title: t('tab_title_movies'), render: filterTab({ category_id: 2 }) },
    { title: t('tab_title_ova'), render: filterTab({ category_id: 3 }) },
  ];
  const tb = tabs(defs, { initial: prefs.get('HOME_DEFAULT_PAGE') ?? 1 });
  window.addEventListener('custom-filter-changed', () => tb.refresh(0));
  const bar = tb.querySelector('.tabbar');
  // Кнопка настроек вкладок (ic_tune)
  bar.prepend(iconButton('ic_tune', t('change_default_tab'), () => sheet(null, [
    { label: t('change_default_tab'), icon: 'ic_home', onClick: () => sheet(t('change_default_tab'), defs.map((d, i) => ({ label: d.title, checked: (prefs.get('HOME_DEFAULT_PAGE') ?? 1) === i, onClick: () => { prefs.set('HOME_DEFAULT_PAGE', i); toast(t('change_default_tab_description')); } }))) },
    { label: t('customize_my_tab'), icon: 'ic_custom_filter_tune', onClick: () => navigate('filter', { customTab: true }) },
    { label: t('menu_rename'), icon: 'ic_custom_filter_pencil', onClick: async () => { const n = await prompt(t('menu_rename'), { value: customName }); if (n != null) { prefs.set('HOME_CUSTOM_FILTER_TAB_NAME', n.trim()); toast('Сохранено', { ok: true }); } } },
  ]), 'sm'));
  // Долгое нажатие (ПКМ) на вкладку → «Назначить по умолчанию»
  [...bar.querySelectorAll('.tab')].forEach((b, i) => b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    sheet(defs[i].title, [{ label: t('set_as_default_tab'), icon: 'ic_pin', onClick: () => prefs.set('HOME_DEFAULT_PAGE', i) }]);
  }));
  // Важное сообщение из config/toggles
  const root = h('div', null, mainToolbar());
  const tg = window.__toggles;
  if (tg && tg.impMessageEnabled && tg.impMessageText) {
    root.append(h('div', {
      class: 'rel-note', style: { margin: '6px 20px', background: tg.impMessageBackgroundColor || '', color: tg.impMessageTextColor || '', cursor: tg.impMessageLink ? 'pointer' : 'default' },
      onclick: () => tg.impMessageLink && window.open(tg.impMessageLink, '_blank'),
    }, tg.impMessageText));
  }
  root.append(tb);
  return root;
});

// Результаты фильтра
registerScreen('filtered', ({ form }) => {
  const body = formToRequest(form);
  return h('div', null,
    backToolbar(t('filter'), [
      h('button', { class: 'btn btn-text', onclick: () => history.back() }, t('edit') !== 'edit' ? t('edit') : 'Изменить'),
      iconButton('ic_more', 'Ещё', () => sheet(null, [
        { label: 'Установить для «Моя вкладка»', icon: 'ic_pin', onClick: () => { setCustomFilter(form); toast('Сохранено', { ok: true }); } },
      ])),
    ]),
    releaseList((page) => A.filter(page, body, true)));
});
