// Фильтр (обычный режим → результаты, режим «Настройки вкладки» → своя вкладка)
import { h, icon, dialog, toast } from '../ui.js';
import { A } from '../api.js';
import { t, arr } from '../store.js';
import { registerScreen, navigate } from '../router.js';
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

// Окно выбора нескольких вариантов (как в Anixart: шторка с галочками, «Выбрать все», «Сбросить» и «Выбрать»).
// options: [{label, value, group?}] — group: подзаголовок (жанры, аудитория, тематика); длинный список — с поиском.
// head() — что показать над списком (режим жанров). Возвращает выбранные значения или null (закрыли)
function chooseMany(title, options, selected, head) {
  return new Promise((resolve) => {
    const on = new Set(selected);
    const rows = options.map((o) => {
      const cb = h('input', { type: 'checkbox' }); cb.checked = on.has(o.value);
      cb.onchange = () => { if (cb.checked) on.add(o.value); else on.delete(o.value); paintAll(); };
      return { o, cb, el: h('label', { class: 'sheet-item' }, cb, h('span', null, o.label)) };
    });
    const list = h('div', { class: 'pick-list' });
    let group;
    for (const r of rows) {
      if (r.o.group && r.o.group !== group) { group = r.o.group; list.append(h('div', { class: 'pick-group' }, group)); }
      list.append(r.el);
    }
    const all = h('button', { class: 'btn btn-text pick-all', type: 'button' });
    const shown = () => rows.filter((r) => r.el.style.display !== 'none');
    const paintAll = () => { all.textContent = shown().every((r) => r.cb.checked) ? 'Снять все' : 'Выбрать все'; };
    all.onclick = () => {
      const v = !shown().every((r) => r.cb.checked);
      for (const r of shown()) { r.cb.checked = v; if (v) on.add(r.o.value); else on.delete(r.o.value); }
      paintAll();
    };
    // поиск — у длинных списков (озвучек сотни)
    const search = options.length > 20 ? h('input', { class: 'input pick-search', type: 'search', placeholder: 'Поиск' }) : null;
    if (search) {
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        for (const r of rows) r.el.style.display = !q || r.o.label.toLowerCase().includes(q) ? '' : 'none';
        for (const g of list.querySelectorAll('.pick-group')) g.style.display = q ? 'none' : '';
        paintAll();
      };
    }
    paintAll();
    let done = false;
    dialog({
      title, cls: 'scroll-body pick-dialog',
      content: h('div', null, head ? head() : null, search, h('div', { class: 'pick-tools' }, all), list),
      actions: [
        { label: 'Сбросить', onClick: () => { on.clear(); for (const r of rows) r.cb.checked = false; paintAll(); return true; } },
        { label: 'Выбрать', primary: true, onClick: () => { done = true; resolve(options.map((o) => o.value).filter((v) => on.has(v))); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

registerScreen('filter', ({ customTab = false, form: initial }) => {
  const f = { ...(initial || (customTab ? getCustomFilter() : null) || {}) };
  f.genres = [...(f.genres || [])]; f.exclusions = [...(f.exclusions || [])]; f.types = [...(f.types || [])]; f.ageRatings = [...(f.ageRatings || [])];
  if (f.genresMode == null) f.genresMode = 1;
  const formEl = h('div', { class: 'filter-form' });

  function select(label, options, value, onPick) {
    const sel = h('select', { class: 'input' }, options.map((o, i) => h('option', { value: String(i) }, o)));
    sel.value = String(value ?? 0);
    sel.onchange = () => onPick(Number(sel.value));
    return h('div', { class: 'field' }, h('label', null, label), sel);
  }
  // Несколько вариантов (жанры, закладки, озвучки, возраст) — как в Anixart: поле с выбранным одной строкой, нажатие —
  // окно с галочками (chooseMany). Раньше все варианты стояли на экране чипами сразу (сотни озвучек, полсотни
  // жанров) — экран в 8000 px, нужное не найти. options — список или функция, которая его загрузит
  function multi(label, { options, selected, hint, head, onPicked }) {
    let opts = Array.isArray(options) ? options : null;
    const text = h('span', { class: 'ellipsis grow' });
    const hintEl = hint ? h('div', { class: 'muted', style: { fontSize: '12px' } }) : null;
    const paint = () => {
      const names = opts ? opts.filter((o) => selected.includes(o.value)).map((o) => o.label) : [];
      text.textContent = names.length ? names.join(', ') : selected.length ? `Выбрано: ${selected.length}` : 'Неважно';
      if (hintEl) hintEl.textContent = typeof hint === 'function' ? hint() : hint;
    };
    const btn = h('button', {
      class: 'input pick-field', type: 'button',
      onclick: async () => {
        if (!opts) { try { opts = await options(); } catch { toast(t('error_load')); return; } }
        const picked = await chooseMany(label, opts, selected, head);
        if (!picked) return;
        selected.splice(0, selected.length, ...picked);
        if (onPicked) onPicked();
        paint();
      },
    }, text);
    paint();
    // список с сервера и уже что-то выбрано — подгрузить, чтобы показать названия, а не «Выбрано: 3»
    if (!opts && selected.length) options().then((o) => { opts = o; paint(); }).catch(() => {});
    return h('div', { class: 'field' }, h('label', null, label), btn, hintEl);
  }

  function render() {
    formEl.replaceChildren();
    const countries = arr('countries');
    formEl.append(select('Страна', countries, Math.max(0, countries.indexOf(f.country || '')), (i) => { f.country = i ? countries[i] : ''; }));
    formEl.append(select('Категория', arr('categories'), f.category || 0, (i) => { f.category = i || null; }));

    // Жанры: в окне — режим (хотя бы один / все / без) с подсказкой и группы (жанры, аудитория, тематика)
    const genreOpts = []; let group = null;
    for (const g of arr('genres')) { if (g.startsWith('@')) group = g.slice(1); else genreOpts.push({ label: g, value: g, group }); }
    let mode = f.genresMode;
    const modeHead = () => {
      mode = f.genresMode;
      const hint = h('div', { class: 'muted', style: { fontSize: '12px', margin: '8px 0 0' } }, GENRE_HINTS[mode]);
      const chips = h('div', { class: 'chips pick-modes' }, [[1, 'Хотя бы один'], [0, 'Все выбранные'], [2, 'Без выбранных']].map(([m, l]) => {
        const b = h('button', { class: `chip ${mode === m ? 'on' : ''}`, type: 'button' }, l);
        b.onclick = () => { mode = m; [...chips.children].forEach((x) => x.classList.toggle('on', x === b)); hint.textContent = GENRE_HINTS[m]; };
        return b;
      }));
      return h('div', { class: 'pick-head' }, chips, hint);
    };
    formEl.append(multi('Жанры', {
      options: genreOpts, selected: f.genres, head: modeHead,
      onPicked: () => { f.genresMode = mode; },
      hint: () => (!f.genres.length ? '' : f.genresMode === 0 && f.genres.length > 3 ? 'Выбрано слишком много жанров. Возможно, результат поиска не даст результатов.' : GENRE_HINTS[f.genresMode]),
    }));
    formEl.append(multi('Исключить закладки', {
      options: arr('profile_lists').map((l, i) => ({ label: l, value: i })), selected: f.exclusions,
      hint: 'Исключит из выдачи все релизы, содержащиеся в выбранных списках закладок.',
    }));
    // озвучки — справочник с сервера, загружается к первому открытию окна
    formEl.append(multi('Варианты озвучек', {
      selected: f.types,
      options: () => (typesCache ? Promise.resolve(typesCache) : A.types_all().then((r) => { typesCache = r.types || []; return typesCache; }))
        .then((list) => list.map((x) => ({ label: x.name, value: x.id }))),
    }));

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
    formEl.append(multi('Возрастное ограничение', { options: arr('ageRatings').map((l, i) => ({ label: l, value: i + 1 })), selected: f.ageRatings }));
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
          toast('Сохранено', { ok: true });
          window.dispatchEvent(new CustomEvent('custom-filter-changed'));
          history.back();
        } else navigate('filtered', { form: { ...f } });
      },
    }, 'Применить'));
  void icon;
  return h('div', null, backToolbar(customTab ? 'Настройки вкладки' : t('filter')), formEl, actions);
});
