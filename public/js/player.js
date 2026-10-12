// Плееры: встроенный, веб-плеер и сторонний; реклама Kodik.
import { h, icon, toast, dialog } from './ui.js';
import { A, auth } from './api.js';
import { prefs, db, t } from './store.js';

const QUALITIES = ['Default', '360p', '480p', '720p', '1080p', '1440p', '2160p']; // utils/domain/release/Quality
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const KODIK_HOSTS = ['kodik.cc', 'kodik.info', 'aniqit.com', 'kodikplayer.com'];

export function isKodik(url) { try { return KODIK_HOSTS.includes(new URL(url).host); } catch { return false; } }

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
  // Kodik «Среднее качество» (без рекламы) — максимум 480p
  if (isKodik(url) && prefs.get('KODIK_IFRAME_AD') && prefs.get('SELECTED_KODIK_VIDEO_QUALITY') === 1) {
    for (const k of ['720p', '1080p', '1440p', '2160p']) delete qualities[k];
  }
  if (!Object.keys(qualities).length) throw new Error('Return 1#null 5#null');
  return { url, qualities, referer: p.referer || url, cookie: p.cookie || '', download: p.download || {} };
}

// Реклама Kodik: страница рекламы; окончание — KodikInterface.advertEnded()
export function showKodikAd(url) {
  return new Promise((resolve) => {
    const u = new URL(url); u.search = '';
    const src = `${prefs.get('KODIK_AD_IFRAME_URL')}${encodeURIComponent(u.toString())}&v=26090418`;
    if (window.anixartNative && window.anixartNative.showKodikAd) {
      window.anixartNative.showKodikAd(src).then(() => resolve(true), () => resolve(true));
      return;
    }
    // В браузере нельзя внедрить KodikInterface во фрейм другого домена — показываем рекламу во фрейме,
    // а после неё пользователь продолжает вручную.
    const frame = h('iframe', { src, allow: 'autoplay; fullscreen', style: { width: '100%', height: '100%', border: '0' } });
    const cont = h('button', { class: 'btn btn-primary', disabled: true }, t('action_continue'));
    let left = 15;
    const timer = setInterval(() => {
      left -= 1;
      cont.textContent = left > 0 ? `${t('action_continue')} (${left})` : t('action_continue');
      if (left <= 0) { cont.disabled = false; clearInterval(timer); }
    }, 1000);
    const ov = h('div', { class: 'player-overlay' },
      h('div', { class: 'player-stage' }, frame),
      h('div', { style: { position: 'absolute', right: '20px', bottom: '20px', zIndex: 5 } }, cont));
    cont.onclick = () => { clearInterval(timer); ov.remove(); resolve(true); };
    document.body.append(ov);
  });
}

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
  const fill = h('div', { class: 'fill' }); const buf = h('div', { class: 'buf' }); const knob = h('div', { class: 'knob' });
  const seek = h('div', { class: 'seek' }, h('div', { class: 'track' }), buf, fill, knob);
  const playBtn = h('button', { class: 'icon-btn', title: 'Пауза (Пробел)' }, icon('ic_player_pause'));
  const qualityBtn = h('button', { class: 'btn btn-text', style: { color: '#fff' }, title: t('title_choose_quality') }, '');
  const speedBtn = h('button', { class: 'btn btn-text', style: { color: '#fff' }, title: 'Скорость' }, '');
  const prevBtn = h('button', { class: 'icon-btn', title: 'Предыдущая серия (P)' }, icon('ic_player_previous'));
  const nextBtn = h('button', { class: 'icon-btn', title: 'Следующая серия (N)' }, icon('ic_player_next'));
  const skipBtn = h('button', { class: 'icon-btn', title: `${t('title_player_rewind')} (+${prefs.get('PLAYER_REWIND_TIME')} c, S)` }, icon('ic_player_rewind_fast'));
  const volume = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: 1, style: { width: '90px', accentColor: '#f04e5c' } });
  let menu = null;

  const top = h('div', { class: 'player-top' },
    h('button', { class: 'icon-btn', title: 'Закрыть (Esc)', onclick: () => close() }, icon('ic_back')),
    h('div', { class: 'ttl' }, ttlB, ttlS));
  const controls = h('div', { class: 'player-controls' },
    seek,
    h('div', { class: 'row' },
      prevBtn,
      h('button', { class: 'icon-btn', title: '−10 с', onclick: () => seekBy(-10) }, icon('ic_player_rewind_10')),
      playBtn,
      h('button', { class: 'icon-btn', title: '+10 с', onclick: () => seekBy(10) }, icon('ic_player_forward_10')),
      nextBtn,
      timeEl,
      h('div', { class: 'grow' }),
      skipBtn,
      volume,
      speedBtn,
      qualityBtn,
      h('button', { class: 'icon-btn', title: 'Картинка в картинке', onclick: () => togglePip() }, icon('ic_player_pip')),
      h('button', { class: 'icon-btn', title: 'Во весь экран (F)', onclick: () => toggleFs() }, icon('ic_player_fill'))));
  const stage = h('div', { class: 'player-stage' }, video, msg);
  const ov = h('div', { class: 'player-overlay', tabindex: '-1' }, top, stage, controls);

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
      attach(streamSrc(res.qualities[q], res.referer, res.cookie));
      video.addEventListener('loadedmetadata', () => { video.currentTime = pos; video.play().catch(() => {}); }, { once: true });
    } catch (e) { showMsg(t('error_cannot_play_in_selected_player')); }
  }

  function updateButtons() {
    qualityBtn.textContent = cur ? (cur.quality === 'Default' ? t('quality_default') : cur.quality) : '';
    speedBtn.textContent = video.playbackRate === 1 ? t('speed_normal') : `${video.playbackRate}x`;
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
    updateButtons();
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

  function openMenu(title, items) {
    if (menu) { menu.remove(); menu = null; return; }
    menu = h('div', { class: 'menu-pop' }, h('div', { class: 'hdr' }, title),
      items.map((it) => h('button', { class: it.on ? 'on' : '', onclick: () => { menu.remove(); menu = null; it.onClick(); } }, it.label)));
    ov.append(menu);
  }

  qualityBtn.onclick = () => {
    if (!cur) return;
    openMenu(t('title_choose_quality'), Object.keys(cur.res.qualities).map((q) => ({
      label: q === 'Default' ? t('quality_default') : q,
      on: q === cur.quality,
      onClick: () => {
        const pos = video.currentTime; const paused = video.paused;
        cur.quality = q; updateButtons();
        attach(streamSrc(cur.res.qualities[q], cur.res.referer, cur.res.cookie));
        video.addEventListener('loadedmetadata', () => { video.currentTime = pos; if (!paused) video.play().catch(() => {}); }, { once: true });
      },
    })));
  };
  speedBtn.onclick = () => openMenu('Скорость воспроизведения', SPEEDS.map((s, i) => ({
    label: s === 1 ? t('speed_normal') : `${s}x`, on: video.playbackRate === s,
    onClick: () => { video.playbackRate = s; prefs.set('SELECTED_PLAYER_SPEED', i); updateButtons(); },
  })));
  playBtn.onclick = togglePlay;
  prevBtn.onclick = () => switchEpisode(-1);
  nextBtn.onclick = () => switchEpisode(1);
  skipBtn.onclick = () => seekBy(prefs.get('PLAYER_REWIND_TIME'));
  volume.oninput = () => { video.volume = Number(volume.value); video.muted = video.volume === 0; };

  video.addEventListener('play', () => playBtn.replaceChildren(icon('ic_player_pause')));
  video.addEventListener('pause', () => { playBtn.replaceChildren(icon('ic_player_play')); savePosition(); });
  video.addEventListener('waiting', () => showMsg('', true));
  video.addEventListener('playing', () => showMsg(''));
  video.addEventListener('error', () => { if (!hls) onFatal(); });
  video.addEventListener('timeupdate', () => {
    const d = video.duration || 0; const c = video.currentTime || 0;
    const pct = d ? (c / d) * 100 : 0;
    fill.style.width = `${pct}%`; knob.style.left = `${pct}%`;
    timeEl.textContent = `${fmt(c)} / ${fmt(d)}`;
    if (video.buffered.length && d) buf.style.width = `${(video.buffered.end(video.buffered.length - 1) / d) * 100}%`;
  });
  video.addEventListener('ended', async () => {
    savePosition();
    if (prefs.get('AUTO_PLAY')) { if (!(await switchEpisode(1))) close(); }
  });

  // Перемотка по полосе
  let dragging = false;
  const seekTo = (e) => {
    const r = seek.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (video.duration) video.currentTime = p * video.duration;
  };
  seek.addEventListener('pointerdown', (e) => { dragging = true; seek.setPointerCapture(e.pointerId); seekTo(e); });
  seek.addEventListener('pointermove', (e) => { if (dragging) seekTo(e); });
  seek.addEventListener('pointerup', () => { dragging = false; });

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
    if (menu) { menu.remove(); menu = null; return; }
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

  // Скрытие элементов управления через 5 с
  function poke() {
    ov.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused && !menu) ov.classList.add('idle'); }, 5000);
  }
  ov.addEventListener('mousemove', poke);

  function onKey(e) {
    if (e.target && /input|textarea/i.test(e.target.tagName) && e.target !== volume) return;
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
    else if (k === 's') seekBy(prefs.get('PLAYER_REWIND_TIME'));
    else if (k === 'escape' && !document.fullscreenElement) close();
    poke();
  }

  function close() {
    savePosition();
    document.removeEventListener('keydown', onKey);
    if (hls) hls.destroy();
    video.removeAttribute('src'); video.load();
    clearTimeout(idleTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    ov.remove();
    window.dispatchEvent(new CustomEvent('player-closed', { detail: { releaseId: release.id } }));
  }

  document.addEventListener('keydown', onKey);
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
