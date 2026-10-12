// Обзор: популярное, смотрят сейчас, рекомендации, расписание
import { h, icon, img, tabs, skeleton, skParts, errorView, dialog, emptyView } from '../ui.js';
import { A, auth } from '../api.js';
import { t } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { mainToolbar, releaseRow, releaseCard, sectionHead, commentItem, collectionCard, openRelease, episodesText, gradeText, backToolbar, emptyFilter } from './common.js';
import { releaseList } from './home.js';

const TILE_COLORS = {
  popular: ['#fbe9e7', '#ff5722'], schedule: ['#e3f2fd', '#2196f3'], collections: ['#f3e5f5', '#ab47bc'],
  filter: ['#e0f2f1', '#009688'], random: ['#e8f5e9', '#4caf50'], vk: ['#e8f0fb', '#0077ff'], tg: ['#e5f4fb', '#2aabee'],
};
function tile(key, label, ic, onClick) {
  const [bg, fg] = TILE_COLORS[key];
  return h('button', { class: 'tile', onclick: onClick, style: { '--tile-bg': bg, '--tile-fg': fg } },
    h('span', { class: 'tile-ic', style: { background: bg, color: fg, width: '40px', height: '40px', borderRadius: '12px', display: 'grid', placeItems: 'center' } }, icon(ic)),
    h('span', null, label));
}

function discussRow(rel) {
  const row = releaseRow(rel);
  const info = row.querySelector('.info');
  info.querySelector('.desc')?.remove();
  info.append(h('div', { class: 'muted', style: { fontSize: '13px' }, html: t('format_comments_count', `<b>${rel.comment_per_day_count ?? 0}</b>`) }));
  return row;
}

let recPrev = -1; let colPrev = -1;

registerScreen('tab:discover', async (_p, ctx) => {
  const root = h('div', null, mainToolbar());
  const body = h('div', null, skeleton('discover', 0, { recs: auth.loggedIn }));
  root.append(body);
  async function load() {
    body.replaceChildren(skeleton('discover', 0, { recs: auth.loggedIn }));
    const [rec, interesting, watching, discussing, cols, comments] = await Promise.allSettled([
      auth.loggedIn ? A.recommendations(-1, recPrev) : Promise.resolve({ content: [] }),
      A.interesting(),
      A.watching(0),
      A.discussing(),
      A.collections(-1, colPrev, 2, 4),
      A.commentsWeek(),
    ]);
    const v = (r) => (r.status === 'fulfilled' && r.value && Array.isArray(r.value.content) ? r.value : { content: [] });
    if ([rec, interesting, watching, discussing, cols, comments].every((r) => r.status === 'rejected')) {
      body.replaceChildren(errorView(rec.reason, load));
      return;
    }
    if (v(rec).current_page != null) recPrev = v(rec).current_page;
    if (v(cols).current_page != null) colPrev = v(cols).current_page;
    body.replaceChildren();

    // 1. Интересное
    const ints = v(interesting).content;
    if (ints.length) {
      body.append(h('div', { class: 'banners' }, ints.map((it) => h('div', {
        class: 'banner',
        onclick: () => {
          if (it.type === 1) navigate('release', { id: Number(it.action) });
          else if (it.type === 2) window.open(it.action, '_blank');
          else if (it.type === 3) navigate('collection', { id: Number(it.action) });
        },
      }, img(it.image), h('div', { class: 'cap' }, h('b', null, it.title), h('span', null, it.description))))));
    }
    // 2. Супер-меню
    body.append(h('div', { class: 'tiles' },
      tile('popular', t('title_popular'), 'ic_popular', () => navigate('top')),
      tile('schedule', t('schedule'), 'ic_calendar', () => navigate('schedule')),
      tile('collections', t('collections'), 'ic_collection', () => navigate('collections')),
      tile('filter', t('filter'), 'ic_tune', () => navigate('filter', {})),
      tile('random', t('label_random'), 'ic_shuffle', () => navigate('release', { random: 1 }))));
    // 3. Рекомендации
    if (auth.loggedIn) {
      const items = v(rec).content;
      body.append(sectionHead(t('label_recommendations'), items.length >= 25 ? () => navigate('recommendations') : null, t('label_based_on_votes')));
      if (items.length) body.append(h('div', { class: 'hscroll' }, items.map(releaseCard)));
      else {
        body.append(h('div', { class: 'card', style: { margin: '0 20px' } },
          h('div', { class: 'muted' }, t('no_recommendations_hint')),
          h('button', { class: 'btn btn-text', style: { marginTop: '8px', paddingLeft: 0 }, onclick: () => dialog({ title: t('information'), content: h('p', { style: { whiteSpace: 'pre-line' } }, t('no_recommendation_info')), actions: [{ label: t('understand'), primary: true }] }) }, t('more_details'))));
      }
    }
    // 4. Обсуждаемое сегодня
    const disc = v(discussing).content;
    if (disc.length) {
      body.append(sectionHead(t('label_discussed_today')));
      body.append(h('div', { class: 'list' }, disc.map(discussRow)));
    }
    // 5. Соцсети
    const baseUrl = (window.__toggles && window.__toggles.baseUrl) || 'https://anixart-app.com/';
    body.append(h('div', { class: 'tiles' },
      tile('vk', t('label_we_are_vk'), 'ic_vk', () => window.open('https://vk.com/public94475547', '_blank')),
      tile('tg', t('label_we_are_telegram'), 'ic_telegram', () => window.open(`${baseUrl}tg`, '_blank'))));
    // 6. Смотрят сейчас
    const w = v(watching).content;
    if (w.length) {
      body.append(sectionHead(t('label_watching_now'), w.length >= 25 ? () => navigate('watching') : null));
      body.append(h('div', { class: 'hscroll' }, w.map(releaseCard)));
    }
    // 7. Коллекции недели
    const c = v(cols).content;
    if (c.length) {
      body.append(sectionHead(t('collections_week'), () => navigate('collections', { sort: 4 })));
      body.append(h('div', { class: 'hscroll' }, c.map((x) => h('div', { style: { width: '260px', flex: 'none' } }, collectionCard(x)))));
    }
    // 8. Комментарии недели
    const cm = v(comments).content;
    if (cm.length) {
      body.append(sectionHead(t('comments_week')));
      body.append(h('div', { class: 'list' }, cm.map((x) => commentItem(x, { kind: 'release', showTarget: true }))));
    }
    body.append(h('div', { style: { height: '30px' } }));
  }
  ctx.setOnShow(() => {});
  load();
  return root;
});

// Популярное: 4 вкладки, только страница 0, sort 3
registerScreen('top', () => {
  const tab = (patch) => () => releaseList(async (page) => (page === 0 ? A.filter(0, { ...emptyFilter(), ...patch, sort: 3 }, true) : { content: [] }), { rank: true });
  return h('div', null, backToolbar(t('title_popular')),
    tabs([
      { title: t('tab_title_ongoing'), render: tab({ status_id: 2, episodes_from: 1, episodes_to: 48 }) },
      { title: t('tab_title_finished'), render: tab({ status_id: 1 }) },
      { title: t('tab_title_movies'), render: tab({ category_id: 2 }) },
      { title: t('tab_title_ova'), render: tab({ category_id: 3 }) },
    ]));
});

registerScreen('watching', () => h('div', null, backToolbar(t('label_watching_now')), releaseList((page) => A.watching(page))));

// Рекомендации (Pagination: случайный старт, previous_page)
registerScreen('recommendations', () => {
  let N = 0; let cur = -1; const visited = new Set(); let first = true;
  return h('div', null, backToolbar(t('label_recommendations')), releaseList(async () => {
    let page; let prev;
    if (first) { page = -1; prev = -1; first = false; } else {
      prev = cur;
      page = N ? (cur + 1) % N : cur + 1;
      if (visited.has(page)) { page = [...Array(N).keys()].find((i) => !visited.has(i)); if (page == null) return { content: [] }; }
    }
    const r = await A.recommendations(page, prev);
    N = r.total_page_count || N; cur = r.current_page ?? page; visited.add(cur);
    return r;
  }));
});

// Расписание
const DAYS = [['monday', 'Понедельник'], ['tuesday', 'Вторник'], ['wednesday', 'Среда'], ['thursday', 'Четверг'], ['friday', 'Пятница'], ['saturday', 'Суббота'], ['sunday', 'Воскресенье']];
function scheduleHintShown() { try { return localStorage.getItem('anixart.pref.SCHEDULE_EPISODE') !== 'false'; } catch { return true; } }

registerScreen('schedule', async () => {
  const root = h('div', null, backToolbar(t('schedule')));
  const r = await A.schedule();
  let hint = true;
  try { hint = localStorage.getItem('anixart.pref.SCHEDULE_EPISODE') !== 'false'; } catch { /* ignore */ }
  if (hint) {
    const card = h('div', { class: 'card', style: { margin: '6px 20px 10px', display: 'flex', gap: '10px', alignItems: 'flex-start' } },
      icon('ic_info_outline'), h('div', { class: 'grow muted' }, 'В расписании указаны дни недели, в которые выходят новые серии представленных релизов в Японии и Китае. Уже переведенные серии в озвучке и субтитрах появляются позже.'),
      h('button', { class: 'icon-btn sm', onclick: () => { card.remove(); try { localStorage.setItem('anixart.pref.SCHEDULE_EPISODE', 'false'); } catch { /* ignore */ } } }, icon('ic_close')));
    root.append(card);
  }
  const today = (new Date().getDay() + 6) % 7;
  let any = false;
  DAYS.forEach(([key, label], i) => {
    const list = r[key] || [];
    if (!list.length) return;
    any = true;
    root.append(h('div', { class: `day-title ${i === today ? 'today' : ''}` }, label, i === today ? h('span', { style: { marginLeft: '8px', display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 0 4px color-mix(in srgb, var(--green) 30%, transparent)' } }) : null));
    root.append(h('div', { class: 'hscroll' }, list.map((rel) => h('div', { class: 'release-card', style: { width: '120px', flex: 'none' }, onclick: () => openRelease(rel) },
      h('div', { class: 'poster', style: { width: '100%' } }, img(rel.image)),
      h('div', { class: 't clamp2', style: { fontSize: '13px' } }, rel.title_ru || t('unnamed')),
      h('div', { class: 'meta' }, episodesText(rel))))));
    root.append(h('div', { class: 'sep', style: { marginTop: '10px' } }));
  });
  if (!any) root.append(emptyView('Расписание пусто'));
  void gradeText;
  return root;
}, () => [backToolbar(t('schedule')),
  scheduleHintShown() ? h('div', { class: 'card', style: { margin: '6px 20px 10px', display: 'flex', gap: '10px', alignItems: 'flex-start' } },
    skParts.circle('24px'), skParts.col('8px', skParts.line('96%'), skParts.line('70%'))) : null,
  skeleton('schedule')]);
