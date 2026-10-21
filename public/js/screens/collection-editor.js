// Редактор коллекции (как fragment_collection_editor в Anixart): создание ({}) и правка своей ({ id }).
// Обложка, название, описание, «Доступно только мне», релизы (добавить поиском, убрать, порядок), удаление.
// Запросы — CollectionMyApi: create/edit — тело { title, description, is_private, releases: [id] } (edit заменяет
// состав и порядок целиком), обложка — отдельно после сохранения (editImage, multipart)
import { h, icon, iconButton, img, pagedList, emptyView, toast, dialog, confirmDialog, skParts } from '../ui.js';
import { A } from '../api.js';
import { t } from '../store.js';
import { registerScreen, replace } from '../router.js';
import { backToolbar, episodesText } from './common.js';

const MAX_RELEASES = 100;
// ответы create/edit (CollectionCreateEditResponse); 6–8 (не найдена, чужая, удалена) — общее «не удалось»
const ERRORS = {
  2: 'Неверное название коллекции: минимум 10 и максимум 60 символов.',
  3: 'Неверное описание коллекции: максимум 1000 символов.',
  4: 'Выберите хотя бы один релиз',
  5: 'Вы превысили допустимый еженедельный лимит по созданию коллекций. Попробуйте позже.',
  9: 'Вы превысили допустимый лимит релизов в коллекции',
};
const BANNED = 'Вы не можете создавать или редактировать коллекции в связи с нарушением правил. Подробную информацию вы можете найти на странице своего профиля.';

const trashIcon = () => { const ic = icon('ic_trash_outline'); ic.style.color = 'var(--red)'; return ic; };
const relTitle = (rel) => rel.title_ru || rel.title_original || t('unnamed');
const relMeta = (rel) => [rel.year, episodesText(rel)].filter(Boolean).join(' • ');

registerScreen('collection-editor', async ({ id, releases: initial }, ctx) => {
  let c = null; let items = [];
  if (id) {
    // как в Anixart: коллекция и её полный состав — параллельно
    const [cr, rr] = await Promise.all([A.collection(id), A.collectionMyReleases(id)]);
    c = cr.collection;
    if (cr.code !== 0 || !c) return h('div', null, backToolbar(''), emptyView('Коллекция не найдена'));
    items = [...(rr.content || [])];
  } else items = [...(initial || [])]; // «Новая коллекция» со страницы релиза — релиз уже в списке

  const titleIn = h('input', { class: 'input', maxlength: 60, placeholder: 'Например: Лучшее за осень' });
  titleIn.value = c?.title || '';
  const descIn = h('textarea', { class: 'input', rows: 4, placeholder: 'О чём коллекция — необязательно' });
  descIn.value = c?.description || '';
  const privCb = h('input', { type: 'checkbox' });
  privCb.checked = !!c?.is_private;
  // обложка: выбранный файл ужимается до 16:9 сразу, загружается после сохранения коллекции
  let cover = null; let coverUrl = '';
  const snapshot = () => JSON.stringify([titleIn.value.trim(), descIn.value.trim(), privCb.checked, items.map((r) => r.id)]);
  const initialState = snapshot();
  let saved = false;
  const dirty = () => !saved && (!!cover || snapshot() !== initialState);
  ctx.setDispose(() => { if (coverUrl) URL.revokeObjectURL(coverUrl); });

  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg', style: { display: 'none' } });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg)$/.test(f.type)) { toast('Выбранный файл имеет неверный формат'); return; }
    try {
      cover = await coverBlob(f);
      if (coverUrl) URL.revokeObjectURL(coverUrl);
      coverUrl = URL.createObjectURL(cover);
      paintCover();
    } catch { toast('Выбранный файл имеет неверный формат'); }
  });
  const coverBox = h('div', { class: 'poster', style: { width: '100%', aspectRatio: '16/9', borderRadius: '16px', display: 'grid', placeItems: 'center' } });
  function paintCover() {
    const src = coverUrl || c?.image || '';
    const pick = h('button', {
      class: 'btn btn-tonal',
      style: src ? { position: 'absolute', right: '12px', bottom: '12px' } : null,
      onclick: () => fileIn.click(),
    }, icon(src ? 'ic_pencil' : 'ic_plus', 'sm'), src ? 'Заменить обложку' : 'Загрузить обложку');
    const pic = src ? img(src) : null;
    if (pic) Object.assign(pic.style, { position: 'absolute', inset: '0' });
    coverBox.replaceChildren(...[pic, pick].filter(Boolean));
  }
  paintCover();

  const count = h('span', { class: 'muted' });
  const list = h('div', { class: 'list' });
  function paintList() {
    count.textContent = `${items.length} из ${MAX_RELEASES}`;
    list.replaceChildren(...items.map((rel, i) => editRow(rel, i)));
    if (!items.length) { const e = emptyView('В коллекции пока нет релизов', 'Добавьте хотя бы один релиз', 'ic_collection'); e.classList.add('inline'); list.append(e); }
  }
  const move = (i, d) => { const [x] = items.splice(i, 1); items.splice(i + d, 0, x); paintList(); };
  function editRow(rel, i) {
    const up = iconButton('ic_arrow_upward', 'Выше', () => move(i, -1), 'sm');
    const down = iconButton('ic_arrow_downward', 'Ниже', () => move(i, 1), 'sm');
    up.disabled = i === 0; down.disabled = i === items.length - 1;
    for (const b of [up, down]) if (b.disabled) b.style.opacity = '.35';
    return h('div', { class: 'release-row', 'data-key': rel.id, style: { cursor: 'default', alignItems: 'center' } },
      h('div', { class: 'poster', style: { width: '56px' } }, img(rel.image, '', relTitle(rel))),
      h('div', { class: 'info' }, h('div', { class: 't clamp2' }, relTitle(rel)), relMeta(rel) ? h('div', { class: 'meta' }, relMeta(rel)) : null),
      h('div', { class: 'row', style: { gap: '0', flex: 'none' } }, up, down,
        iconButton('ic_close', 'Убрать из коллекции', () => { items.splice(i, 1); paintList(); }, 'sm')));
  }
  paintList();

  // «Добавить релиз»: поиск по релизам в окне; нажатие добавляет наверх списка (как в Anixart), повторное — убирает
  function addRelease() {
    if (items.length >= MAX_RELEASES) { toast(ERRORS[9]); return; }
    const input = h('input', { placeholder: t('search_bar_text') });
    const results = h('div');
    let timer; let paged = null;
    const pickRow = (rel) => {
      const mark = h('span', { style: { color: 'var(--carmine)', flex: 'none' } });
      const paintMark = () => mark.replaceChildren(items.some((x) => x.id === rel.id) ? icon('ic_check') : '');
      paintMark();
      return h('div', {
        class: 'release-row', style: { alignItems: 'center' },
        onclick: () => {
          const at = items.findIndex((x) => x.id === rel.id);
          if (at >= 0) items.splice(at, 1);
          else if (items.length >= MAX_RELEASES) { toast(ERRORS[9]); return; } else items.unshift(rel);
          paintMark(); paintList();
        },
      }, h('div', { class: 'poster', style: { width: '56px' } }, img(rel.image, '', relTitle(rel))),
      h('div', { class: 'info' }, h('div', { class: 't clamp2' }, relTitle(rel)), relMeta(rel) ? h('div', { class: 'meta' }, relMeta(rel)) : null), mark);
    };
    const run = () => {
      const q = input.value.trim();
      paged?.dispose();
      if (!q) { paged = null; results.replaceChildren(h('div', { class: 'muted', style: { padding: '12px 24px' } }, 'Введите название релиза')); return; }
      paged = pagedList({
        load: (page) => A.searchReleases(page, { query: q, searchBy: 0 }).then((r) => ({ ...r, content: r.releases || [] })),
        render: pickRow,
        empty: () => h('div', { class: 'muted', style: { padding: '12px 24px' } }, 'Ничего не найдено'),
      });
      results.replaceChildren(paged);
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 500); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
    run();
    dialog({
      title: 'Добавить релиз', cls: 'sheet wide scroll-body',
      content: [h('div', { style: { position: 'sticky', top: '0', zIndex: 1, background: 'var(--bg2)', padding: '0 16px 8px' } },
        h('div', { class: 'searchbar', style: { maxWidth: 'none' } }, icon('ic_search'), input)), results],
      actions: [{ label: 'Готово', primary: true }],
      onClose: () => { clearTimeout(timer); paged?.dispose(); },
    });
    setTimeout(() => input.focus(), 30);
  }

  async function save() {
    const title = titleIn.value.trim(); const description = descIn.value.trim();
    // те же проверки, что в Anixart до запроса
    if (title.length < 10 || title.length > 60) { toast(ERRORS[2]); return; }
    if (description.length > 5000) { toast(ERRORS[3]); return; }
    if (!items.length) { toast(ERRORS[4]); return; }
    if (items.length > MAX_RELEASES) { toast(ERRORS[9]); return; }
    const body = { title, description, is_private: privCb.checked, releases: items.map((r) => r.id) };
    saveBtn.disabled = true; saveBtn.style.opacity = '.5';
    try {
      let r;
      try { r = id ? await A.collectionEdit(id, body) : await A.collectionCreate(body); } catch { toast('Не удалось сохранить коллекцию'); return; }
      if (r.code === 402) { dialog({ title: 'Ошибка', content: h('p', null, BANNED), actions: [{ label: 'ОК', primary: true }] }); return; }
      const col = r.collection;
      if (r.code !== 0 || !col) { toast(ERRORS[r.code] || 'Не удалось сохранить коллекцию'); return; }
      let coverFailed = false;
      if (cover) {
        try {
          const u = await A.collectionEditImage(col.id, cover, 'cover.jpg');
          if (u.code === 0 && u.url) col.image = u.url; else coverFailed = true;
        } catch { coverFailed = true; }
      }
      saved = true;
      // экраны коллекции и «Мои коллекции» обновятся (collections.js)
      window.dispatchEvent(new CustomEvent('collection-changed', { detail: { id: col.id, collection: col } }));
      const done = id ? 'Коллекция успешно сохранена' : 'Коллекция успешно создана';
      toast(coverFailed ? `${done}, но обложку загрузить не удалось` : done, { ok: !coverFailed });
      // правка — назад на экран коллекции; новая — вместо редактора открывается сама коллекция
      if (id) history.back(); else replace('collection', { id: col.id, preload: col });
    } finally { saveBtn.disabled = false; saveBtn.style.opacity = ''; }
  }

  async function remove() {
    if (!await confirmDialog('Удалить коллекцию?', 'Вы уверены, что хотите удалить коллекцию?', 'Удалить')) return;
    const d = await A.collectionDelete(id).catch(() => null);
    if (!d || d.code !== 0) { toast('Не удалось удалить коллекцию'); return; }
    saved = true;
    window.dispatchEvent(new CustomEvent('collection-changed', { detail: { id, deleted: true } }));
    toast('Коллекция удалена', { ok: true });
    history.back();
  }

  const saveBtn = iconButton('ic_check', 'Сохранить', save, 'accent');
  const bar = backToolbar(id ? 'Редактирование коллекции' : 'Создание коллекции', [saveBtn]);
  // «Назад» с несохранёнными правками — сначала спросить (как в Anixart); перехват до обработчика самой кнопки
  const backBtn = bar.firstElementChild;
  bar.addEventListener('click', async (e) => {
    if (!backBtn.contains(e.target) || !dirty()) return;
    e.stopPropagation();
    if (await confirmDialog('Подтвердить', 'Если вы закроете эту страницу, данные могут не сохраниться. Вы уверены?', 'Да')) history.back();
  }, true);
  const base = (window.__toggles && window.__toggles.baseUrl) || 'https://anixart-app.com/';
  return h('div', null, bar, fileIn,
    h('div', { style: { maxWidth: '760px', margin: '0 auto', paddingBottom: '40px' } },
      h('div', { style: { padding: '0 var(--gutter)' } },
        coverBox,
        h('div', { class: 'field', style: { marginTop: '16px' } }, h('label', null, 'Название коллекции'), titleIn),
        h('div', { class: 'field' }, h('label', null, 'Описание'), descIn),
        h('label', { class: 'menu-item inset' }, icon('ic_lock'), h('div', { class: 'grow' }, 'Доступно только мне'), h('span', { class: 'switch' }, privCb, h('span'))),
        h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '8px' } }, 'Создавая коллекцию, Вы подтверждаете, что ознакомлены с ',
          h('a', { href: '#', style: { textDecoration: 'underline' }, onclick: (e) => { e.preventDefault(); window.open(`${base}rules`, '_blank'); } }, 'правилами'), '.')),
      h('div', { class: 'section-head' }, h('div', { class: 'section-title' }, 'Релизы'), count, h('div', { class: 'grow' }),
        h('button', { class: 'btn btn-tonal', onclick: addRelease }, icon('ic_plus', 'sm'), 'Добавить релиз')),
      list,
      id ? h('div', { class: 'menu-list', style: { marginTop: '16px' } },
        h('div', { class: 'menu-item', style: { color: 'var(--red)' }, onclick: remove }, trashIcon(), h('div', { class: 'grow' }, 'Удалить коллекцию'))) : null));
}, ({ id }) => {
  // шапка с «Сохранить» — с первого кадра; обложка 16:9, поля, переключатель, затем строки релизов
  const { line, block, circle, pill, col } = skParts;
  const bar = backToolbar(id ? 'Редактирование коллекции' : 'Создание коллекции', [iconButton('ic_check', 'Сохранить', null, 'accent')]);
  const row = () => h('div', { class: 'release-row', style: { alignItems: 'center' } }, h('div', { class: 'poster sk', style: { width: '56px' } }),
    h('div', { class: 'info', style: { gap: '9px' } }, line('64%', 'title'), line('30%')), circle('20px'));
  return [bar, h('div', { style: { maxWidth: '760px', margin: '0 auto' } },
    h('div', { style: { padding: '0 var(--gutter)' } },
      block({ width: '100%', aspectRatio: '16/9', borderRadius: '16px' }),
      h('div', { class: 'field', style: { marginTop: '16px' } }, h('label', null, 'Название коллекции'), block({ height: '48px', borderRadius: '10px' })),
      h('div', { class: 'field' }, h('label', null, 'Описание'), block({ height: '112px', borderRadius: '10px' })),
      h('div', { class: 'menu-item inset' }, circle('24px'), col('0', line('40%', 'title')), block({ width: '44px', height: '24px', borderRadius: '12px', flex: 'none' })),
      line('80%', '', { marginTop: '8px' })),
    h('div', { class: 'section-head' }, line('120px', 'title'), h('div', { class: 'grow' }), pill('170px')),
    h('div', { class: 'list' }, Array.from({ length: 4 }, row)))];
});

// Обложка как в Anixart (обрезка 16:9, не больше 1920×1080): здесь — по центру, без ручной рамки; JPEG
async function coverBlob(file) {
  const bmp = await createImageBitmap(file);
  let sw = bmp.width; let sh = bmp.height;
  if (sw / sh > 16 / 9) sw = Math.round((sh * 16) / 9); else sh = Math.round((sw * 9) / 16);
  const k = Math.min(1, 1920 / sw);
  const cv = h('canvas', { width: Math.round(sw * k), height: Math.round(sh * k) });
  cv.getContext('2d').drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, cv.width, cv.height);
  bmp.close?.();
  return new Promise((ok, fail) => cv.toBlob((b) => (b ? ok(b) : fail(new Error('toBlob'))), 'image/jpeg', 0.92));
}
