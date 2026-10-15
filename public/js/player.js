// Плееры: встроенный, веб-плеер и сторонний.
import { h, icon, toast, dialog } from './ui.js';
import { A, auth } from './api.js';
import { prefs, db, t } from './store.js';
import { createUpscale, TIER_LABEL, TIERS, SHARPNESS, SHARP_LABEL, benchPrompt, benchRunDialog } from './upscale/index.js';

const QUALITIES = ['Default', '360p', '480p', '720p', '1080p', '1440p', '2160p']; // utils/domain/release/Quality
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60); const m = Math.floor(sec / 60) % 60; const hh = Math.floor(sec / 3600);
  return (hh ? `${hh}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
}

// Качество: нужное качество или ближайшее меньшее из доступных, иначе первое
function pickQuality(available, wantedIndex) {
  for (let i = wantedIndex; i >= 0; i--) if (available.includes(QUALITIES[i])) return QUALITIES[i];
  return available[0];
}

function initialQuality(available) {
  const pref = prefs.get('SELECTED_VIDEO_QUALITY_V2');
  if (pref === 0) return available[available.length - 1]; // максимальное
  if (pref === 1 || pref === 2) return available[0]; // минимальное
  return pickQuality(available, Math.min(pref - 1, QUALITIES.length - 1)); // 3..7 → 480p..2160p
}

function streamSrc(url, referer, cookie) {
  let s = `/stream?url=${encodeURIComponent(url)}`;
  if (referer) s += `&referer=${encodeURIComponent(referer)}`;
  if (cookie) s += `&cookie=${encodeURIComponent(cookie)}`;
  return s;
}

// episode/target → Parser (на сервере). Возвращает {qualities: {q:url}, referer, cookie, url}
export async function resolveEpisode(ep) {
  let url = ep.url;
  try {
    const r = await A.episodeTarget(ep.releaseId ?? ep.release?.id, ep.sourceId ?? ep.source?.id, ep.position);
    if (r && r.episode && r.episode.url) url = r.episode.url;
  } catch { /* fallback на url из списка */ }
  const q = new URLSearchParams({ url });
  const ua = prefs.sibnetUA(); if (ua) q.set('sibnet_ua', ua);
  const p = await (await fetch(`/parse?${q}`)).json();
  if (p.error && !Object.keys(p.playback || {}).length) throw new Error(p.error);
  const qualities = {};
  for (const k of QUALITIES) if (p.playback && p.playback[k]) qualities[k] = p.playback[k];
  if (!Object.keys(qualities).length) throw new Error('Return 1#null 5#null');
  return { url, qualities, referer: p.referer || url, cookie: p.cookie || '', download: p.download || {}, skip: p.skip || null };
}

// --- Опенинг и эндинг (логика из anixapp, src/views/Watch/_skipMarks.ts) ---
// skip: { opening: {start, end} | null, ending: … } в секундах — от сервера (Kodik parseSkipButton, AniLibria).
// Подрезаем под длительность файла: серия бывает короче, чем метки.
function clampMarks(skip, duration) {
  if (!skip || !(duration > 2)) return skip || null;
  const clamp = (r) => (r && r.start < duration - 1 && Math.min(r.end, duration) - r.start >= 2 ? { start: r.start, end: Math.min(r.end, duration) } : null);
  const opening = clamp(skip.opening); const ending = clamp(skip.ending);
  return opening || ending ? { opening, ending } : null;
}
// Кнопки пропуска — только внутри отмеченного интервала (не с начала серии: сцену до опенинга не вырезаем)
const markActive = (tm, r) => !!r && tm >= r.start - 0.35 && tm < r.end - 0.45;
// После эндинга почти сразу конец файла — вместо «Пропустить» предлагаем следующую серию
const endingAtEpisodeEnd = (r, duration) => !!r && duration > 0 && (duration - r.end <= 12 || r.end / duration >= 0.97);
// Таймлайн режется по границам опенинга и эндинга: каждый кусок — отдельный скруглённый сегмент
function timelineSegments(duration, marks) {
  const all = [{ from: 0, to: 100, kind: 'content' }];
  if (!(duration > 0) || !marks) return all;
  const pct = (tm) => Math.max(0, Math.min(100, (tm / duration) * 100));
  const cuts = new Set([0, 100]);
  for (const r of [marks.opening, marks.ending]) if (r) { cuts.add(pct(r.start)); cuts.add(pct(r.end)); }
  const pts = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const from = pts[i]; const to = pts[i + 1];
    if (to - from < 0.08) continue;
    const mid = (from + to) / 2;
    const inR = (r) => r && mid >= pct(r.start) && mid < pct(r.end);
    out.push({ from, to, kind: inR(marks.opening) ? 'opening' : inR(marks.ending) ? 'ending' : 'content' });
  }
  return out.length ? out : all;
}
const MARK_LABEL = { opening: 'Опенинг', ending: 'Эндинг' };
// Выбор «пропускать / смотреть» — общий для всех релизов, отдельно для опенинга и эндинга:
// 'auto' — пропуск сам после короткого отсчёта, 'watch' или не выбрано — кнопки, которые прячутся через 10 с
const SKIP_PREF = { opening: 'SKIP_OPENING', ending: 'SKIP_ENDING' };
const SKIP_AUTO_MS = 7000; const WATCH_AUTO_MS = 10000;
const PLAY_HIDE_MS = 1200; // после «плей» и автозапуска панель прячется быстрее обычного

// Веб-плеер: iframe → IFRAME_EMBED_URL + urlencode(url), иначе прямая загрузка с Referer
export function openWebPlayer(ep, release) {
  const src = ep.iframe ? prefs.get('IFRAME_EMBED_URL') + encodeURIComponent(ep.url) : ep.url;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) close(); };
  const ov = h('div', { class: 'player-overlay' },
    h('div', { class: 'player-top', style: { position: 'relative', background: '#000' } },
      h('button', { class: 'icon-btn', title: 'Назад', onclick: close }, icon('ic_back')),
      h('div', { class: 'ttl' }, h('b', null, release?.title_ru || ''), h('span', null, ep.name || `${ep.position} серия`)),
      h('button', { class: 'icon-btn', title: 'Во весь экран', onclick: () => ov.requestFullscreen?.() }, icon('ic_player_fill'))),
    h('div', { class: 'player-stage' },
      h('iframe', { src, allow: 'autoplay; fullscreen; encrypted-media; picture-in-picture', allowfullscreen: true, referrerpolicy: 'no-referrer-when-downgrade' })));
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
}

// Встроенный плеер
export function openBuiltinPlayer({ release, episodes, index, sort = 1, resolved }) {
  let idx = index;
  let cur = null; // {ep, res, quality}
  let hls = null;
  let idleTimer = null;
  let retried = false;
  let holdTimer = null; let holding = false; let prevRate = 1;
  const speedIdx = prefs.get('SELECTED_PLAYER_SPEED');

  const video = h('video', { playsinline: true, preload: 'auto' });
  video.playbackRate = SPEEDS[speedIdx] || 1;
  const msg = h('div', { class: 'player-msg' });
  const ttlB = h('b'); const ttlS = h('span');
  const timeEl = h('span', { class: 'time' }, '0:00 / 0:00');
  // Таймлайн: сегменты (обычные и опенинг/эндинг), в каждом — буфер и проигранная часть; ползунок и подсказка
  const segsEl = h('div', { class: 'segs' });
  const knob = h('div', { class: 'knob' });
  const tip = h('div', { class: 'seek-tip' });
  const seek = h('div', { class: 'seek', role: 'slider', 'aria-label': 'Позиция воспроизведения' }, segsEl, knob, tip);
  const playBtn = h('button', { class: 'icon-btn', title: 'Пауза (Пробел)' }, icon('ic_player_pause'));
  const prevBtn = h('button', { class: 'icon-btn', title: 'Предыдущая серия (P)' }, icon('ic_player_previous'));
  const nextBtn = h('button', { class: 'icon-btn', title: 'Следующая серия (N)' }, icon('ic_player_next'));
  const gearBtn = h('button', { class: 'icon-btn gear', title: 'Настройки: качество, скорость, улучшение картинки, пропуск опенинга и эндинга' }, icon('ic_settings'));
  const volume = h('input', { type: 'range', class: 'vol', min: 0, max: 1, step: 0.05, value: 1, title: 'Громкость (↑ ↓, M)' });
  let menu = null;

  // Пропуск опенинга/эндинга: «Смотреть …» и «Пропустить» (или «Следующая серия»), с полосой отсчёта
  const watchFill = h('span', { class: 'fill' }); const watchLabel = h('span', { class: 'lbl' });
  const goFill = h('span', { class: 'fill' }); const goLabel = h('span', { class: 'lbl' });
  const skipWatchBtn = h('button', { class: 'skip-watch' }, watchFill, watchLabel);
  const skipGoBtn = h('button', { class: 'skip-go', title: 'S' }, goFill, goLabel);
  const skipRow = h('div', { class: 'skip-row' }, skipWatchBtn, skipGoBtn);

  const top = h('div', { class: 'player-top' },
    h('button', { class: 'icon-btn', title: 'Закрыть (Esc)', onclick: () => close() }, icon('ic_back')),
    h('div', { class: 'ttl' }, ttlB, ttlS));
  const controls = h('div', { class: 'player-controls' },
    seek,
    h('div', { class: 'row' },
      prevBtn,
      h('button', { class: 'icon-btn', title: '−10 с (←)', onclick: () => seekBy(-10) }, icon('ic_player_rewind_10')),
      playBtn,
      h('button', { class: 'icon-btn', title: '+10 с (→)', onclick: () => seekBy(10) }, icon('ic_player_forward_10')),
      nextBtn,
      h('div', { class: 'grow' }),
      timeEl,
      volume,
      gearBtn,
      h('button', { class: 'icon-btn', title: 'Картинка в картинке', onclick: () => togglePip() }, icon('ic_player_pip')),
      h('button', { class: 'icon-btn', title: 'Во весь экран (F)', onclick: () => toggleFs() }, icon('ic_player_fill'))));
  const stage = h('div', { class: 'player-stage' }, video, msg);
  const ov = h('div', { class: 'player-overlay', tabindex: '-1' }, top, stage, skipRow, controls);

  // --- Улучшение картинки (апскейл нейросетью, upscale/index.js) и шторка сравнения ---
  const splitKnob = h('div', { class: 'knob' }, icon('ic_compare', 'sm'));
  const splitEl = h('div', { class: 'up-split', hidden: true },
    h('div', { class: 'line' }), splitKnob, h('span', { class: 'lbl l' }, 'Оригинал'), h('span', { class: 'lbl r' }, 'Улучшено'));
  stage.append(splitEl);
  const up = createUpscale({
    video, stage,
    onChange: () => { placeSplit(); refreshMenu(); },
    onNotice: (text) => toast(text),
    onBenchPrompt: () => askBenchWhenFree(),
  });
  const upCanvas = stage.querySelector('.up-canvas');
  ov.upscale = up; // для тестов и отладки
  // шторка стоит над картинкой: левее — исходный кадр, правее — улучшенный
  function placeSplit() {
    const on = up.split > 0 && !upCanvas.hidden;
    splitEl.hidden = !on;
    if (!on) return;
    const sr = stage.getBoundingClientRect(); const cr = upCanvas.getBoundingClientRect();
    Object.assign(splitEl.style, { left: `${cr.left - sr.left + up.split * cr.width}px`, top: `${cr.top - sr.top}px`, height: `${cr.height}px` });
  }
  splitEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); splitEl.setPointerCapture(e.pointerId); splitEl.classList.add('drag');
    const move = (ev) => {
      const cr = upCanvas.getBoundingClientRect();
      up.setSplit(Math.min(0.98, Math.max(0.02, (ev.clientX - cr.left) / cr.width))); placeSplit();
    };
    const end = () => { splitEl.classList.remove('drag'); splitEl.removeEventListener('pointermove', move); splitEl.removeEventListener('pointerup', end); };
    splitEl.addEventListener('pointermove', move); splitEl.addEventListener('pointerup', end);
  });
  splitEl.addEventListener('click', (e) => e.stopPropagation());
  window.addEventListener('resize', placeSplit);

  function showMsg(text, spinner = false) {
    msg.replaceChildren(...[spinner ? h('div', { class: 'spinner' }) : null, text ? h('div', { style: { marginTop: '12px', whiteSpace: 'pre-line' } }, text) : null].filter(Boolean));
    msg.style.display = text || spinner ? 'grid' : 'none';
  }

  function savePosition() {
    if (!cur || !video.duration) return;
    const ms = Math.floor(video.currentTime * 1000);
    const dur = Math.floor(video.duration * 1000);
    if (ms < 5000) return;
    const val = ms + 5000 >= dur ? -1 : ms;
    db.putEpisode(cur.ep.releaseId, cur.ep.sourceId, cur.ep.position, { playbackPosition: val, isWatched: true });
  }

  function attach(src) {
    if (hls) { hls.destroy(); hls = null; }
    const isHls = /\.m3u8|:hls:/i.test(decodeURIComponent(src));
    if (isHls && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ maxBufferLength: 60, enableWorker: true });
      hls.on(window.Hls.Events.ERROR, (_e, data) => { if (data.fatal) onFatal(data); });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      video.src = src;
    }
  }

  async function onFatal() {
    // Встроенный плеер: ошибки 2000/2004 → повторный episode/target + парсинг и продолжение (один раз)
    if (retried || !cur) { showMsg(t('error_cannot_play_in_selected_player')); return; }
    retried = true;
    const pos = video.currentTime;
    showMsg('', true);
    try {
      const res = await resolveEpisode(cur.ep);
      cur.res = res;
      const q = res.qualities[cur.quality] ? cur.quality : initialQuality(Object.keys(res.qualities));
      cur.quality = q;
      up.setSourceKey(`${cur.ep.releaseId}:${cur.ep.sourceId}:${q}`);
      attach(streamSrc(res.qualities[q], res.referer, res.cookie));
      video.addEventListener('loadedmetadata', () => { video.currentTime = pos; video.play().catch(() => {}); }, { once: true });
    } catch (e) { showMsg(t('error_cannot_play_in_selected_player')); }
  }

  function updateButtons() {
    const nextI = sort === 2 ? idx - 1 : idx + 1; const prevI = sort === 2 ? idx + 1 : idx - 1;
    nextBtn.disabled = !episodes[nextI]; nextBtn.style.opacity = episodes[nextI] ? 1 : 0.35;
    prevBtn.disabled = !episodes[prevI]; prevBtn.style.opacity = episodes[prevI] ? 1 : 0.35;
  }

  async function load(i, res, startAt) {
    const ep = episodes[i];
    if (!ep) return;
    savePosition();
    idx = i;
    retried = false;
    ep.releaseId = ep.releaseId ?? release.id;
    ep.sourceId = ep.sourceId ?? ep.source?.id;
    ttlB.textContent = release.title_ru || release.title_original || '';
    ttlS.textContent = ep.name || `${ep.position} серия`;
    showMsg('', true);
    video.pause();
    try {
      if (!res) res = await resolveEpisode(ep);
    } catch (e) {
      showMsg(`${t('error_cannot_play_in_selected_player')}\n${e.message || ''}`);
      return;
    }
    const available = Object.keys(res.qualities);
    const quality = cur && res.qualities[cur.quality] ? cur.quality : initialQuality(available);
    cur = { ep, res, quality };
    segKey = ''; skipState.kind = null; skipState.dismissed = null; hideSkipRow(); // метки новой серии
    updateButtons();
    up.setSourceKey(`${ep.releaseId}:${ep.sourceId}:${quality}`); // запомненная оценка разрешения этой озвучки
    attach(streamSrc(res.qualities[quality], res.referer, res.cookie));
    const local = db.getEpisode(ep.releaseId, ep.sourceId, ep.position);
    const saved = startAt ?? (local && local.playbackPosition > 0 ? local.playbackPosition : 0);
    video.addEventListener('loadedmetadata', async () => {
      showMsg('');
      if (saved > 0 && startAt == null) {
        const choice = await askResume();
        if (choice) video.currentTime = saved / 1000;
      } else if (saved > 0) video.currentTime = saved / 1000;
      video.playbackRate = SPEEDS[prefs.get('SELECTED_PLAYER_SPEED')] || 1;
      video.play().catch(() => {});
    }, { once: true });
  }

  // Список-диалог «Воспроизведение» [«Начать с начала», «Продолжить»],
  // видео на паузе; закрытие диалога без выбора = начать с начала (позиция сбрасывается в 0)
  function askResume() {
    video.pause();
    return new Promise((resolve) => {
      let chosen = null;
      const list = h('div', { class: 'sheet-list' });
      const d = dialog({
        title: t('title_playback'), content: list, cls: 'sheet',
        onClose: () => resolve(chosen === true),
      });
      [[false, t('action_start_over')], [true, t('action_continue')]].forEach(([value, label]) => {
        list.append(h('button', { class: 'sheet-item', onclick: () => { chosen = value; d.close(); } }, h('span', null, label)));
      });
    });
  }

  async function switchEpisode(dir) {
    const ni = sort === 2 ? idx - dir : idx + dir;
    const ep = episodes[ni];
    if (!ep) return false;
    const rid = ep.releaseId ?? release.id; const sid = ep.sourceId ?? ep.source?.id;
    if (auth.loggedIn) {
      A.historyAdd(rid, sid, ep.position).catch(() => {});
      A.episodeWatch(rid, sid, ep.position).catch(() => {});
    }
    db.putEpisode(rid, sid, ep.position, { isWatched: true });
    ep.is_watched = true;
    await load(ni);
    return true;
  }

  function seekBy(sec) {
    if (!video.duration) return;
    video.currentTime = Math.max(0, Math.min(video.duration - 1, video.currentTime + sec));
    poke();
  }
  function togglePlay() { if (video.paused) video.play().catch(() => {}); else video.pause(); }
  function toggleFs() { if (document.fullscreenElement) document.exitFullscreen(); else ov.requestFullscreen?.(); }
  function togglePip() { if (document.pictureInPictureElement) document.exitPictureInPicture(); else video.requestPictureInPicture?.().catch(() => {}); }

  // --- Шестерёнка: качество, скорость, пропуск опенинга и эндинга ---
  // Главная страница меню — строки со значениями; качество и скорость открываются списком внутри меню
  const qualityName = (q) => (q === 'Default' ? t('quality_default') : q);
  const speedName = (s) => (s === 1 ? t('speed_normal') : `${String(s).replace('.', ',')}x`);
  function closeMenu() { if (!menu) return; menu.remove(); menu = null; gearBtn.classList.remove('on'); poke(); }
  function setQuality(q) {
    const pos = video.currentTime; const paused = video.paused;
    cur.quality = q;
    up.setSourceKey(`${cur.ep.releaseId}:${cur.ep.sourceId}:${q}`);
    attach(streamSrc(cur.res.qualities[q], cur.res.referer, cur.res.cookie));
    video.addEventListener('loadedmetadata', () => { video.currentTime = pos; if (!paused) video.play().catch(() => {}); }, { once: true });
  }
  function menuPage(title, rows) {
    menuCur = null; // страницы «Качество», «Скорость» — статичные; живые ставит menuShow
    menu.replaceChildren(...(title ? [h('button', { class: 'pm-head', onclick: () => menuShow(null, mainRows) }, icon('ic_back', 'sm'), title)] : []), ...rows.filter(Boolean));
  }
  // страница меню, которую можно перерисовать: строки улучшения картинки меняются по ходу (замер, статус)
  let menuCur = null;
  function menuShow(title, build, keepScroll) {
    const top = menu.scrollTop;
    menuPage(title, build());
    menuCur = { title, build, live: build === mainRows || build === upscaleRows, key: upMenuKey() };
    if (keepScroll) menu.scrollTop = top;
  }
  // Статус улучшения меняется на каждом замере (мс на кадр) — тогда обновляем только текст строки состояния.
  // Меню перестраиваем, лишь когда поменялось то, что в нём показано (режим, уровень, модель): иначе строки
  // пересоздаются под курсором (мигает hover) и открытая страница сбрасывается. Подписи «тяжело / не потянет»
  // считаются при открытии страницы — у границы они бы переключались от каждого замера.
  const upMenuKey = () => { const ti = up.trtInfo(); return [up.mode, up.tier, up.status.state, up.debug.stages.join('+'), ti.supported, ti.installed, ti.enabled, ti.failed, !!trtInstalling].join('|'); };
  function refreshMenu() {
    if (!menu || !menuCur || !menuCur.live) return;
    const k = upMenuKey();
    if (k !== menuCur.key) { menuShow(menuCur.title, menuCur.build, true); return; }
    const b = menu.querySelector('.pm-note b');
    if (b && up.status.text) b.textContent = up.status.text;
  }
  function skipSwitch(kind, label) {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = prefs.get(SKIP_PREF[kind]) === 'auto';
    cb.onchange = () => { prefs.set(SKIP_PREF[kind], cb.checked ? 'auto' : 'watch'); skipState.countKind = null; };
    return h('label', { class: 'pm-row' }, icon('ic_player_rewind_fast', 'sm'), h('span', { class: 'grow' }, label), h('span', { class: 'switch' }, cb, h('span')));
  }
  const row = (ic, label, value, open) => h('button', { class: 'pm-row', onclick: open }, icon(ic, 'sm'), h('span', { class: 'grow' }, label), h('span', { class: 'val' }, value), icon('ic_chevron_end', 'sm'));
  // Улучшение картинки: режим (Выкл / Авто / три уровня) и разрешение; уровень, который видеокарта не потянет
  // на этом исходнике, подписан предупреждением, но выбрать его можно — при рывках он сам снизится
  const UP_MODE = { off: 'Выкл', auto: 'Авто', ...TIER_LABEL };
  const targetName = (tg) => (tg === 'auto' ? `Авто (${up.displayHeight()}p)` : tg === '2160' ? '4K' : `${tg}p`);
  function upscaleRows() {
    const opt = (m, label, sub, weak) => h('button', {
      class: `pm-row pm-opt ${up.mode === m ? 'on' : ''} ${weak ? 'weak' : ''}`,
      onclick: () => { up.setMode(m); menuShow(menuCur.title, upscaleRows, true); },
    }, icon('ic_check', 'sm'), h('span', { class: 'grow' }, label, sub ? h('small', null, sub) : null));
    const tierOpt = (tr, sub) => {
      const i = up.tierInfo(tr);
      const warn = i.load === 'no' ? `Не потянет видеокарта на ${i.srcH}p` : i.load === 'heavy' ? `Тяжело для видеокарты на ${i.srcH}p` : null;
      return opt(tr, TIER_LABEL[tr], warn || sub, !!warn);
    };
    const cmp = h('input', { type: 'checkbox' });
    cmp.checked = up.split > 0;
    cmp.onchange = () => { up.setSplit(cmp.checked ? 0.5 : 0); placeSplit(); };
    const st = up.status;
    // Ускорение NVIDIA (TensorRT): только на видеокартах RTX; библиотеки (93 МБ) скачиваются по кнопке
    const ti = up.trtInfo();
    let trtRow = null;
    if (ti.supported && !ti.installed) {
      trtRow = h('button', { class: 'pm-row trt-row', disabled: !!trtInstalling, onclick: () => installTrt() },
        icon('ic_upscale', 'sm'),
        h('span', { class: 'grow' }, 'Ускорение NVIDIA', h('small', null, trtInstalling || `Тяжёлые модели в 2–4 раза быстрее · скачать ${Math.round((ti.size || 0) / 1048576)} МБ`)),
        h('span', { class: 'val' }, trtInstalling ? '' : 'Установить'));
    } else if (ti.reason === 'driver') {
      trtRow = h('div', { class: 'pm-row' }, icon('ic_upscale', 'sm'),
        h('span', { class: 'grow' }, 'Ускорение NVIDIA', h('small', null, 'Обновите драйвер видеокарты NVIDIA (версия 580 или новее)')));
    } else if (ti.supported) {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = ti.enabled;
      cb.onchange = () => up.setTrt(cb.checked);
      trtRow = h('label', { class: 'pm-row' }, icon('ic_upscale', 'sm'),
        h('span', { class: 'grow' }, 'Ускорение NVIDIA', h('small', null, ti.failed ? 'Не сработало — считаю без него' : ti.active ? 'Работает · TensorRT' : 'TensorRT на тензорных ядрах')),
        h('span', { class: 'switch' }, cb, h('span')));
    }
    // ручной уровень — свой пресет (модель); «Авто» берёт лучший, что успевает
    const chosen = TIERS.includes(up.mode) ? up.presets(up.mode).find((x) => x.chosen) : null;
    return [
      opt('off', 'Выключено'),
      opt('auto', 'Авто', 'Подберёт под серию и видеокарту'),
      h('div', { class: 'pm-sep' }),
      tierOpt('fast', 'Немного чётче, почти без нагрузки'),
      tierOpt('quality', 'Чистые линии, меньше артефактов сжатия'),
      tierOpt('max', 'Лучшее качество, для мощной видеокарты'),
      h('div', { class: 'pm-sep' }),
      chosen ? row('ic_tune', 'Модель', shortName(chosen.name), () => menuShow('Модель', presetRows)) : null,
      chosen ? row('ic_tune_variant', 'Резкость', SHARP_LABEL[up.sharpness], () => menuShow('Резкость', sharpRows)) : null, // в «Авто» выбираем сами
      row('ic_quality', 'Разрешение', targetName(up.target), () => menuShow('Разрешение', targetRows)),
      trtRow,
      up.benchNeeded() ? h('button', { class: 'pm-row', onclick: () => askBench(true) }, icon('ic_play_speed', 'sm'),
        h('span', { class: 'grow' }, 'Проверить видеокарту', h('small', null, '«Авто» точнее подберёт модели · несколько секунд'))) : null,
      up.mode !== 'off' ? h('label', { class: 'pm-row' }, icon('ic_compare', 'sm'), h('span', { class: 'grow' }, 'Сравнить с оригиналом'), h('span', { class: 'switch' }, cmp, h('span'))) : null,
      h('div', { class: `pm-note ${st.state === 'error' ? 'err' : ''}` },
        st.text ? h('b', null, st.text) : null,
        h('span', null, up.mode === 'off' ? 'Нейросеть делает линии и детали чётче при увеличении серии до размера экрана.' : 'Удерживайте C — оригинал, U — включить или выключить.')),
    ];
  }
  // установка библиотек TensorRT: прогресс — в подписи строки, без перестройки меню на каждый процент
  let trtInstalling = '';
  async function installTrt() {
    trtInstalling = 'Скачивание…'; refreshMenu();
    const paint = (p) => {
      trtInstalling = p.done ? 'Установка…' : `Скачивание ${Math.floor((p.received / (p.total || 1)) * 100)}%`;
      const el = menu && menu.querySelector('.trt-row small'); if (el) el.textContent = trtInstalling;
    };
    const r = await up.installTrt(paint).catch((e) => ({ ok: false, error: e.message }));
    trtInstalling = '';
    toast(r.ok ? 'Ускорение NVIDIA установлено' : `Не удалось установить ускорение: ${r.error}`);
    refreshMenu();
  }
  // пресеты уровня: модель и её цена на этом исходнике (по бенчмарку или прикидке)
  const shortName = (n) => n.replace(/^AnimeJaNai /, '');
  const msLabel = (x) => (x.ms == null ? '' : x.ms === Infinity ? 'не потянет' : `${Math.round(x.ms)} мс`);
  function presetRows() {
    return up.presets(up.mode).map((x) => h('button', {
      class: `pm-row pm-opt ${x.chosen ? 'on' : ''} ${x.load === 'no' || x.load === 'heavy' ? 'weak' : ''}`,
      onclick: () => { up.setPreset(up.mode, x.id); menuShow('Улучшение картинки', upscaleRows); },
    }, icon('ic_check', 'sm'), h('span', { class: 'grow' }, x.name,
      h('small', null, [msLabel(x), x.load === 'no' ? 'видеокарта не успеет' : x.load === 'heavy' ? 'почти без запаса' : ''].filter(Boolean).join(' · ') || 'время станет известно после проверки видеокарты'))));
  }
  function sharpRows() {
    const sub = { soft: 'Ближе к исходнику, без мерцания', normal: 'Лучшее для этой серии', sharp: 'Чётче линии — на шумных сериях может мерцать' };
    return SHARPNESS.map((sv) => h('button', {
      class: `pm-row pm-opt ${up.sharpness === sv ? 'on' : ''}`, onclick: () => { up.setSharpness(sv); menuShow('Улучшение картинки', upscaleRows); },
    }, icon('ic_check', 'sm'), h('span', { class: 'grow' }, SHARP_LABEL[sv], h('small', null, sub[sv]))));
  }
  // Бенчмарк: предложение — когда нет других окон и видео идёт (не поверх «Продолжить просмотр?»)
  function askBenchWhenFree() {
    if (!ov.isConnected) return;
    if (document.querySelector('.backdrop:not(.closing)') || video.paused || video.readyState < 3) { setTimeout(askBenchWhenFree, 1500); return; }
    askBench(false);
  }
  async function askBench(fromMenu) {
    const ti = up.trtInfo();
    if (!fromMenu && !(await benchPrompt(!!(ti.installed && ti.enabled)))) { up.benchLater(); refreshMenu(); return; }
    closeMenu();
    const playing = !video.paused; video.pause();
    up.benchStart();
    const r = await benchRunDialog();
    up.benchFinished();
    toast(r ? 'Готово — «Авто» будет брать лучшую модель, которая успевает' : 'Проверка остановлена');
    if (playing && ov.isConnected) video.play().catch(() => {});
  }
  function targetRows() {
    return ['auto', '1080', '1440', '2160'].map((tg) => h('button', {
      class: `pm-row pm-opt ${up.target === tg ? 'on' : ''}`, onclick: () => { up.setTarget(tg); menuShow('Улучшение картинки', upscaleRows); },
    }, icon('ic_check', 'sm'), h('span', { class: 'grow' }, targetName(tg), tg === 'auto' ? h('small', null, 'Под размер окна') : null)));
  }
  function mainRows() {
    return [
      cur ? row('ic_quality', 'Качество', qualityName(cur.quality), () => menuPage('Качество', Object.keys(cur.res.qualities).slice().reverse().map((q) => h('button', {
        class: `pm-row pm-opt ${q === cur.quality ? 'on' : ''}`, onclick: () => { if (q !== cur.quality) setQuality(q); closeMenu(); },
      }, icon('ic_check', 'sm'), h('span', { class: 'grow' }, qualityName(q)))))) : null,
      row('ic_upscale', 'Улучшение', UP_MODE[up.mode] || 'Выкл', () => menuShow('Улучшение картинки', upscaleRows)),
      row('ic_play_speed', 'Скорость', speedName(video.playbackRate), () => menuPage('Скорость', SPEEDS.map((s, i) => h('button', {
        class: `pm-row pm-opt ${video.playbackRate === s ? 'on' : ''}`, onclick: () => { video.playbackRate = s; prefs.set('SELECTED_PLAYER_SPEED', i); closeMenu(); },
      }, icon('ic_check', 'sm'), h('span', { class: 'grow' }, speedName(s)))))),
      h('div', { class: 'pm-sep' }),
      skipSwitch('opening', 'Пропускать опенинг'),
      skipSwitch('ending', 'Пропускать эндинг'),
      h('div', { class: 'pm-note' }, 'Где источник отметил опенинг и эндинг. Выключено — кнопка «Пропустить», когда начинается.'),
    ];
  }
  gearBtn.onclick = (e) => {
    e.stopPropagation();
    if (menu) { closeMenu(); return; }
    menu = h('div', { class: 'player-menu', onclick: (ev) => ev.stopPropagation() });
    menuShow(null, mainRows);
    gearBtn.classList.add('on');
    ov.append(menu);
    poke();
  };
  ov.addEventListener('click', (e) => { if (menu && !menu.contains(e.target) && !gearBtn.contains(e.target)) closeMenu(); });

  playBtn.onclick = togglePlay;
  prevBtn.onclick = () => switchEpisode(-1);
  nextBtn.onclick = () => switchEpisode(1);
  volume.oninput = () => { video.volume = Number(volume.value); video.muted = video.volume === 0; paintVolume(); };
  const paintVolume = () => volume.style.setProperty('--v', `${(video.muted ? 0 : video.volume) * 100}%`);
  paintVolume();

  // После нажатия «плей» или автозапуска интерфейс прячется быстрее: смотреть, а не на кнопки
  video.addEventListener('play', () => { playBtn.replaceChildren(icon('ic_player_pause')); poke(PLAY_HIDE_MS); });
  video.addEventListener('pause', () => { playBtn.replaceChildren(icon('ic_player_play')); savePosition(); poke(); });
  video.addEventListener('waiting', () => showMsg('', true));
  video.addEventListener('playing', () => showMsg(''));
  video.addEventListener('error', () => { if (!hls) onFatal(); });
  video.addEventListener('volumechange', paintVolume);
  video.addEventListener('timeupdate', paintTime);
  video.addEventListener('progress', paintTime);
  video.addEventListener('durationchange', () => { segKey = ''; paintTime(); });
  video.addEventListener('ended', async () => {
    savePosition();
    if (prefs.get('AUTO_PLAY')) { if (!(await switchEpisode(1))) close(); }
  });

  // --- Таймлайн ---
  let segKey = ''; let segs = [];
  const marksNow = () => clampMarks(cur?.res?.skip, video.duration || 0);
  function buildSegments() {
    const d = video.duration || 0; const marks = marksNow();
    const key = `${Math.round(d)}|${JSON.stringify(marks)}`;
    if (key === segKey) return;
    segKey = key;
    segs = timelineSegments(d, marks).map((s) => {
      const b = h('div', { class: 'b' }); const p = h('div', { class: 'p' });
      const el = h('div', { class: `seg ${s.kind !== 'content' ? 'mark' : ''}`, style: { left: `${s.from}%`, width: `${s.to - s.from}%` } }, b, p);
      return { ...s, el, b, p };
    });
    segsEl.replaceChildren(...segs.map((s) => s.el));
  }
  // доля отрезка [a, b] внутри сегмента — в процентах его ширины
  const within = (s, a, b) => Math.max(0, Math.min(100, ((Math.min(b, s.to) - Math.max(a, s.from)) / (s.to - s.from)) * 100));
  function paintTime() {
    buildSegments();
    const d = video.duration || 0; const c = video.currentTime || 0;
    const pct = d ? (c / d) * 100 : 0;
    let bufEnd = 0;
    for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= c + 1) bufEnd = Math.max(bufEnd, video.buffered.end(i));
    const bufPct = d ? (bufEnd / d) * 100 : 0;
    for (const s of segs) {
      s.p.style.width = `${within(s, 0, pct)}%`;
      s.b.style.width = `${within(s, 0, bufPct)}%`;
    }
    knob.style.left = `${pct}%`;
    knob.classList.toggle('mark', segs.some((s) => s.kind !== 'content' && pct >= s.from && pct < s.to));
    timeEl.textContent = `${fmt(c)} / ${fmt(d)}`;
    updateSkip();
  }

  // Перемотка по полосе; подсказка — время под курсором и «Опенинг/Эндинг», если курсор в их секции
  let dragging = false;
  const pointerPct = (e) => { const r = seek.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  const seekTo = (e) => { if (video.duration) video.currentTime = pointerPct(e) * video.duration; };
  function showTip(e) {
    const d = video.duration || 0;
    if (!d) { tip.classList.remove('show'); return; }
    const p = pointerPct(e); const sec = p * d; const marks = marksNow();
    const kind = marks && (['opening', 'ending'].find((k) => marks[k] && sec >= marks[k].start && sec < marks[k].end));
    tip.replaceChildren(fmt(sec)); // replaceChildren(null) вставил бы текст «null»
    if (kind) tip.append(h('span', { class: 'mk' }, MARK_LABEL[kind]));
    tip.style.left = `${p * 100}%`;
    tip.classList.add('show');
  }
  seek.addEventListener('pointerdown', (e) => { dragging = true; seek.setPointerCapture(e.pointerId); seekTo(e); });
  seek.addEventListener('pointermove', (e) => { showTip(e); if (dragging) seekTo(e); });
  seek.addEventListener('pointerup', () => { dragging = false; });
  seek.addEventListener('pointerleave', () => { if (!dragging) tip.classList.remove('show'); });

  // --- Пропуск опенинга и эндинга ---
  // Внутри отмеченной секции — ряд «Смотреть …» / «Пропустить». Выбор «пропускать» (общий) — кнопка
  // «Пропустить» заполняется отсчётом и пропускает сама; иначе ряд прячется через 10 с. «Смотреть» —
  // ряд прячется до выхода из секции. Отсчёт идёт только во время воспроизведения.
  const skipState = { kind: null, dismissed: null, countKind: null, elapsed: 0, last: 0, raf: 0 };
  // и на перемотке: после пропуска видео может буферизоваться без единого timeupdate, и выход из секции
  // иначе не заметить — повторный вход в неё (перемотка назад) не предложил бы пропуск
  video.addEventListener('seeking', () => updateSkip());
  const nextEpisode = () => episodes[sort === 2 ? idx - 1 : idx + 1];
  function skipTarget(kind) {
    const marks = marksNow();
    const range = marks && marks[kind];
    if (!range) return null;
    const next = kind === 'ending' && endingAtEpisodeEnd(range, video.duration || 0) ? nextEpisode() : null;
    return { range, next };
  }
  function doSkip(kind, remember) {
    const tgt = skipTarget(kind);
    skipState.dismissed = kind;
    if (remember) prefs.set(SKIP_PREF[kind], 'auto');
    hideSkipRow();
    if (!tgt) return;
    if (tgt.next) { switchEpisode(1); return; }
    const d = video.duration || 0;
    video.currentTime = d ? Math.min(tgt.range.end + 0.05, d - 0.05) : tgt.range.end;
    toast(kind === 'opening' ? 'Опенинг пропущен' : 'Эндинг пропущен');
  }
  function watchMark(kind, remember) {
    skipState.dismissed = kind;
    if (remember) prefs.set(SKIP_PREF[kind], 'watch');
    hideSkipRow();
  }
  function hideSkipRow() {
    skipRow.classList.remove('show'); cancelAnimationFrame(skipState.raf); skipState.raf = 0;
    setTimeout(() => { if (!skipRow.classList.contains('show')) { goFill.style.width = '0%'; watchFill.style.width = '0%'; } }, 400); // после затухания
  }
  skipGoBtn.onclick = (e) => { e.stopPropagation(); if (skipState.kind) doSkip(skipState.kind, true); };
  skipWatchBtn.onclick = (e) => { e.stopPropagation(); if (skipState.kind) watchMark(skipState.kind, true); };
  function updateSkip() {
    const tm = video.currentTime || 0; const marks = marksNow();
    const kind = marks ? (['opening', 'ending'].find((k) => markActive(tm, marks[k])) || null) : null;
    if (kind !== skipState.kind) {
      skipState.kind = kind;
      if (skipState.dismissed !== kind) skipState.dismissed = null; // вышли из секции — снова предлагать
      skipState.countKind = null;
    }
    if (!kind || skipState.dismissed === kind) { if (skipRow.classList.contains('show')) hideSkipRow(); return; }
    const tgt = skipTarget(kind);
    watchLabel.textContent = kind === 'opening' ? 'Смотреть опенинг' : 'Смотреть эндинг';
    goLabel.textContent = tgt?.next ? `Следующая серия ${tgt.next.position}` : 'Пропустить';
    skipRow.classList.add('show');
    if (skipState.countKind !== kind) { // новый отсчёт: при входе в секцию и после смены настройки
      skipState.countKind = kind; skipState.elapsed = 0; skipState.last = performance.now();
      cancelAnimationFrame(skipState.raf);
      skipState.raf = requestAnimationFrame(countdown);
    }
  }
  function countdown(now) {
    const kind = skipState.kind;
    if (!kind || skipState.dismissed === kind) return;
    if (!video.paused && video.readyState >= 3) skipState.elapsed += now - skipState.last; // не во время буферизации
    skipState.last = now;
    const auto = prefs.get(SKIP_PREF[kind]) === 'auto';
    const range = skipTarget(kind)?.range;
    const total = auto ? Math.min(SKIP_AUTO_MS, Math.max(1500, ((range ? range.end - (video.currentTime || 0) : 7) * 1000) + skipState.elapsed)) : WATCH_AUTO_MS;
    const pct = Math.min(100, (skipState.elapsed / total) * 100);
    goFill.style.width = auto ? `${pct}%` : '0%';
    watchFill.style.width = auto ? '0%' : `${pct}%`;
    if (pct >= 100) { if (auto) doSkip(kind, false); else watchMark(kind, false); return; }
    skipState.raf = requestAnimationFrame(countdown);
  }

  // --- Индикаторы перемотки: круг 140px, иконка, «-10 секунд» ---
  const makeSeekInd = (side) => {
    const ripple = h('div', { class: 'seek-ripple' });
    const label = h('div', { class: 'seek-label' });
    const el = h('div', { class: `seek-ind ${side}` }, ripple,
      h('div', { class: 'seek-col' }, icon(side === 'left' ? 'ic_seek_backward' : 'ic_seek_forward', 'seek-ic'), label));
    ov.append(el);
    return { el, ripple, label, acc: 0, timer: null };
  };
  const seekInd = { left: makeSeekInd('left'), right: makeSeekInd('right') };
  // Накопленная перемотка, через 800 мс — затухание 200 мс
  function showSeek(side) {
    const ind = seekInd[side];
    ind.acc += 10;
    ind.label.textContent = t('format_seconds', side === 'left' ? '-' : '+', ind.acc);
    ind.el.classList.add('show');
    ind.ripple.classList.remove('pressed'); void ind.ripple.offsetWidth; ind.ripple.classList.add('pressed');
    clearTimeout(ind.timer);
    ind.timer = setTimeout(() => {
      ind.ripple.classList.remove('pressed');
      ind.el.classList.remove('show');
      ind.acc = 0;
    }, 800);
  }
  const seekWindowOpen = (side) => seekInd[side].el.classList.contains('show');

  // --- Индикатор ускорения: плашка «2x» сверху ---
  const speedText = h('span', { class: 'speed-text' });
  const speedInd = h('div', { class: 'speed-ind' }, speedText, icon('ic_player_rewind_fast', 'speed-ic'));
  ov.append(speedInd);
  const fmtSpeed = (f) => (f % 1 === 0 ? String(f) : f.toFixed(1).replace('.', ',')) + 'x';

  // Жесты плеера: двойной тап по левым/правым 35% — ∓10 с (повторные тапы суммируются),
  // по центру — полный экран; удержание 500 мс — скорость ×2, пока зажато
  let lastClick = 0;
  stage.addEventListener('click', (e) => {
    if (menu) return; // клик мимо меню только закрывает его (обработчик на ov)
    if (holding) return;
    const now = Date.now();
    const r = stage.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const side = x < 0.35 ? 'left' : x > 0.65 ? 'right' : null;
    // пока индикатор виден, каждый тап на той же стороне добавляет ещё 10 с
    if (side && seekWindowOpen(side)) { seekBy(side === 'left' ? -10 : 10); showSeek(side); lastClick = 0; return; }
    if (now - lastClick < 300) {
      if (side) { seekBy(side === 'left' ? -10 : 10); showSeek(side); } else toggleFs();
      lastClick = 0;
    } else {
      lastClick = now;
      setTimeout(() => { if (lastClick === now && !holding) togglePlay(); }, 300);
    }
  });
  stage.addEventListener('pointerdown', () => {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holding = true;
      prevRate = video.playbackRate;
      const f = prevRate * 2;
      video.playbackRate = f;
      speedText.textContent = fmtSpeed(f);
      speedInd.classList.add('show');
    }, 500);
  });
  const endHold = () => {
    clearTimeout(holdTimer);
    if (holding) {
      video.playbackRate = prevRate;
      speedInd.classList.remove('show');
      setTimeout(() => { holding = false; }, 350);
    }
  };
  stage.addEventListener('pointerup', endHold);
  stage.addEventListener('pointerleave', endHold);

  // Скрытие элементов управления: после движения мыши — через 2,5 с, после «плей» и автозапуска — через
  // PLAY_HIDE_MS. Пока открыто меню или курсор над панелью — не прячем.
  function poke(ms = 2500) {
    ov.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused && !menu && !controls.matches(':hover') && !top.matches(':hover')) ov.classList.add('idle'); }, ms);
  }
  // мышь без сдвига (событие после смены раскладки) интерфейс не показывает
  let lastPt = '';
  ov.addEventListener('mousemove', (e) => { const pt = `${e.clientX},${e.clientY}`; if (pt !== lastPt) { lastPt = pt; poke(); } });

  function onKey(e) {
    if (e.target && /input|textarea/i.test(e.target.tagName) && e.target !== volume) return;
    if (document.querySelector('.backdrop:not(.closing)')) return; // открыт диалог (например, «Продолжить?») — клавиши его
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { togglePlay(); e.preventDefault(); }
    else if (k === 'arrowleft') { seekBy(-5); e.preventDefault(); }
    else if (k === 'arrowright') { seekBy(5); e.preventDefault(); }
    else if (k === 'arrowup') { video.volume = Math.min(1, video.volume + 0.05); volume.value = video.volume; e.preventDefault(); }
    else if (k === 'arrowdown') { video.volume = Math.max(0, video.volume - 0.05); volume.value = video.volume; e.preventDefault(); }
    else if (k === 'f') toggleFs();
    else if (k === 'm') video.muted = !video.muted;
    else if (k === 'n') switchEpisode(1);
    else if (k === 'p') switchEpisode(-1);
    else if (k === 's') { if (skipState.kind && skipState.dismissed !== skipState.kind) doSkip(skipState.kind, true); }
    else if (k === 'u') toggleUpscale();
    else if (k === 'c' && !e.repeat && up.mode !== 'off') up.setHoldOriginal(true);
    else if (k === 'escape' && !document.fullscreenElement) close();
    poke();
  }

  // U — вкл/выкл улучшения (включает последний выбранный режим, по умолчанию «Авто»); C (удерживать) — оригинал
  function toggleUpscale() {
    if (up.mode === 'off') { const m = prefs.get('UPSCALE_LAST') || 'auto'; up.setMode(m); toast(`Улучшение картинки: ${UP_MODE[m]}`); }
    else { prefs.set('UPSCALE_LAST', up.mode); up.setMode('off'); placeSplit(); toast('Улучшение картинки выключено'); }
    refreshMenu();
  }
  const onKeyUp = (e) => { if (e.key.toLowerCase() === 'c') up.setHoldOriginal(false); };
  const onBlur = () => up.setHoldOriginal(false);

  function close() {
    savePosition();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', placeSplit);
    up.destroy();
    if (hls) hls.destroy();
    video.removeAttribute('src'); video.load();
    clearTimeout(idleTimer);
    cancelAnimationFrame(skipState.raf);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    ov.remove();
    window.dispatchEvent(new CustomEvent('player-closed', { detail: { releaseId: release.id } }));
  }

  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.body.append(ov);
  ov.focus();
  poke();
  load(idx, resolved);
  return { close };
}

// Сторонний плеер (на ПК — mpv/VLC через локальный сервер)
export async function openThirdParty(ep, release, res) {
  const qs = Object.keys(res.qualities);
  const pref = prefs.get('SELECTED_THIRD_PARTY_VIDEO_QUALITY_V2');
  let q;
  if (pref === 1) q = qs[qs.length - 1];
  else if (pref === 2) q = qs[0];
  else if (pref >= 3) q = pickQuality(qs, pref - 2);
  else q = await new Promise((resolve) => {
    const list = h('div', { class: 'sheet-list' });
    const d = dialog({ title: t('title_choose_quality'), content: list, cls: 'sheet', onClose: () => resolve(null) });
    qs.slice().reverse().forEach((x) => list.append(h('button', { class: 'sheet-item', onclick: () => { resolve(x); d.close(); } }, x === 'Default' ? t('quality_default') : x)));
  });
  if (!q) return;
  const title = `${release.title_ru} — ${ep.name || `${ep.position} серия`}`;
  const r = await fetch('/external', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: res.qualities[q], referer: res.referer, cookie: res.cookie, title, player: prefs.get('THIRD_PARTY_PLAYER_PATH') }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) toast(j.error || t('msg_external_player_not_found'));
}
