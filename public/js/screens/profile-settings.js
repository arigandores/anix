// Настройки профиля — как «Редактировать профиль» в Anixart (xml/preference_profile.xml, ProfilePreferenceFragment):
// фото профиля и обложка блога, статус, никнейм, значок, соцсети, приватность, блоклист, Email, привязка к сервисам,
// удаление аккаунта. Запросы — как в ProfilePreferenceApi, ProfileBlockListApi, ProfileBadgeApi, ProfileDeletionApi,
// AuthApi.checkLogin и ChannelApi (обложка, блог) официального клиента
import { h, icon, toast, sheet, prompt, confirmDialog, dialog, pagedList, emptyView, img, formatDate, plural, skParts } from '../ui.js';
import { api, A, auth } from '../api.js';
import { registerScreen, navigate } from '../router.js';
import { backToolbar, avatarEl, profileName, relTime, imageViewer, needAuthView } from './common.js';
import { socialToken } from './auth.js';

const TITLE = 'Настройки профиля';
const LIST_STYLE = { maxWidth: '760px' };
const FAIL = 'Что-то пошло не так, попробуйте позже';
// Больше бекенд не принимает (error_file_too_large): картинка пережимается до этого размера
const MAX_UPLOAD = 1024 * 1024;
// Кто видит (privacy_values, privacy_friend_requests_values): значение — номер пункта (PrivacyEditRequest.permission)
const PRIVACY = ['Все пользователи', 'Только друзья', 'Только я'];
const FRIEND_REQUESTS = ['Все пользователи', 'Никто'];
// Привязка к сервисам: поле токена — как в ProfilePreferenceApi (vk/yandex — accessToken, google/telegram — idToken)
const SERVICES = [['yandex', 'Яндекс', 'ic_yandex', 'accessToken'], ['vk', 'ВКонтакте', 'ic_vk', 'accessToken'],
  ['telegram', 'Telegram', 'ic_telegram', 'idToken'], ['google', 'Google', 'ic_google', 'idToken']];

// Файл картинки в multipart: часть «image» с именем файла; у фото профиля ещё часть «name» со словом «image»
// и тип файла «image/*» (ProfilePreferenceRepository), у обложки — настоящий тип (ChannelApi.coverUpload)
function imageForm(blob, type, withName) {
  const fd = new FormData();
  fd.append('image', new Blob([blob], { type }), `image_${Date.now()}.jpg`);
  if (withName) fd.append('name', 'image');
  return fd;
}

const P = {
  my: () => api.get('profile/preference/my'),
  avatarEdit: (blob) => api.multipart('profile/preference/avatar/edit', imageForm(blob, 'image/*', true)),
  avatarDelete: () => api.get('profile/preference/avatar/delete'),
  coverUpload: (cid, blob) => api.multipart(`channel/cover/upload/${cid}`, imageForm(blob, 'image/jpeg', false)),
  coverDelete: (cid) => api.post(`channel/cover/delete/${cid}`),
  blogCreate: () => api.post('channel/blog/create'),
  statusEdit: (status) => api.post('profile/preference/status/edit', { status }),
  // kind: stats, counts, social, friendRequests
  privacy: (kind, permission) => api.post(`profile/preference/privacy/${kind}/edit`, { permission }),
  incognito: () => api.get('profile/preference/privacy/incognito/edit'), // переключает, без параметров
  social: () => api.get('profile/preference/social'),
  socialEdit: (body) => api.post('profile/preference/social/edit', body),
  loginInfo: () => api.post('profile/preference/login/info'),
  loginChange: (login) => api.post('profile/preference/login/change', undefined, { login }),
  loginCheck: (login) => api.form('auth/checkLogin', { login }, {}, { withToken: false }),
  loginHistory: (page) => api.get(`profile/login/history/all/${auth.profileId}/${page}`),
  badges: (page) => api.get(`profile/preference/badge/all/${page}`),
  badgeEdit: (id) => api.get(`profile/preference/badge/edit/${id}`),
  badgeRemove: () => api.get('profile/preference/badge/remove'),
  blockList: (page) => api.get(`profile/blocklist/all/${page}`),
  emailChange: (f) => api.form('profile/preference/email/change', f, {}, { apiVersion: 'v2' }),
  emailVerify: (q) => api.get('profile/preference/email/verify', q),
  emailResend: (f) => api.form('profile/preference/email/resend', f),
  bind: (provider, field, token) => api.form(`profile/preference/${provider}/bind`, { [field]: token }),
  unbind: (provider) => api.post(`profile/preference/${provider}/unbind`),
  deletionStatus: () => api.get('profile/deletion/status'),
  deletionRequest: (password) => api.form('profile/deletion/request', { password }),
  deletionCancel: () => api.post('profile/deletion/cancel'),
};

// Ник и аватар в сохранённом профиле («Смотреть вместе», приветствие AI-помощника). Не auth.save: его
// 'auth-changed' сбрасывает все вкладки и память экранов, как при смене аккаунта
function patchSavedProfile(fields) {
  try {
    const p = JSON.parse(localStorage.getItem('anixart.profile') || 'null');
    if (p) localStorage.setItem('anixart.profile', JSON.stringify({ ...p, ...fields }));
  } catch { /* storage недоступен */ }
}

function item(ic, title, sub, onClick) {
  const subEl = h('div', { class: 'sub' }, sub || '');
  const el = h('div', { class: 'menu-item', onclick: onClick }, typeof ic === 'string' ? icon(ic) : ic, h('div', { class: 'grow' }, h('div', null, title), subEl));
  el.sub = subEl;
  return el;
}
// Переключатель с запросом: onChange(вкл) → true, если сервер принял; иначе возвращается назад
function switchItem(ic, title, sub, checked, onChange) {
  const cb = h('input', { type: 'checkbox' }); cb.checked = checked;
  cb.onchange = async () => {
    const want = cb.checked;
    cb.disabled = true;
    let ok = false;
    try { ok = await onChange(want); } catch { toast(FAIL); }
    cb.disabled = false;
    if (!ok) cb.checked = !want;
  };
  const el = h('label', { class: 'menu-item' }, icon(ic), h('div', { class: 'grow' }, h('div', null, title), sub ? h('div', { class: 'sub' }, sub) : null), h('span', { class: 'switch' }, cb, h('span')));
  el.cb = cb;
  return el;
}
const cat = (title) => h('div', { class: 'menu-cat' }, title);
function field(label, type = 'text', attrs = {}) {
  const input = h('input', { class: 'input', type, ...attrs });
  const err = h('div', { class: 'err-text' });
  const wrap = h('div', { class: 'field' }, h('label', null, label), input, err);
  wrap.input = input; wrap.setError = (m) => { err.textContent = m || ''; };
  return wrap;
}
const info = (title, text) => dialog({ title, content: h('p', null, text), actions: [{ label: 'Понятно', primary: true }] });

// ---------- Картинка с устройства и кадрирование ----------

function pickImage() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    input.onchange = () => { resolve(input.files[0] || null); input.remove(); };
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

// Кадрирование перед загрузкой (в Anixart — CropImage): квадрат с кругом для фото профиля, полоса 3:1 для обложки.
// Двигать — мышью или пальцем, масштаб — колесом, щипком или ползунком. Результат — JPEG не больше MAX_UPLOAD,
// длинная сторона — до size точек (без увеличения маленьких картинок). null — отмена
async function cropImage(file, { aspect = 1, round = false, size = 1024, title }) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { toast('Выбранный файл имеет неверный формат'); return null; }
  const W = Math.round(Math.max(200, Math.min(aspect > 1 ? 640 : 360, innerWidth - 96))); const H = Math.round(W / aspect);
  const dpr = devicePixelRatio || 1;
  const canvas = h('canvas', { width: Math.round(W * dpr), height: Math.round(H * dpr) });
  const box = h('div', { class: `crop-box${round ? ' round' : ''}`, style: { width: `${W}px`, height: `${H}px` } }, canvas, h('div', { class: 'crop-mask' }));
  const zoom = h('input', { type: 'range', class: 'crop-zoom', min: 0, max: 100, value: 0, 'aria-label': 'Масштаб' });
  const g = canvas.getContext('2d');
  // наименьший масштаб — картинка закрывает рамку целиком
  const min = Math.max(W / bmp.width, H / bmp.height); const max = min * 4;
  let scale = min; let ox = (W - bmp.width * scale) / 2; let oy = (H - bmp.height * scale) / 2;
  const clamp = () => { ox = Math.min(0, Math.max(W - bmp.width * scale, ox)); oy = Math.min(0, Math.max(H - bmp.height * scale, oy)); };
  const draw = () => {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, ox, oy, bmp.width * scale, bmp.height * scale);
  };
  // масштаб вокруг точки (cx, cy) рамки: точка под пальцем/курсором остаётся на месте
  const zoomAt = (s, cx = W / 2, cy = H / 2) => {
    s = Math.min(max, Math.max(min, s));
    ox = cx - (cx - ox) * (s / scale); oy = cy - (cy - oy) * (s / scale); scale = s;
    clamp();
    zoom.value = String(Math.round((Math.log(scale / min) / Math.log(max / min)) * 100));
    draw();
  };
  zoom.oninput = () => zoomAt(min * (max / min) ** (Number(zoom.value) / 100));
  const pts = new Map(); let pinch = null;
  const pos = (e) => { const r = box.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const spread = () => { const [a, b] = [...pts.values()]; return { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 }; };
  box.addEventListener('pointerdown', (e) => {
    box.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, pos(e));
    box.classList.add('dragging');
    pinch = pts.size === 2 ? spread() : null;
  });
  box.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const [x, y] = pos(e); const [px, py] = pts.get(e.pointerId);
    pts.set(e.pointerId, [x, y]);
    if (pts.size === 1) { ox += x - px; oy += y - py; clamp(); draw(); } else if (pts.size === 2 && pinch) {
      const d = spread();
      zoomAt(scale * (d.dist / pinch.dist), d.cx, d.cy);
      pinch = d;
    }
  });
  const up = (e) => { pts.delete(e.pointerId); pinch = pts.size === 2 ? spread() : null; if (!pts.size) box.classList.remove('dragging'); };
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
  box.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = pos(e); zoomAt(scale * Math.exp(-e.deltaY * 0.0015), x, y); }, { passive: false });
  draw();
  // кадр в JPEG: сначала качество пониже, потом размер поменьше — пока не уложится в MAX_UPLOAD
  const exportCrop = async () => {
    const sw = W / scale; const sh = H / scale;
    let w = Math.round(Math.min(size, sw));
    for (let step = 0; step < 4; step++) {
      const ht = Math.max(1, Math.round(w / aspect));
      const out = h('canvas', { width: w, height: ht });
      const c = out.getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, w, ht); // прозрачный PNG — на белом, а не на чёрном
      c.imageSmoothingQuality = 'high';
      c.drawImage(bmp, -ox / scale, -oy / scale, sw, sh, 0, 0, w, ht);
      for (const q of [0.92, 0.85, 0.75]) {
        const blob = await new Promise((ok) => out.toBlob(ok, 'image/jpeg', q));
        if (blob && blob.size <= MAX_UPLOAD) return blob;
      }
      w = Math.round(w * 0.75);
    }
    return null;
  };
  return new Promise((resolve) => {
    let done = false;
    dialog({
      title, cls: aspect > 1 ? 'wide' : '',
      content: h('div', null, box, zoom, h('p', { class: 'muted', style: { fontSize: '13px', margin: '6px 0 0', textAlign: 'center' } }, 'Перетащите картинку, чтобы выбрать кадр')),
      actions: [{ label: 'Отмена' }, {
        label: 'Сохранить', primary: true,
        onClick: async () => {
          const blob = await exportCrop();
          if (!blob) { toast('Выбранный файл имеет слишком большой размер'); return true; }
          done = true; resolve(blob);
          return false;
        },
      }],
      onClose: () => { bmp.close?.(); if (!done) resolve(null); },
    });
  });
}

// ---------- Главный экран ----------

const skeletonView = () => [backToolbar(TITLE), h('div', { class: 'menu-list', style: LIST_STYLE },
  [6, 5, 1, 4, 1].flatMap((n) => [h('div', { class: 'menu-cat' }, skParts.line('120px', 'title')),
    ...Array.from({ length: n }, () => h('div', { class: 'menu-item' }, skParts.circle('24px'), skParts.col('7px', skParts.line('40%', 'title'), skParts.line('64%'))))]))];

registerScreen('profile-settings', async (_p, ctx) => {
  if (!auth.loggedIn) return h('div', null, backToolbar(TITLE), needAuthView());
  // privilege_level — из профиля: «Режим инкогнито» в Anixart только у модераторов и выше (уровень от 2)
  const [my, own] = await Promise.all([P.my(), A.profile(auth.profileId).catch(() => null)]);
  if (my.code !== 0) throw new Error(`profile/preference/my: код ${my.code}`);
  const st = { ...my };
  const me = own?.profile || {};
  let login = me.login || auth.profile?.login || '';

  // --- Персонализация ---
  const avatarSlot = h('span', { style: { display: 'contents' } });
  const avatar = item(avatarSlot, 'Изменить фото профиля', 'Загрузить с устройства', () => {
    if (st.is_change_avatar_banned) return info('Ошибка', `Возможность смены аватара для Вас временно ограничена из-за нарушения правил до:\n\n${formatDate(st.ban_change_avatar_expires, true)}`);
    sheet('Фото профиля', [
      st.avatar ? { label: 'Открыть', icon: 'ic_open_in_new', onClick: () => imageViewer(st.avatar, { title: login }) } : null,
      { label: 'Загрузить с устройства', icon: 'ic_edit_outline', onClick: () => uploadAvatar() },
      st.avatar ? { label: 'Удалить', icon: 'ic_trash_outline', danger: true, onClick: () => deleteAvatar() } : null,
    ]);
  });
  async function uploadAvatar() {
    const file = await pickImage();
    if (!file) return;
    const blob = await cropImage(file, { aspect: 1, round: true, size: 1024, title: 'Фото профиля' });
    if (!blob) return;
    toast('Загружаем фото…');
    try {
      const r = await P.avatarEdit(blob);
      if (r.code !== 0) throw new Error();
      if (r.avatar) st.avatar = r.avatar;
      patchSavedProfile({ avatar: st.avatar });
      paint();
      toast('Изображение профиля успешно установлено', { ok: true });
    } catch { toast(FAIL); }
  }
  async function deleteAvatar() {
    if (!(await confirmDialog('Фото профиля', 'Удалить фото профиля?', 'Удалить'))) return;
    try {
      const r = await P.avatarDelete();
      if (r.code !== 0) throw new Error();
      st.avatar = r.avatar || '';
      patchSavedProfile({ avatar: st.avatar });
      paint();
      toast('Фото профиля удалено', { ok: true });
    } catch { toast(FAIL); }
  }

  // Обложка — у блога профиля (канал channel_id); блога нет — сначала «Улучшить профиль» (BlogCreateDialogFragment)
  const cover = item('ic_preference_appearance', 'Изменить обложку', 'Загрузить с устройства', async () => {
    if (!st.channel_id) {
      if (!(await confirmDialog('Улучшить профиль', 'Обложка ставится на блог профиля — в нём можно публиковать записи. Улучшить профиль и завести блог?', 'Улучшить профиль'))) return;
      let r;
      try { r = await P.blogCreate(); } catch { toast(FAIL); return; }
      if (r.code === 2) { info('Ошибка', 'Ой, кажется, твой уровень репутации слишком низок.'); return; }
      if (r.code !== 0 || !r.channel) { toast(FAIL); return; }
      st.channel_id = r.channel.id;
      toast('Твой профиль улучшен!', { ok: true });
      return uploadCover(); // у нового блога обложки нет — сразу к выбору
    }
    sheet('Обложка блога', [
      { label: 'Изменить', icon: 'ic_edit_outline', onClick: () => uploadCover() },
      { label: 'Удалить', icon: 'ic_trash_outline', danger: true, onClick: () => deleteCover() },
    ]);
  });
  async function uploadCover() {
    const file = await pickImage();
    if (!file) return;
    const blob = await cropImage(file, { aspect: 3, size: 1500, title: 'Обложка блога' });
    if (!blob) return;
    toast('Загружаем обложку…');
    try {
      const r = await P.coverUpload(st.channel_id, blob);
      if (r.code !== 0) throw new Error();
      toast('Обложка блога была успешно установлена', { ok: true });
    } catch { toast(FAIL); }
  }
  async function deleteCover() {
    if (!(await confirmDialog('Обложка блога', 'Удалить обложку блога?', 'Удалить'))) return;
    try { const r = await P.coverDelete(st.channel_id); if (r.code !== 0) throw new Error(); toast('Обложка удалена', { ok: true }); } catch { toast(FAIL); }
  }

  const status = item('ic_pencil', 'Изменить статус', '', async () => {
    const v = await prompt('Изменить статус', { value: st.status || '', placeholder: 'Ваш статус…', okLabel: 'Сохранить' });
    if (v == null) return;
    try {
      const r = await P.statusEdit(v);
      if (r.code !== 0) throw new Error();
      st.status = v; paint();
      toast('Сохранено', { ok: true });
    } catch { toast(FAIL); }
  });
  const nick = item('ic_edit_outline', 'Изменить никнейм', '', () => {
    if (st.is_change_login_banned) return info('Ошибка', `Возможность смены никнейма для Вас временно ограничена из-за нарушения правил до:\n\n${formatDate(st.ban_change_login_expires, true)}`);
    navigate('profile-login');
  });
  const badgeSlot = h('span', { style: { display: 'contents' } });
  const badge = item('ic_stars', 'Изменить значок', '', () => navigate('profile-badges', { badgeId: st.badge?.id ?? null }));
  badge.append(badgeSlot);
  const social = item('ic_link', 'Мои социальные сети', 'Укажите ссылки на свои страницы в соц. сетях', () => socialDialog());

  // --- Приватность: значение меняется сразу, при ошибке возвращается (как ListPreference в Anixart) ---
  const privacy = (ic, title, options, key, kind) => {
    const el = item(ic, title, '', () => sheet(title, options.map((label, v) => ({
      label, checked: v === (st[key] || 0),
      onClick: async () => {
        const prev = st[key] || 0;
        if (v === prev) return;
        st[key] = v; paint();
        try { const r = await P.privacy(kind, v); if (r.code !== 0) throw new Error(); } catch { st[key] = prev; paint(); toast(FAIL); }
      },
    }))));
    el.paint = () => { el.sub.textContent = options[st[key] || 0] || options[0]; };
    return el;
  };
  const privacyItems = [
    privacy('ic_eye_outline', 'Кто видит мою статистику, оценки и историю просмотра', PRIVACY, 'privacy_stats', 'stats'),
    privacy('ic_collection', 'Кто видит в профиле мои комментарии, коллекции, видео и друзей', PRIVACY, 'privacy_counts', 'counts'),
    privacy('ic_link', 'Кто видит мои социальные сети', PRIVACY, 'privacy_social', 'social'),
    privacy('ic_person_add', 'Кто может отправлять мне заявки в друзья', FRIEND_REQUESTS, 'privacy_friend_requests', 'friendRequests'),
  ];
  const incognito = (Number(me.privilege_level) >= 2 || st.is_incognito)
    ? switchItem('ic_eye_off_outline', 'Режим инкогнито', 'Скрывает ваш онлайн-статус и время последнего визита от всех пользователей', !!st.is_incognito, async (on) => {
      const r = await P.incognito();
      if (r.code !== 0) { toast(FAIL); return false; }
      st.is_incognito = on;
      return true;
    }) : null;
  const blocklist = item('ic_lock', 'Блоклист', 'Список пользователей, которым запрещен доступ к Вашей странице', () => navigate('profile-blocklist'));

  // --- Безопасность ---
  const email = item('ic_message', 'Изменить Email', '', () => changeEmail(st.email_hint, () => P.my().then((m) => { Object.assign(st, m); paint(); }).catch(() => {})));

  // --- Привязка к сервисам ---
  const services = SERVICES.map(([provider, label, ic, tokenField]) => {
    const key = `is_${provider}_bound`;
    return switchItem(ic, label, null, !!st[key], async (on) => {
      const ok = on ? await bindService(provider, label, tokenField) : await unbindService(provider, label);
      if (ok) st[key] = on;
      return ok;
    });
  });

  const deletion = item('ic_trash_outline', 'Удаление аккаунта', 'Запросить удаление аккаунта или отменить ранее созданный запрос', () => navigate('profile-deletion'));

  function paint() {
    avatarSlot.replaceChildren(st.avatar ? img(st.avatar, 'avatar sm') : icon('ic_profile'));
    status.sub.textContent = st.status || 'Не установлен';
    nick.sub.textContent = login;
    badge.sub.textContent = st.badge?.name || 'Не установлен';
    badgeSlot.replaceChildren(st.badge?.image_url && st.badge.type === 0 ? h('img', { class: 'badge-img sm', src: st.badge.image_url, referrerpolicy: 'no-referrer', alt: '' }) : '');
    email.sub.textContent = st.email_hint ? `Сейчас: ${st.email_hint}` : 'Изменить Email учетной записи';
    privacyItems.forEach((el) => el.paint());
    if (incognito) incognito.cb.checked = !!st.is_incognito;
    services.forEach((el, i) => { el.cb.checked = !!st[`is_${SERVICES[i][0]}_bound`]; });
  }
  paint();

  // вернулись со «Значка» или «Никнейма» — свежие значения (ник — из сохранённого профиля, его меняет profile-login)
  ctx.setOnShow(({ returning }) => {
    if (!returning) return;
    login = auth.profile?.login || login;
    P.my().then((m) => { if (m.code === 0) { Object.assign(st, m); paint(); } }).catch(() => {});
  });

  return h('div', null, backToolbar(TITLE), h('div', { class: 'menu-list', style: LIST_STYLE },
    cat('Персонализация'), avatar, cover, status, nick, badge, social,
    cat('Приватность'), ...privacyItems, incognito, blocklist,
    cat('Безопасность'), email,
    cat('Привязка к сервисам'), ...services,
    cat('Аккаунт'), deletion));
}, skeletonView);

// Соцсети (ProfileSocialFragment): ссылка или никнейм; на сервер уходит никнейм — из ссылки он вынимается
// теми же выражениями, что в Anixart. Instagram в Anixart больше не редактируется — отправляем как был
const SOCIAL_FIELDS = [
  ['vkPage', 'vk_page', 'ВКонтакте', /(?:https?:\/\/)?(?:www\.)?(?:vk\.com|vk\.me)\/([A-Za-z0-9\-_.]+)/],
  ['tgPage', 'tg_page', 'Telegram', /(?:https?:\/\/)?(?:www\.)?(?:t\.me)\/([A-Za-z0-9\-_.]+)/],
  ['discordPage', 'discord_page', 'Discord', null],
  ['ttPage', 'tt_page', 'TikTok', /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com)\/@([A-Za-z0-9\-_.]+)/],
];
// код ошибки SocialEditResponse → поле
const SOCIAL_ERRORS = { 2: 'vkPage', 3: 'tgPage', 5: 'ttPage', 6: 'discordPage' };
function socialNick(value, urlRe) {
  if (!urlRe) { const m = /^((?!.*\.\.)[a-zA-Z0-9_.]{2,32})$/.exec(value); return m ? m[1] : null; } // Discord
  const v = value.replace(/\s/g, '');
  const m = urlRe.exec(v) || /^@?([a-zA-Z0-9_.-]{3,32})$/.exec(v);
  return m ? m[1] : null;
}
async function socialDialog() {
  let s;
  try { s = await P.social(); } catch { toast(FAIL); return; }
  const fields = Object.fromEntries(SOCIAL_FIELDS.map(([key, resKey, label]) => {
    const f = field(label, 'text', { placeholder: key === 'discordPage' ? 'Никнейм' : 'Ссылка или никнейм' });
    f.input.value = s[resKey] || '';
    return [key, f];
  }));
  dialog({
    title: 'Социальные сети', cls: 'scroll-body', // с клавиатурой кнопки окна — на виду
    content: h('div', null, h('p', null, 'Укажите ссылки на свои социальные сети, чтобы другие пользователи могли с вами связаться'), Object.values(fields)),
    actions: [{ label: 'Отмена' }, {
      label: 'Сохранить', primary: true,
      onClick: async () => {
        const body = { instPage: s.inst_page || '' };
        let bad = false;
        for (const [key, , , re] of SOCIAL_FIELDS) {
          const f = fields[key]; f.setError('');
          const v = f.input.value.trim();
          if (!v) { body[key] = ''; continue; }
          const nickName = socialNick(v, re);
          if (nickName == null) { f.setError('Ссылка или никнейм указаны неверно'); bad = true; } else body[key] = nickName;
        }
        if (bad) return true;
        let r;
        try { r = await P.socialEdit(body); } catch { toast(FAIL); return true; }
        if (r.code === 0) { toast('Изменения сохранены', { ok: true }); return false; }
        if (SOCIAL_ERRORS[r.code]) { fields[SOCIAL_ERRORS[r.code]].setError('Ссылка или никнейм указаны неверно'); return true; }
        toast(FAIL);
        return true;
      },
    }],
  });
}

// ---------- Email: текущий Email, новый, пароль → код на новый Email (ChangeEmailDialogFragment) ----------

const EMAIL_ERRORS = {
  change: { 2: 'Текущий пароль введен неверно.', 3: 'Неверный текущий Email.', 4: 'Неверный Email', 5: 'Email уже занят', 7: 'Код не может быть отправлен. Повторите попытку позднее.' },
  verify: { 2: 'Неверный Email', 3: 'Неверный код.', 4: 'Код более не действителен.', 5: 'Ошибка верификации. Попробуйте начать процедуру смены Email заново.', 6: 'Email уже занят' },
  resend: { 2: 'Текущий пароль введен неверно.', 3: 'Неверный текущий Email.', 4: 'Ошибка верификации. Попробуйте начать процедуру смены Email заново.', 5: 'Код не может быть отправлен. Повторите попытку позднее.' },
};
function changeEmail(hint, onChanged) {
  const cur = field('Текущий Email', 'email', { placeholder: hint || '', autocomplete: 'email' });
  const next = field('Новый Email', 'email', { autocomplete: 'off' });
  const pass = field('Текущий пароль', 'password', { autocomplete: 'current-password' });
  dialog({
    title: 'Изменить Email', cls: 'scroll-body', // с клавиатурой кнопки окна — на виду
    content: h('div', null, h('p', null, 'Для смены Email введите Ваш текущий Email, новый Email и текущий пароль.'), cur, next, pass),
    actions: [{ label: 'Отмена' }, {
      label: 'Продолжить', primary: true,
      onClick: async () => {
        [cur, next, pass].forEach((f) => f.setError(''));
        const f = { current_email: cur.input.value.trim(), current_password: pass.input.value, new_email: next.input.value.trim() };
        if (!f.current_email) { cur.setError('Неверный текущий Email.'); return true; }
        if (!f.new_email) { next.setError('Неверный Email'); return true; }
        if (f.current_password.length < 6 || f.current_password.length > 32) { pass.setError('Текущий пароль введен неверно.'); return true; }
        let r;
        try { r = await P.emailChange(f); } catch { toast(FAIL); return true; }
        // 6 — код уже отправлен раньше: тоже к вводу кода
        if (r.code === 0 || r.code === 6) {
          if (r.code === 6) toast('Код уже был отправлен на указанный Email. Пожалуйста, проверьте почту.');
          emailCodeDialog(f, r.hash, r.timestamp_expires, onChanged);
          return false;
        }
        toast(EMAIL_ERRORS.change[r.code] || FAIL);
        return true;
      },
    }],
  });
}
function emailCodeDialog(f, hash, expires, onChanged) {
  const code = field('Код подтверждения', 'text', { inputmode: 'numeric', autocomplete: 'one-time-code' });
  const resend = h('button', {
    class: 'btn btn-text',
    onclick: async () => {
      // повторно — только когда истёк прежний код (onEmailCodeStillActual)
      const left = Math.ceil((expires || 0) - Date.now() / 1000);
      if (left > 0) { toast(`Повторно отправить код можно через ${left} ${plural(left, 'секунду', 'секунды', 'секунд')}`); return; }
      try {
        const r = await P.emailResend({ new_email: f.new_email, current_email: f.current_email, current_password: f.current_password, hash });
        if (r.code !== 0) { toast(EMAIL_ERRORS.resend[r.code] || FAIL); return; }
        expires = r.timestamp_expires;
        toast('Код подтверждения отправлен повторно');
      } catch { toast(FAIL); }
    },
  }, 'Отправить код повторно');
  dialog({
    title: 'Подтверждение Email', cls: 'scroll-body', // с клавиатурой кнопки окна — на виду
    content: h('div', null, h('p', null, `Код подтверждения отправлен на ${f.new_email}`), code, resend),
    actions: [{ label: 'Отмена' }, {
      label: 'Подтвердить', primary: true,
      onClick: async () => {
        code.setError('');
        const n = parseInt(code.input.value.trim(), 10);
        if (!Number.isFinite(n)) { code.setError('Неверный код.'); return true; }
        let r;
        try { r = await P.emailVerify({ new_email: f.new_email, code: n, hash }); } catch { toast(FAIL); return true; }
        if (r.code === 0) { toast('Email успешно изменен', { ok: true }); onChanged?.(); return false; }
        toast(EMAIL_ERRORS.verify[r.code] || FAIL);
        return r.code !== 5; // неверный hash — только начать заново
      },
    }],
  });
}

// ---------- Привязка к сервисам: токен — тем же входом, что на экране входа (auth.js socialToken) ----------

async function bindService(provider, label, tokenField) {
  const inApp = !!(window.anixartNative && window.anixartNative.socialAuth);
  const f = await fetch('/__features').then((r) => r.json()).catch(() => ({}));
  if (!inApp && provider !== 'google') { toast('Привязка Яндекса, ВКонтакте и Telegram — в Anix для Windows'); return false; }
  if (!f.social?.[provider]) { toast(`Вход через ${label} недоступен в этой сборке`); return false; }
  let ex;
  try { ex = await socialToken(provider, label); } catch (e) { toast(String(e.message || e)); return false; }
  if (!ex) return false;
  const r = await P.bind(provider, tokenField, ex.token);
  if (r.code === 0) { toast(`Учётная запись ${label} была успешно привязана.`, { ok: true }); return true; }
  toast(r.code === 3 ? `Эта учётная запись ${label} уже привязана к аккаунту Anixart` : r.code === 2 ? `${label} не подтвердил вход. Попробуйте ещё раз.` : FAIL);
  return false;
}
async function unbindService(provider, label) {
  if (!(await confirmDialog('Отвязка учётной записи', `Учётная запись ${label} будет отвязана от этого аккаунта. Вход будет возможен только по логину и паролю, если больше нет привязки к другим сервисам. Вы действительно хотите продолжить?`, 'Да'))) return false;
  const r = await P.unbind(provider);
  // 2 — и так не привязана
  if (r.code === 0 || r.code === 2) { toast(`Учётная запись ${label} была успешно отвязана.`, { ok: true }); return true; }
  toast(FAIL);
  return false;
}

// ---------- Никнейм (ChangeLoginPreferenceFragment): проверка на лету, подсказки свободных, история изменений ----------

registerScreen('profile-login', async () => {
  let inf = await P.loginInfo();
  let current = inf.login || auth.profile?.login || '';
  const f = field('Никнейм', 'text', { maxlength: 20, autocomplete: 'off', spellcheck: 'false' });
  f.input.value = current;
  const hint = h('div', { class: 'muted', style: { fontSize: '13px', margin: '-6px 0 12px' } });
  const suggestions = h('div', { class: 'chips', style: { margin: '-4px 0 14px' } });
  const btn = h('button', { class: 'btn btn-primary' }, 'Изменить');
  let free = false; let timer = 0; let seq = 0;
  const paintInfo = () => {
    hint.textContent = inf.is_change_available ? 'Никнейм виден всем — в профиле, комментариях и коллекциях'
      : inf.next_change_available_at ? `Сменить никнейм снова можно будет ${formatDate(inf.next_change_available_at, true)}` : 'Сменить никнейм сейчас нельзя';
    f.input.disabled = !inf.is_change_available;
  };
  const paintBtn = () => { btn.disabled = !inf.is_change_available || !free; };
  const showSuggestions = (list) => suggestions.replaceChildren(...(list || []).map((s) => h('button', { class: 'chip', onclick: () => { f.input.value = s; check(); } }, s)));
  // 3–20 символов, затем auth/checkLogin: свободен ли
  function check() {
    const v = f.input.value.trim();
    clearTimeout(timer); free = false; f.setError(''); showSuggestions([]); paintBtn();
    if (!v || v === current) return;
    if (v.length < 3) { f.setError('Никнейм слишком короткий'); return; }
    if (v.length > 20) { f.setError('Никнейм слишком длинный'); return; }
    const my = ++seq;
    timer = setTimeout(async () => {
      let r;
      try { r = await P.loginCheck(v); } catch { return; }
      if (my !== seq) return;
      if (r.code === 0 && r.available) { free = true; paintBtn(); return; }
      if (r.code === 0) { f.setError('Никнейм уже занят'); showSuggestions(r.suggested_logins); return; }
      if (r.code === 2) f.setError('Никнейм указан некорректно');
    }, 400);
  }
  f.input.addEventListener('input', check);
  const history = pagedList({
    skeleton: 'menu', load: (page) => P.loginHistory(page),
    render: (c) => h('div', { class: 'menu-item' }, icon('ic_history'), h('div', { class: 'grow' }, c.newLogin || c.new_login), h('span', { class: 'muted' }, relTime(c.timestamp))),
    empty: () => emptyView('Изменений нет', null, 'ic_history'),
  });
  btn.onclick = async () => {
    const v = f.input.value.trim();
    if (!free || !v) return;
    btn.disabled = true;
    let r;
    try { r = await P.loginChange(v); } catch { toast(FAIL); paintBtn(); return; }
    if (r.code === 0) {
      current = v; free = false;
      patchSavedProfile({ login: v });
      toast('Никнейм успешно изменен', { ok: true });
      try { inf = await P.loginInfo(); } catch { /* прежние сведения */ }
      paintInfo(); history.reload();
    } else if (r.code === 2) f.setError('Никнейм указан некорректно');
    else if (r.code === 3) { f.setError('Никнейм уже занят'); showSuggestions(r.suggested_logins); free = false; } else if (r.code === 4) {
      try { inf = await P.loginInfo(); } catch { /* прежние сведения */ }
      paintInfo();
      toast(`Никнейм можно менять не так часто — следующая смена ${formatDate(inf.next_change_available_at, true)}`);
    } else toast(FAIL);
    paintBtn();
  };
  paintInfo(); paintBtn();
  return h('div', null, backToolbar('Изменить никнейм'),
    h('div', { style: { maxWidth: '760px', padding: '8px 24px 0' } }, f, suggestions, hint, btn),
    h('div', { style: LIST_STYLE }, cat('История изменений'), history));
}, () => [backToolbar('Изменить никнейм'), h('div', { style: { maxWidth: '760px', padding: '8px 24px 0' } },
  skParts.line('80px'), skParts.block({ height: '48px', borderRadius: '10px', margin: '6px 0 14px' }), skParts.pill('120px')),
h('div', { style: LIST_STYLE }, h('div', { class: 'menu-cat' }, skParts.line('140px', 'title')),
  Array.from({ length: 3 }, () => h('div', { class: 'menu-item' }, skParts.circle('24px'), skParts.col('0', skParts.line('30%', 'title')))))]);

// ---------- Значок (ProfileBadgeFragment): нажатие ставит значок, повторное — снимает ----------

registerScreen('profile-badges', ({ badgeId = null } = {}) => {
  let selected = badgeId;
  const marks = new Map(); // id значка → галочка
  const paint = () => marks.forEach((m, id) => { m.style.visibility = id === selected ? '' : 'hidden'; });
  const list = pagedList({
    skeleton: 'menu',
    load: (page) => P.badges(page),
    onFirst: (r) => { if (r.profile) selected = r.profile.badge?.id ?? r.profile.badge_id ?? null; },
    render: (b) => {
      const mark = icon('ic_check'); mark.style.color = 'var(--carmine)';
      marks.set(b.id, mark);
      const row = h('div', {
        class: 'menu-item',
        onclick: async () => {
          const on = selected === b.id;
          try {
            const r = on ? await P.badgeRemove() : await P.badgeEdit(b.id);
            if (r.code !== 0) throw new Error();
            selected = on ? null : b.id; paint();
            toast(on ? 'Значок снят' : 'Значок установлен', { ok: true });
          } catch { toast(FAIL); }
        },
      }, h('img', { class: 'badge-img', src: b.image_url || '', referrerpolicy: 'no-referrer', alt: '' }),
      h('div', { class: 'grow' }, h('div', null, b.name || 'Значок'), b.timestamp ? h('div', { class: 'sub' }, `Получен ${formatDate(b.timestamp)}`) : null), mark);
      queueMicrotask(paint);
      return row;
    },
    empty: () => emptyView('Значков пока нет :(', 'Вы можете получить значки за определенные действия, участие в событиях и конкурсах', 'ic_stars'),
  });
  return h('div', null, backToolbar('Установка значка'), h('div', { style: LIST_STYLE }, list));
});

// ---------- Блоклист (ProfileBlockListFragment) ----------

registerScreen('profile-blocklist', () => {
  const empty = () => emptyView('Блоклист пуст', 'Здесь будут пользователи, которым запрещен доступ к Вашей странице', 'ic_lock');
  const list = pagedList({
    skeleton: 'profiles',
    load: (page) => P.blockList(page),
    render: (p) => {
      const row = h('div', { class: 'type-row', onclick: () => navigate('profile', { id: p.id }) }, avatarEl(p), h('div', { class: 'grow' }, profileName(p)));
      row.append(h('button', {
        class: 'btn btn-text',
        onclick: async (e) => {
          e.stopPropagation();
          try {
            const r = await A.blockRemove(p.id);
            if (r.code !== 0) throw new Error();
            row.remove();
            toast('Пользователь убран из Вашего блоклиста', { ok: true });
            if (!list.querySelector('.type-row')) list.querySelector('.sentinel')?.replaceChildren(empty());
          } catch { toast(FAIL); }
        },
      }, 'Разблокировать'));
      return row;
    },
    empty,
  });
  return h('div', null, backToolbar('Блоклист'), list);
});

// ---------- Удаление аккаунта (ProfileDeletionPreferenceFragment): запрос с паролем, период ожидания, отмена ----------

function remaining(sec) {
  const left = sec - Date.now() / 1000;
  if (left < 3600) return 'менее часа';
  const d = Math.floor(left / 86400);
  if (d >= 1) return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  const hh = Math.floor(left / 3600);
  return `${hh} ${plural(hh, 'час', 'часа', 'часов')}`;
}
const DELETION_ERRORS = {
  2: 'Запрос на удаление уже существует.', 3: 'Запрос на удаление не найден.', 4: 'Запрос уже обработан.',
  5: 'Период ожидания завершен. Отмена недоступна, процесс удаления уже запущен и будет завершен в ближайшее время.',
  6: 'Текущий пароль введен неверно.', 7: 'Произошла неизвестная ошибка. Обратитесь к разработчику.',
};
function askPassword() {
  return new Promise((resolve) => {
    const pass = field('Текущий пароль', 'password', { autocomplete: 'current-password' });
    let done = false;
    dialog({
      title: 'Подтверждение',
      content: h('div', null, h('p', null, 'Для подтверждения удаления необходимо ввести текущий пароль от аккаунта.'), pass),
      actions: [{ label: 'Отмена' }, {
        label: 'Удалить аккаунт', primary: true,
        onClick: () => {
          const v = pass.input.value;
          if (v.length < 6 || v.length > 32) { pass.setError('Текущий пароль введен неверно.'); return true; }
          done = true; resolve(v);
          return false;
        },
      }],
      onClose: () => { if (!done) resolve(null); },
    });
    setTimeout(() => pass.input.focus(), 30);
  });
}

registerScreen('profile-deletion', async () => {
  const body = h('div', { style: { maxWidth: '760px', padding: '8px var(--page-pad) 32px' } });
  const step = (ic, title, sub, on) => h('div', { class: 'menu-item inset', style: { cursor: 'default', opacity: on ? '' : '.6' } }, icon(ic), h('div', { class: 'grow' }, h('div', null, title), sub ? h('div', { class: 'sub' }, sub) : null));
  async function build() {
    const r = await P.deletionStatus();
    // 0 — запрос есть, 3 — запроса нет, 5 — ожидание кончилось, аккаунт уже удаляется
    const requested = r.code === 0 && !!(r.delete_at || r.requested_at);
    const inProgress = r.code === 5;
    const action = inProgress ? null : requested
      ? h('button', { class: 'btn btn-tonal lg', onclick: cancel }, 'Отменить запрос')
      : h('button', { class: 'btn btn-primary lg', onclick: request }, 'Запросить удаление аккаунта');
    body.replaceChildren(
      requested || inProgress
        ? h('div', { class: 'card', style: { marginBottom: '8px' } }, h('div', { class: 'card-title' }, icon('ic_alert'), 'Запрос создан'),
          h('div', { class: 'muted' }, inProgress ? DELETION_ERRORS[5] : `Удаление Вашего аккаунта запланировано на ${formatDate(r.delete_at, true)}`))
        : h('p', { class: 'muted', style: { margin: '8px 0 12px' } }, 'Отправьте заявку на удаление профиля, и мы удалим все ваши данные. После подачи запроса у вас будет время, чтобы изменить решение и отменить его.'),
      h('div', { class: 'menu-cat', style: { padding: '14px 0 6px' } }, 'Как это работает'),
      step(requested || inProgress ? 'ic_check_circle_outline' : 'ic_send', 'Подача заявки', requested || inProgress ? 'Вы отправили запрос на удаление аккаунта' : 'Вы отправляете запрос на удаление аккаунта', true),
      step('ic_timelapse', 'Период ожидания', inProgress ? 'Период ожидания завершён'
        : requested ? `В течение ${remaining(r.delete_at)} вы можете передумать и отменить запрос на удаление аккаунта` : 'Пока он идёт, запрос можно отменить', requested || inProgress),
      step('ic_schedule', 'Подготовка и удаление данных', inProgress ? 'Идёт подготовка к удалению данных. Это может занять несколько часов'
        : 'После завершения периода ожидания начнётся необратимый процесс удаления, который может занять несколько часов', inProgress),
      step('ic_trash_outline', 'Аккаунт удалён', 'Все данные будут удалены, и вы навсегда потеряете доступ к своему аккаунту', false),
      action ? h('div', { style: { marginTop: '20px' } }, action) : null);
  }
  // два подтверждения: «Вы уверены» и пароль от аккаунта
  async function request() {
    if (!(await confirmDialog('Запрос удаления аккаунта', 'Вы уверены, что хотите запросить удаление аккаунта?\n\nПосле создания запроса начнется период ожидания, в течение которого удаление можно отменить.', 'Продолжить'))) return;
    const password = await askPassword();
    if (password == null) return;
    let r;
    try { r = await P.deletionRequest(password); } catch { toast(FAIL); return; }
    if (r.code === 0) toast('Запрос на удаление аккаунта создан.');
    else toast(DELETION_ERRORS[r.code] || FAIL);
    if ([0, 2, 4, 5].includes(r.code)) await build().catch(() => {});
  }
  async function cancel() {
    if (!(await confirmDialog('Отмена удаления аккаунта', 'Вы уверены, что хотите отменить запрос на удаление аккаунта?', 'Отменить запрос'))) return;
    let r;
    try { r = await P.deletionCancel(); } catch { toast(FAIL); return; }
    if (r.code === 0) toast('Запрос на удаление аккаунта отменен.', { ok: true });
    else toast(DELETION_ERRORS[r.code] || FAIL);
    await build().catch(() => {});
  }
  await build();
  return h('div', null, backToolbar('Удаление аккаунта'), body);
}, () => [backToolbar('Удаление аккаунта'), h('div', { style: { maxWidth: '760px', padding: '8px var(--page-pad) 32px' } },
  skParts.line('92%'), skParts.line('70%', '', { marginTop: '8px' }),
  Array.from({ length: 4 }, () => h('div', { class: 'menu-item inset' }, skParts.circle('24px'), skParts.col('7px', skParts.line('40%', 'title'), skParts.line('70%')))))]);
