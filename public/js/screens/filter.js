// Фильтр (обычный режим → результаты, режим «Настройки вкладки» → своя вкладка)
import { h, icon, dialog, toast } from '../ui.js';
import { A } from '../api.js';
import { t, arr } from '../store.js';
import { registerScreen, navigate, replace } from '../router.js';
import { backToolbar } from './common.js';
import { getCustomFilter, setCustomFilter } from './home.js';

// позиция в arrays/sort → значение sort API и подсказка
const SORT_MAP = [[0, 'Сначала недавно добавленное и обновлённое'], [4, 'Сначала давно добавленное и обновлённое'], [1, 'Сначала с высоким рейтингом'], [5, 'Сначала с низким рейтингом'],
  [2, 'Сначала новые по году выхода'], [6, 'Сначала старые по году выхода'], [3, 'Сначала самые популярные'], [7, 'Сначала наименее популярные']];
const GENRE_HINTS = {
  0: 'Покажем релизы со всеми выбранными жанрами. Для точного результата выбирайте не больше 2–3 жанров.',
  1: 'Покажем релизы хотя бы с одним выбранным жанром.',
  2: 'Покажем только релизы без выбранных жанров.',
};

let typesCache = null;

registerScreen('filter', ({ customTab = false, form: initial }) => {
  const f = { ...(initial || (customTab ? getCustomFilter() : null) || {}) };
  f.genres = [...(f.genres || [])]; f.exclusions = [...(f.exclusions || [])]; f.types = [...(f.types || [])]; f.ageRatings = [...(f.ageRatings || [])];
  if (f.genresMode == null) f.genresMode = 1;
  const formEl = h('div', { class: 'filter-form' });

  function select(label, options, value, onPick, { none = true } = {}) {
    const sel = h('select', { class: 'input' }, options.map((o, i) => h('option', { value: String(i) }, o)));
    sel.value = String(value ?? 0);
    sel.onchange = () => onPick(Number(sel.value));
    void none;
    return h('div', { class: 'field' }, h('label', null, label), sel);
  }
  function multi(label, options, selected, onChange, hint) {
    const chips = h('div', { class: 'chips' }, options.map((o) => {
      const on = selected.includes(o.value);
      const c = h('button', { class: `chip ${on ? 'on' : ''}`, type: 'button' }, o.label);
      c.onclick = () => {
        const i = selected.indexOf(o.value);
        if (i >= 0) selected.splice(i, 1); else selected.push(o.value);
        c.classList.toggle('on');
        onChange && onChange();
      };
      return c;
    }));
    return h('div', { class: 'field' }, h('label', null, label), chips, hint ? h('div', { class: 'muted', style: { fontSize: '12px' } }, hint) : null);
  }

  function render() {
    formEl.replaceChildren();
    const countries = arr('countries');
    formEl.append(select('Страна', countries, Math.max(0, countries.indexOf(f.country || '')), (i) => { f.country = i ? countries[i] : ''; }));
    formEl.append(select('Категория', arr('categories'), f.category || 0, (i) => { f.category = i || null; }));

    // Жанры + режим
    const genreHint = h('div', { class: 'muted', style: { fontSize: '12px' } });
    const warn = h('div', { style: { fontSize: '12px', color: 'var(--warning)' } });
    const upd = () => {
      genreHint.textContent = GENRE_HINTS[f.genresMode];
      warn.textContent = f.genresMode === 0 && f.genres.length > 3 ? 'Выбрано слишком много жанров. Возможно, результат поиска не даст результатов.' : '';
    };
    const modeChips = h('div', { class: 'chips', style: { marginBottom: '8px' } }, [[1, 'Хотя бы один'], [0, 'Все выбранные'], [2, 'Без выбранных']].map(([m, l]) => {
      const b = h('button', { class: `chip ${f.genresMode === m ? 'on' : ''}`, type: 'button' }, l);
      b.onclick = () => { f.genresMode = m; [...modeChips.children].forEach((x) => x.classList.remove('on')); b.classList.add('on'); upd(); };
      return b;
    }));
    const genreBox = h('div', { class: 'chips' });
    for (const g of arr('genres')) {
      if (g.startsWith('@')) { genreBox.append(h('div', { style: { width: '100%', fontSize: '12px', color: 'var(--text2)', marginTop: '6px' } }, g.slice(1))); continue; }
      const c = h('button', { class: `chip ${f.genres.includes(g) ? 'on' : ''}`, type: 'button' }, g);
      c.onclick = () => { const i = f.genres.indexOf(g); if (i >= 0) f.genres.splice(i, 1); else f.genres.push(g); c.classList.toggle('on'); upd(); };
      genreBox.append(c);
    }
    upd();
    formEl.append(h('h4', null, 'Жанры'), modeChips, genreHint, warn, h('div', { style: { margin: '8px 0 14px' } }, genreBox));

    formEl.append(multi('Исключить закладки', arr('profile_lists').map((l, i) => ({ label: l, value: i })), f.exclusions, null,
      'Исключит из выдачи все релизы, содержащиеся в вышеуказанных списках закладок.'));
    const typesHolder = h('div');
    formEl.append(typesHolder);
    const paintTypes = (list) => typesHolder.replaceChildren(multi('Варианты озвучек', list.map((x) => ({ label: x.name, value: x.id })), f.types));
    if (typesCache) paintTypes(typesCache); else A.types_all().then((r) => { typesCache = r.types || []; paintTypes(typesCache); }).catch(() => {});

    const studios = arr('studios');
    formEl.append(select('Студия', studios, Math.max(0, studios.indexOf(f.studio || '')), (i) => { f.studio = i ? studios[i] : ''; }));
    const sources = arr('sources');
    formEl.append(select('Первоисточник', sources, Math.max(0, sources.indexOf(f.source || '')), (i) => { f.source = i ? sources[i] : ''; }));

    // Года 1917..текущий+2
    const maxY = new Date().getFullYear() + 2;
    const years = ['Неважно']; for (let y = maxY; y >= 1917; y--) years.push(String(y));
    const ys = h('select', { class: 'input' }, years.map((y) => h('option', { value: y === 'Неважно' ? '' : y }, y)));
    const ye = h('select', { class: 'input' }, years.map((y) => h('option', { value: y === 'Неважно' ? '' : y }, y)));
    ys.value = f.startYear ? String(f.startYear) : ''; ye.value = f.endYear ? String(f.endYear) : '';
    const updY = () => {
      if (ys.value && !ye.value) ye.value = String(maxY);
      if (ye.value && !ys.value) ys.value = '1917';
      f.startYear = ys.value ? Number(ys.value) : null; f.endYear = ye.value ? Number(ye.value) : null;
    };
    ys.onchange = updY; ye.onchange = updY;
    formEl.append(h('div', { class: 'field' }, h('label', null, 'Года'), h('div', { class: 'row' }, ys, h('span', null, '—'), ye)));

    formEl.append(select('Сезон', arr('seasons'), f.season || 0, (i) => { f.season = i || null; }));
    formEl.append(select('Эпизодов', arr('episodes'), f.episodes || 0, (i) => { f.episodes = i; }));
    formEl.append(select('Статус', arr('statuses'), f.status || 0, (i) => { f.status = i || null; }));
    formEl.append(select('Длительность эпизода', arr('episodeDurations'), f.duration || 0, (i) => { f.duration = i; }));
    formEl.append(multi('Возрастное ограничение', arr('ageRatings').map((l, i) => ({ label: l, value: i + 1 })), f.ageRatings));
    const sortPos = Math.max(0, SORT_MAP.findIndex(([v]) => v === (f.sort ?? 0)));
    const sortHint = h('div', { class: 'muted', style: { fontSize: '12px' } }, SORT_MAP[sortPos][1]);
    const sortField = select('Сортировка', arr('sort'), sortPos, (i) => { f.sort = SORT_MAP[i][0]; sortHint.textContent = SORT_MAP[i][1]; });
    sortField.append(sortHint);
    formEl.append(sortField);
  }
  render();

  const isEmpty = () => !f.country && !f.category && !f.genres.length && !f.exclusions.length && !f.types.length && !f.studio && !f.source && !f.startYear && !f.season && !f.episodes && !f.status && !f.duration && !f.ageRatings.length && !f.sort;
  const actions = h('div', { class: 'filter-actions' },
    h('button', { class: 'btn btn-tonal', onclick: () => { for (const k of Object.keys(f)) delete f[k]; f.genres = []; f.exclusions = []; f.types = []; f.ageRatings = []; f.genresMode = 1; render(); } }, 'Сбросить'),
    h('button', {
      class: 'btn btn-primary', style: { flex: 1 },
      onclick: () => {
        if (customTab) {
          setCustomFilter(isEmpty() ? null : { ...f });
          toast('Сохранено');
          window.dispatchEvent(new CustomEvent('custom-filter-changed'));
          history.back();
        } else navigate('filtered', { form: { ...f } });
      },
    }, 'Применить'));
  void dialog; void icon; void replace;
  return h('div', null, backToolbar(customTab ? 'Настройки вкладки' : t('filter')), formEl, actions);
});
