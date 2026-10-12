// Озвучки, источники и серии; выбор плеера
import { h, icon, iconButton, img, toast, dialog, sheet, spinner, errorView, emptyView, skeleton, skParts } from '../ui.js';
import { A, auth } from '../api.js';
import { t, prefs, db } from '../store.js';
import { registerScreen, replace } from '../router.js';
import { backToolbar, digits } from './common.js';
import { resolveEpisode, openBuiltinPlayer, openWebPlayer, openThirdParty, isKodik, showKodikAd } from '../player.js';

// Скелетон: список озвучек/источников (type-row) или серий (ep-row)
function episodesSkeleton({ release, type, source }) {
  const bar = backToolbar(type && !source ? type.name : release?.title_ru || t('unnamed'));
  if (type && source) return [bar, skeleton('episodes')];
  return [bar, h('div', { class: 'section-head' }, skParts.line('170px', 'title', { height: '20px' })), skeleton('types', 4)];
}

// Экран 1: варианты озвучки (types)
registerScreen('episodes', async ({ release, type, source, sourceId, pick }, ctx) => {
  if (type && source) return episodesList(release, type, source, ctx);
  if (type) return sourcesList(release, type, sourceId, pick);
  const r = await A.types(release.id);
  const types = r.types || [];
  // Автооткрытие: запомненные озвучка/источник (IS_REMEMBERING_TYPE_SOURCE) или единственный вариант
  const last = db.lastWatched(release.id);
  if (!pick && prefs.get('IS_REMEMBERING_TYPE_SOURCE') && last) {
    const ty = types.find((x) => x.id === last.typeId);
    if (ty) { setTimeout(() => replace('episodes', { release, type: ty, sourceId: last.sourceId }), 0); return h('div', null, ...episodesSkeleton({ release, type: ty, source: true })); }
  }
  if (types.length === 1 && !pick) { setTimeout(() => replace('episodes', { release, type: types[0] }), 0); return h('div', null, ...episodesSkeleton({ release, type })); }
  const root = h('div', null, backToolbar(release.title_ru || t('unnamed')));
  if (!types.length) { root.append(emptyView('Серии пока не добавлены')); return root; }
  root.append(h('div', { class: 'section-head' }, h('div', { class: 'section-title' }, 'Выберите озвучку')));
  root.append(h('div', { class: 'list' }, types.map((ty) => h('div', { class: 'type-row', onclick: () => ctxNavigate(release, ty) },
    ty.icon ? img(ty.icon) : h('div', { class: 'ph' }, icon(ty.is_sub ? 'ic_text_search_variant' : 'ic_voice')),
    h('div', { class: 'grow' },
      h('div', { style: { fontWeight: 500 } }, ty.name, ty.pinned ? icon('ic_pin', 'xs') : null),
      h('div', { class: 'muted', style: { fontSize: '13px' } }, [ty.workers, ty.episodes_count != null ? `${ty.episodes_count} эп.` : "", ty.view_count ? `${digits(ty.view_count)} просмотров` : ''].filter(Boolean).join(' • '))),
    icon('ic_chevron_end')))));
  return root;
}, episodesSkeleton);

function ctxNavigate(release, type) {
  import('../router.js').then(({ navigate }) => navigate('episodes', { release, type }));
}

async function sourcesList(release, type, sourceId, pick) {
  const r = await A.sources(release.id, type.id);
  const sources = r.sources || [];
  const remembered = sourceId && sources.find((s) => s.id === sourceId);
  if (remembered && !pick) { setTimeout(() => replace('episodes', { release, type, source: remembered }), 0); return h('div', null, ...episodesSkeleton({ release, type, source: true })); }
  if (sources.length === 1 && !pick) { setTimeout(() => replace('episodes', { release, type, source: sources[0] }), 0); return h('div', null, ...episodesSkeleton({ release, type, source: true })); }
  const root = h('div', null, backToolbar(type.name));
  if (!sources.length) { root.append(emptyView('Источники не найдены')); return root; }
  root.append(h('div', { class: 'section-head' }, h('div', { class: 'section-title' }, 'Выберите источник')));
  root.append(h('div', { class: 'list' }, sources.map((s) => h('div', {
    class: 'type-row',
    onclick: () => import('../router.js').then(({ navigate }) => navigate('episodes', { release, type, source: s })),
  }, h('div', { class: 'ph' }, icon('ic_source')), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 500 } }, s.name), h('div', { class: 'muted', style: { fontSize: '13px' } }, s.episodes_count != null ? `${s.episodes_count} эп.` : "")), icon('ic_chevron_end')))));
  return root;
}

async function episodesList(release, type, source, ctx) {
  let sort = Number(localStorage.getItem('anixart.pref.EPISODES_SORT') || 1);
  const root = h('div');
  const listEl = h('div', { class: 'ep-list' });
  let episodes = [];

  async function load() {
    listEl.replaceChildren(skeleton('episodes'));
    try {
      const r = await A.episodes(release.id, type.id, source.id, sort);
      episodes = r.episodes || [];
    } catch (e) { listEl.replaceChildren(errorView(e, load)); return; }
    // Слияние с локальной БД
    const local = db.watchedOf(release.id, source.id);
    for (const ep of episodes) {
      ep.releaseId = release.id; ep.sourceId = source.id;
      if (auth.loggedIn) {
        if (ep.is_watched && !(ep.position in local)) db.putEpisode(release.id, source.id, ep.position, { isWatched: true });
        if (!ep.is_watched && ep.position in local) db.putEpisode(release.id, source.id, ep.position, { isWatched: false, playbackPosition: 0 });
      } else ep.is_watched = ep.position in local;
    }
    paint();
  }

  function paint() {
    listEl.replaceChildren();
    if (!episodes.length) { listEl.append(emptyView('Серии не найдены')); return; }
    let lastIdx = -1;
    episodes.forEach((ep, i) => { if (ep.is_watched) lastIdx = i; });
    episodes.forEach((ep, i) => {
      const row = h('div', { class: `ep-row ${ep.is_watched ? 'watched' : ''} ${i === lastIdx ? 'last' : ''}`, onclick: () => onEpisode(i) },
        h('div', { class: 'num' }, ep.is_watched ? icon('ic_check', 'sm') : String(ep.position)),
        h('div', { class: 'grow' },
          h('div', { style: { fontWeight: 500 } }, ep.name || `${ep.position} серия`, ep.is_filler ? h('span', { class: 'badge', style: { marginLeft: '8px' } }, 'филлер') : null),
          h('div', { class: 'muted', style: { fontSize: '12px' } }, [source.name, ep.addedDate ? new Date(ep.addedDate * 1000).toLocaleDateString('ru-RU') : ''].filter(Boolean).join(' • '))),
        iconButton(ep.is_watched ? 'ic_eye_off_outline' : 'ic_eye_outline', ep.is_watched ? 'Снять отметку' : 'Отметить просмотренной', (e) => { e.stopPropagation(); toggleWatched(ep); }, 'sm'));
      listEl.append(row);
    });
    const last = listEl.querySelector('.ep-row.last');
    if (last) requestAnimationFrame(() => last.scrollIntoView({ block: 'center' }));
  }

  async function toggleWatched(ep) {
    const v = !ep.is_watched;
    if (auth.loggedIn) {
      try { await (v ? A.episodeWatch(release.id, source.id, ep.position) : A.episodeUnwatch(release.id, source.id, ep.position)); } catch { /* ignore */ }
    }
    db.putEpisode(release.id, source.id, ep.position, v ? { isWatched: true } : { isWatched: false, playbackPosition: 0 });
    ep.is_watched = v;
    paint();
  }

  async function markAll(v) {
    if (auth.loggedIn) {
      try { await (v ? A.episodeWatch(release.id, source.id) : A.episodeUnwatch(release.id, source.id)); } catch { /* ignore */ }
    }
    db.setAllWatched(release.id, source.id, episodes.map((e) => e.position), v);
    episodes.forEach((e) => { e.is_watched = v; });
    paint();
  }

  async function onEpisode(i) {
    const ep = episodes[i];
    if (!prefs.get('ON_EPISODE_DISCLAIMER')) {
      const ok = await new Promise((resolve) => dialog({
        title: 'Внимание', content: h('p', null, t('on_episode_disclaimer')),
        actions: [{ label: 'Отмена', onClick: () => resolve(false) }, { label: 'Понятно', primary: true, onClick: () => { prefs.set('ON_EPISODE_DISCLAIMER', true); resolve(true); } }],
        onClose: () => resolve(false),
      }));
      if (!ok) return;
    }
    let player = prefs.get('SELECTED_PLAYER');
    if (player === 0) player = await choosePlayer();
    if (!player) return;
    play(i, player);
  }

  async function play(i, player) {
    const ep = episodes[i];
    // До начала воспроизведения
    db.addLastWatched(release.id, type.id, source.id, ep.position);
    if (auth.loggedIn) {
      A.historyAdd(release.id, source.id, ep.position).then(() => { release.is_viewed = true; release.last_view_episode = ep; release.last_view_timestamp = Math.floor(Date.now() / 1000); }).catch(() => {});
      A.episodeWatch(release.id, source.id, ep.position).catch(() => {});
    }
    db.putEpisode(release.id, source.id, ep.position, { isWatched: true });
    ep.is_watched = true;
    paint();
    if (player === 1) { openWebPlayer(ep, release); return; }
    // Встроенный / сторонний: episode/target → парсер
    const loading = dialog({ title: 'Загрузка…', content: spinner() });
    try {
      if (isKodik(ep.url) && prefs.get('KODIK_IFRAME_AD') && prefs.get('SELECTED_KODIK_VIDEO_QUALITY') === 0) {
        loading.close();
        if (!(await kodikAdFlow(ep))) return;
      }
      const res = await resolveEpisode(ep);
      loading.close();
      if (player === 2) openBuiltinPlayer({ release, episodes, index: i, sort, resolved: res });
      else openThirdParty(ep, release, res);
    } catch (e) {
      loading.close();
      dialog({
        title: t('error_cannot_launch_player'),
        content: h('p', null, `${t('error_cannot_play_in_selected_player')}`),
        actions: [{ label: t('close') }, { label: t('player_web'), primary: true, onClick: () => openWebPlayer(ep, release) }],
      });
    }
  }

  async function kodikAdFlow(ep) {
    if (!prefs.get('KODIK_AD_DISCLAIMER')) {
      const choice = await new Promise((resolve) => dialog({
        title: t('kodik_ad_disclaimer_title'), content: h('p', null, t('kodik_ad_disclaimer_desc')),
        actions: [
          { label: 'Среднее качество (480p, без рекламы)', onClick: () => { prefs.set('SELECTED_KODIK_VIDEO_QUALITY', 1); resolve('medium'); } },
          { label: t('action_continue'), primary: true, onClick: () => { prefs.set('KODIK_AD_DISCLAIMER', true); resolve('ad'); } },
        ],
        onClose: () => resolve(null),
      }));
      if (!choice) return false;
      if (choice === 'medium') return true;
    }
    const tr = await A.episodeTarget(release.id, source.id, ep.position).catch(() => null);
    await showKodikAd(tr?.episode?.url || ep.url);
    return true;
  }

  const toolbar = backToolbar(`${type.name} • ${source.name}`, [
    iconButton(sort === 1 ? 'ic_sort_ascending' : 'ic_sort_descending', 'Сортировка', () => { sort = sort === 1 ? 2 : 1; localStorage.setItem('anixart.pref.EPISODES_SORT', String(sort)); replace('episodes', { release, type, source }); }),
    iconButton('ic_more', 'Ещё', () => sheet(null, [
      { label: t('watch_marks_add') !== 'watch_marks_add' ? t('watch_marks_add') : 'Отметить все', icon: 'ic_done_all', onClick: () => markAll(true) },
      { label: t('watch_marks_remove') !== 'watch_marks_remove' ? t('watch_marks_remove') : 'Снять все отметки', icon: 'ic_remove_done', onClick: () => markAll(false) },
      { label: 'Сменить озвучку', icon: 'ic_voice', onClick: () => replace('episodes', { release, pick: true }) },
      { label: t('player'), icon: 'ic_play_circle', onClick: () => choosePlayer(true) },
    ])),
  ]);
  root.append(toolbar, h('div', { class: 'container', style: { padding: 0, maxWidth: '900px' } }, listEl));
  load();
  window.addEventListener('player-closed', function onClose(e) {
    if (!root.isConnected) { window.removeEventListener('player-closed', onClose); return; }
    if (e.detail.releaseId === release.id) { const local = db.watchedOf(release.id, source.id); episodes.forEach((x) => { if (x.position in local) x.is_watched = true; }); paint(); }
  });
  void ctx;
  return root;
}

// Диалог выбора плеера
export function choosePlayer(settingsOnly = false) {
  return new Promise((resolve) => {
    let remember = prefs.get('SELECTED_PLAYER') !== 0;
    const cb = h('input', { type: 'checkbox' }); cb.checked = !remember;
    const items = [
      [2, t('player_embedded'), t('player_embedded_desc'), 'ic_play_circle'],
      [1, t('player_web'), t('player_web_desc'), 'ic_open_in_new'],
      [3, t('player_third_party'), 'mpv или VLC, установленный на компьютере', 'ic_open_link'],
    ];
    let done = false;
    const list = h('div', { class: 'sheet-list' }, items.map(([id, title, desc, ic]) => h('button', {
      class: `sheet-item ${prefs.get('LAST_SELECTED_PLAYER') === id ? 'checked' : ''}`,
      onclick: () => {
        done = true;
        prefs.set('LAST_SELECTED_PLAYER', id);
        prefs.set('SELECTED_PLAYER', cb.checked ? 0 : id);
        d.close();
        resolve(settingsOnly ? null : id);
      },
    }, icon(ic), h('div', { class: 'grow' }, h('div', null, title), h('div', { class: 'muted', style: { fontSize: '12px' } }, desc)))));
    const d = dialog({
      title: t('title_choose_player'), cls: 'sheet',
      content: h('div', null, list, h('label', { class: 'row', style: { padding: '10px 24px 4px' } }, cb, t('player_always_ask'))),
      onClose: () => { if (!done) resolve(null); },
    });
    void remember;
  });
}
