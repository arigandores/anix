// Экспорт и импорт закладок (как «Данные» в настройках Anixart: DataPreferenceFragment, BookmarksExportDialogFragment,
// BookmarksImportDialogFragment). Вход — меню «Ещё» в шапке закладок (bookmarks.js)
import { h, icon, dialog, toast } from '../ui.js';
import { bookmarksExport, bookmarksImportStatus, bookmarksImport } from '../api.js';
import { t } from '../store.js';
import { ANDROID } from '../platform.js';
import { requireAuth, LIST_NAMES } from './common.js';

// profile_lists_values: 0 — избранное, 1–5 — статусы
const LISTS = ['Избранное', 'Смотрю', 'В планах', 'Просмотрено', 'Отложено', 'Брошено'];
// bookmarks_export_sort: номер пункта меню и есть sort запроса
const SORTS = [[0, 'Названию'], [1, 'Статусу просмотра'], [2, 'Оценке']];
// дополнительные поля (BOOKMARKS_EXTRA_FIELDS_VALUE) — в сервер не уходят, только в файл
const FIELDS = [[0, 'Оригинальное название'], [1, 'Альтернативные названия'], [2, 'Статус просмотра'], [3, 'Моя оценка']];
const FORMATS = [[0, 'Таблица CSV', 'Ваши закладки будут выгружены в виде таблицы'], [1, 'Текстовый документ', 'Ваши закладки будут выгружены в виде текстового документа']];

const cat = (title) => h('div', { class: 'pick-cat' }, title);
function info(title, text) { dialog({ title, content: h('p', null, text), actions: [{ label: 'ОК', primary: true }] }); }
function checks(defs, on) {
  return h('div', { class: 'pick-list' }, defs.map(([v, l]) => {
    const cb = h('input', { type: 'checkbox' }); cb.checked = on.has(v);
    cb.onchange = () => { if (cb.checked) on.add(v); else on.delete(v); };
    return h('label', { class: 'sheet-item' }, cb, l);
  }));
}
function chips(defs, get, set) {
  const box = h('div', { class: 'chips' });
  const paint = () => box.replaceChildren(...defs.map(([v, l]) => h('button', { class: `chip ${v === get() ? 'on' : ''}`, onclick: () => { set(v); paint(); } }, l)));
  paint();
  return box;
}

// Текст файла — как onBookmarksExport в Anixart: CSV — строка заголовков и значения через запятую, TXT — без заголовков,
// через « / » и с подробными «не указано». Названия в кавычках; в CSV кавычки внутри удваиваются (в Anixart — нет,
// и такая строка ломала таблицу)
function exportText(releases, format, fields) {
  const txt = format === 1;
  const q = (s) => (txt ? `"${s}"` : `"${String(s).replace(/"/g, '""')}"`);
  const head = ['#', 'Русское название'];
  if (fields.has(0)) head.push('Оригинальное название');
  if (fields.has(1)) head.push('Альтернативные названия');
  if (fields.has(2)) head.push('Добавлено в избранное', 'Статус просмотра');
  if (fields.has(3)) head.push('Моя оценка');
  const rows = releases.map((rel, i) => {
    const r = [String(i + 1), rel.title_ru ? q(rel.title_ru) : txt ? 'Не указано русское название' : 'Не указано'];
    if (fields.has(0)) r.push(rel.title_original ? q(rel.title_original) : txt ? 'Не указано оригинальное название' : 'Не указано');
    if (fields.has(1)) r.push(rel.title_alt ? q(rel.title_alt.replace(/\n/g, ', ')) : txt ? 'Не указаны альтернативные названия' : 'Не указаны');
    if (fields.has(2)) {
      r.push(rel.is_favorite ? (txt ? 'В избранном' : 'Добавлено') : (txt ? 'Не добавлено в избранное' : 'Не добавлено'));
      r.push(t(LIST_NAMES[rel.profile_list_status] || LIST_NAMES[0]));
    }
    if (fields.has(3)) r.push(rel.your_vote != null ? `${rel.your_vote} из 5` : 'Не оценено');
    return r;
  });
  return txt ? rows.map((r) => `${r.join(' / ')}\n`).join('') : [head, ...rows].map((r) => `${r.join(',')}\n`).join('');
}

function fileName(format) {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `Anixart_Bookmarks_${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.${format === 0 ? 'csv' : 'txt'}`;
}

// Windows и браузер — скачивание файла (Electron без своего обработчика загрузок спрашивает, куда сохранить). С BOM, как
// в Anixart: иначе Excel открывает CSV не в UTF-8. Android: WebView не скачивает blob: — системный «Сохранить как»
// (MainActivity.saveFile); нет его — текст в «Поделиться» (системное меню, shim.js) или копируем
async function saveExport(text, format, n) {
  if (window.anixartNative?.saveFile) {
    const ok = await window.anixartNative.saveFile(fileName(format), format === 0 ? 'text/csv' : 'text/plain', `﻿${text}`);
    if (ok) toast('Файл с закладками сохранён', { ok: true });
    return;
  }
  if (!ANDROID) {
    const url = URL.createObjectURL(new Blob(['﻿', text], { type: format === 0 ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8' }));
    const a = h('a', { href: url, download: fileName(format), style: { display: 'none' } });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('Файл с закладками готов', { ok: true });
    return;
  }
  dialog({
    title: 'Закладки выгружены',
    content: h('p', null, `${fileName(format)}: релизов — ${n}. Отправьте текст в нужное приложение или скопируйте его.`),
    actions: [
      { label: 'Скопировать', onClick: () => navigator.clipboard?.writeText(text).then(() => toast('Скопировано', { ok: true }), () => toast(t('error_load'))) },
      { label: 'Поделиться', primary: true, onClick: () => { navigator.share?.({ text }).catch(() => {}); } },
    ],
  });
}

export function exportBookmarks() {
  if (!requireAuth()) return;
  // по умолчанию — все списки: чаще всего выгружают всё, и «Экспортировать» сразу работает
  const lists = new Set(LISTS.map((_, i) => i)); const fields = new Set();
  let format = 0; let sort = 0;
  const formatSub = h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '6px' } });
  const paintFormat = () => { formatSub.textContent = FORMATS[format][2]; };
  paintFormat();
  dialog({
    title: 'Экспорт закладок', cls: 'scroll-body', // длинное — прокручивается содержимое, кнопки видны всегда
    content: h('div', null,
      cat('Списки'), checks(LISTS.map((l, i) => [i, l]), lists),
      cat('Формат'), chips(FORMATS, () => format, (v) => { format = v; paintFormat(); }), formatSub,
      cat('Сортировать по'), chips(SORTS, () => sort, (v) => { sort = v; }),
      cat('Дополнительные данные'), checks(FIELDS, fields)),
    actions: [{ label: 'Отмена' }, {
      label: 'Экспортировать', primary: true,
      onClick: async () => {
        if (!lists.size) { toast('Вы не выбрали ни одного списка'); return true; }
        try {
          // ответ: { code, releases } (2 — недопустимые списки); дополнительные поля приходят в самих релизах
          const r = await bookmarksExport([...lists].sort((a, b) => a - b), sort);
          if (r.code !== 0 || !Array.isArray(r.releases)) throw new Error();
          saveExport(exportText(r.releases, format, fields), format, r.releases.length);
        } catch { toast(t('error_load')); return true; }
        return false;
      },
    }],
  });
}

// Файл экспорта списка аниме Shikimori (JSON): [{ target_id, target_type, status, … }] — как ShikimoriImporter.
// Статус → список запроса; «Пересматриваю» в Anixart нет — его релизы пользователь переносит в «Смотрю» или «Просмотрено»
const SHIKI = { watching: 'watching', planned: 'plans', completed: 'completed', on_hold: 'holdOn', dropped: 'dropped', rewatching: 'rewatching' };
function parseShikimori(text) {
  const arr = JSON.parse(String(text).replace(/^﻿/, ''));
  if (!Array.isArray(arr)) throw new Error('not array');
  const out = { watching: new Set(), plans: new Set(), completed: new Set(), dropped: new Set(), holdOn: new Set(), rewatching: new Set() };
  for (const x of arr) {
    if (!x || typeof x !== 'object') throw new Error('not object');
    const id = Number(x.target_id);
    if (!Number.isInteger(id)) throw new Error('no target_id');
    // манга — из другого справочника Shikimori, её id совпали бы с чужими аниме (в Anixart этой проверки нет)
    if (x.target_type && x.target_type !== 'Anime') continue;
    const key = SHIKI[x.status];
    if (key) out[key].add(id);
  }
  return out;
}
const importTotal = (d) => Object.values(d).reduce((n, s) => n + s.size, 0);

// «Найден недопустимый список»: куда перенести «Пересматриваю» — 'watching', 'completed' или null (отмена)
function chooseRewatch() {
  return new Promise((resolve) => {
    let done = false;
    const pick = (v) => () => { done = true; resolve(v); };
    dialog({
      title: 'Найден недопустимый список',
      content: h('p', null, 'Списка «Пересматриваю» нет в Anixart. Выберите, в какой из существующих списков поместить релизы'),
      actions: [{ label: 'В список «Смотрю»', onClick: pick('watching') }, { label: 'В список «Просмотрено»', primary: true, onClick: pick('completed') }],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

// onDone — закладки перенесены (экран закладок обновляет список)
export async function importBookmarks({ onDone } = {}) {
  if (!requireAuth()) return;
  // import/status: можно ли сейчас (переносить — раз в месяц)
  let st;
  try { st = await bookmarksImportStatus(); } catch { toast(t('error_load')); return; }
  if (st.code === 2) { info('Ошибка', 'Переносить закладки можно лишь раз в месяц.'); return; }
  if (st.code === 1) { info('Ошибка', 'Невозможно произвести импортирование закладок, попробуйте позже.'); return; }

  let data = null;
  const chosen = h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '8px' } });
  const bad = () => info('Ошибка', 'Данный файл не соответствует формату экспортированных данных выбранного ресурса');
  // файл — системным выбором (на Android — MainActivity onShowFileChooser)
  const file = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  file.onchange = async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    try { data = parseShikimori(await f.text()); } catch { data = null; chosen.textContent = ''; bad(); return; }
    chosen.textContent = `Файл выбран: ${f.name} — релизов: ${importTotal(data)}`;
  };
  dialog({
    title: 'Импорт закладок', cls: 'scroll-body',
    content: h('div', null,
      h('div', { class: 'pick-list' }, h('div', { class: 'sheet-item checked' },
        h('div', { class: 'grow' }, h('div', null, 'Shikimori'), h('div', { class: 'muted', style: { fontSize: '13px' } }, 'Импорт закладок с сайта энциклопедии аниме и манги')),
        icon('ic_check', 'end'))),
      h('p', { style: { marginTop: '12px' } }, 'Чтобы получить файл с данными, перейдите в настройки своего профиля на сайте Shikimori > Список аниме и манги > Экспортировать список > JSON'),
      h('div', null, file, h('button', { class: 'btn btn-tonal', onclick: () => file.click() }, 'Выбрать файл'), chosen),
      h('p', { style: { marginTop: '12px' } }, 'Обратите внимание, что импорт возможен лишь раз в месяц.')),
    actions: [{ label: 'Отмена' }, {
      label: 'Перенести', primary: true,
      onClick: async () => {
        if (!data) { toast('Выберите файл с данными'); return true; }
        if (!importTotal(data)) { toast('В файле нет аниме для переноса'); return true; }
        if (data.rewatching.size) {
          const to = await chooseRewatch();
          if (!to) return true;
          for (const id of data.rewatching) data[to].add(id);
          data.rewatching.clear();
        }
        try {
          const r = await bookmarksImport({
            selected_importer_name: 'Shikimori',
            watching: [...data.watching], plans: [...data.plans], completed: [...data.completed], dropped: [...data.dropped], holdOn: [...data.holdOn],
          });
          if (r.code === 2) info('Ошибка', 'Переносить закладки можно лишь раз в месяц.');
          else if (r.code === 1) info('Ошибка', 'Невозможно произвести импортирование закладок, попробуйте позже.');
          else { info('Импорт закладок', 'Закладки успешно импортированы.'); onDone && onDone(); }
        } catch { toast(t('error_load')); return true; }
        return false;
      },
    }],
  });
}
