// Вход, регистрация, подтверждение почты, восстановление пароля (form-urlencoded) + соцсети.
// Эндпоинты, поля и коды ответов — как в мобильном клиенте:
//   auth/signIn        login, password                         → 2 профиль не найден, 3 неверный пароль
//   auth/signUp        login, email, password                  → hash; 7 код уже отправлен (тоже на ввод кода)
//   auth/<соцсеть>     <токен>                                 → вход; 2 запрос отклонён, 3 не зарегистрирован
//   auth/<соцсеть>     login, email, <токен>                   → hash (Google: 8/9), VK/Telegram/Яндекс: 8 код уже отправлен
//   auth/verify        login, email, password | <токен>, hash, code
//   auth/resend        login, email, password | <токен>, hash  → timestampExpires; 6 рано запрашивать новый
//   auth/restore       data                                    → hash; 3 код уже отправлен
//   auth/restore/verify  data, password (новый), hash, code
//   auth/restore/resend  data, password, hash                  → timestampExpires; 4 рано запрашивать новый
import { h, icon, toast, dialog } from '../ui.js';
import { A, api, auth } from '../api.js';
import { t } from '../store.js';
import { registerScreen, navigate, replace, switchTab } from '../router.js';
import { backToolbar } from './common.js';

const SOCIAL = [
  ['yandex', 'Яндекс', 'ic_yandex'],
  ['vk', 'ВКонтакте', 'ic_vk'],
  ['telegram', 'Telegram', 'ic_telegram'],
  ['google', 'Google', 'ic_google'],
];

const TEXT = {
  loginEmpty: 'Никнейм не указан',
  loginShort: 'Никнейм слишком короткий',
  loginLong: 'Никнейм слишком длинный',
  loginInvalid: 'Недопустимый никнейм',
  loginTaken: 'Никнейм уже занят',
  emailEmpty: 'Email не указан',
  emailInvalid: 'Неверный Email',
  emailTaken: 'Email уже занят',
  emailDisallowed: 'Регистрация с этим почтовым сервисом невозможна',
  passwordShort: 'Пароль слишком короткий',
  passwordLong: 'Пароль слишком длинный',
  passwordInvalid: 'Недопустимый пароль',
  passwordMismatch: 'Пароли не совпадают',
  codeAlreadySent: 'Код уже был отправлен — проверьте почту.',
  codeCannotSend: 'Не удалось отправить код. Повторите попытку позднее.',
  codeInvalid: 'Неверный код',
  codeExpired: 'Срок действия кода истёк — запросите новый',
  hashInvalid: 'Сеанс подтверждения устарел — начните заново',
  codeStillActual: 'Новый код можно будет запросить чуть позже',
  codeResent: 'Новый код отправлен',
  profileNotFound: 'Профиль с таким никнеймом или Email не найден',
};

function tooManyRegistrations() {
  dialog({ title: 'Ошибка', content: h('p', { style: { whiteSpace: 'pre-line' } }, t('error_too_many_registrations')), actions: [{ label: 'OK', primary: true }] });
}

function field(label, type = 'text', attrs = {}) {
  const input = h('input', { class: 'input', type, ...attrs });
  const err = h('div', { class: 'err-text' });
  const wrap = h('div', { class: 'field' }, h('label', null, label), input, err);
  wrap.input = input; wrap.setError = (m) => { err.textContent = m || ''; };
  return wrap;
}

// Никнейм с проверкой auth/checkLogin по мере ввода (3–20 символов) и подсказками свободных вариантов
function loginField() {
  const login = field('Никнейм');
  const sugg = h('div', { class: 'chips', style: { marginTop: '-6px', marginBottom: '10px' } });
  login.showSuggestions = (list) => sugg.replaceChildren(...(list || []).map((s) => h('button', { class: 'chip', onclick: () => { login.input.value = s; login.setError(''); sugg.replaceChildren(); } }, s)));
  let timer;
  login.input.addEventListener('input', () => {
    clearTimeout(timer);
    sugg.replaceChildren();
    timer = setTimeout(async () => {
      const v = login.input.value.trim();
      if (v.length < 3 || v.length > 20) return;
      try {
        const r = await api.form('auth/checkLogin', { login: v }, {}, { withToken: false });
        if (r.code !== 0) return;
        if (r.available) { login.setError(''); sugg.replaceChildren(h('span', { style: { color: 'var(--green)', fontSize: '13px' } }, 'Никнейм свободен')); }
        else { login.setError(TEXT.loginTaken); login.showSuggestions(r.suggested_logins); }
      } catch { /* проверка необязательна */ }
    }, 500);
  });
  login.suggestions = sugg;
  return login;
}

// Проверки формы до запроса — как в мобильном клиенте
function checkLogin(login) {
  const v = login.input.value.trim();
  if (!v) { login.setError(TEXT.loginEmpty); return null; }
  if (v.length < 3) { login.setError(TEXT.loginShort); return null; }
  if (v.length > 20) { login.setError(TEXT.loginLong); return null; }
  return v;
}
function checkEmail(email) {
  const v = email.input.value.trim().toLowerCase();
  if (!v) { email.setError(TEXT.emailEmpty); return null; }
  return v;
}
function checkPassword(pass, pass2) {
  const p = pass.input.value; const p2 = pass2.input.value;
  let ok = true;
  if (p.length < 6) { pass.setError(TEXT.passwordShort); ok = false; } else if (p.length > 32) { pass.setError(TEXT.passwordLong); ok = false; }
  if (p2.length < 6) { pass2.setError(TEXT.passwordShort); ok = false; } else if (p2.length > 32) { pass2.setError(TEXT.passwordLong); ok = false; } else if (ok && p !== p2) { pass2.setError(TEXT.passwordMismatch); ok = false; }
  return ok ? p : null;
}

function finishLogin(r) {
  auth.save(r.profileToken.token, r.profile);
  toast(`Добро пожаловать, ${r.profile.login}!`);
  setTimeout(() => switchTab('profile', { reset: true }), 0);
}

function wrap(title, sub, ...children) {
  return h('div', null, backToolbar(''), h('div', { class: 'auth-wrap' },
    h('div', { class: 'logo-big' }, icon('logo', 'big')), h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null, ...children));
}

// ---------- Соцсети ----------

// Строка ожидания для диалога входа: маленький спиннер и пояснение, что делать
const waitRow = (text) => h('div', { class: 'wait-row' }, h('div', { class: 'spinner sm' }), h('span', null, text));

// Google: во встроенных окнах Google отказывает во входе, поэтому — системный браузер. Сервер выдаёт
// одноразовый ключ и страницу /google-auth.html; ждём, пока она вернёт Firebase idToken. null — отмена.
async function googleBrowserLogin(label) {
  const s = await (await fetch('/social/google/start')).json();
  if (s.error) throw new Error(s.error);
  let canceled = false;
  const open = () => (window.anixartNative?.openExternal ? window.anixartNative.openExternal(s.url) : window.open(s.url, '_blank'));
  const wait = dialog({
    title: `Вход через ${label}`,
    content: waitRow('Продолжите вход в открывшемся браузере — приложение подхватит его само.'),
    actions: [{ label: 'Открыть снова', onClick: () => { open(); return true; } }, { label: 'Отмена' }],
    onClose: () => { canceled = true; },
  });
  open();
  while (!canceled) {
    const r = await (await fetch(`/social/google/wait?n=${s.n}`)).json();
    if (r.error) { wait.close(); throw new Error(r.error); }
    // результат приходит, пока на экране ещё браузер: дальше — запрос входа, а в фоне Android не даёт приложению
    // сети (ENOTFOUND → «HTTP 502», вход «через раз») — продолжаем, когда приложение снова на экране
    if (!r.pending) { wait.close(); window.focus(); await whenVisible(); return r; }
  }
  return null;
}

const whenVisible = () => (document.visibilityState === 'visible' ? Promise.resolve() : new Promise((ok) => {
  const f = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', f); ok(); } };
  document.addEventListener('visibilitychange', f);
}));
// сбой сети (а не ответ бекенда): shim.js и server/index.js отвечают на него 502 с code −1
const netError = (e) => e && e.status === 502 && e.body && e.body.code === -1;
// Вход по токену соцсети: сразу после возврата из браузера сеть у приложения бывает ещё не поднята — повторяем
// сетевой сбой до ~10 с (вход по токену ничего не записывает, повтор безопасен)
async function socialAuthRequest(provider, field, token) {
  for (let i = 0; ; i++) {
    try { return await api.form(`auth/${provider}`, { [field]: token }, {}, { withToken: false }); }
    catch (e) { if (i >= 6 || !netError(e)) throw e; await new Promise((ok) => setTimeout(ok, 1500)); }
  }
}

// Токен соцсети: окно Electron (Google — системный браузер) → обмен на сервере → { field, token, email? }
// (и привязка соцсети к аккаунту в настройках профиля, profile-settings.js)
export async function socialToken(provider, label) {
  if (provider === 'google') return googleBrowserLogin(label);
  const loading = dialog({
    title: `Вход через ${label}`,
    content: waitRow(`Завершите вход в окне ${label}.`),
    actions: [{ label: 'Отмена', onClick: () => { window.anixartNative.cancelSocialAuth?.(); } }],
  });
  try {
    const req = await (await fetch(`/social/request?provider=${provider}`)).json();
    if (req.error) throw new Error(req.error);
    req.provider = provider;
    const res = await window.anixartNative.socialAuth(req);
    if (!res || !res.ok) { if (res && res.error && res.error !== 'canceled') toast(res.error); return null; }
    const ex = await (await fetch(`/social/exchange?provider=${provider}`, {
      // verifier (PKCE) остаётся у фронтенда с момента /social/request — серверу он нужен для обмена кода
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...res.params, verifier: req.verifier }),
    })).json();
    if (ex.error) { toast(ex.error); return null; }
    return ex;
  } finally { loading.close(); }
}

async function socialLogin(provider, label) {
  if (provider !== 'google' && !(window.anixartNative && window.anixartNative.socialAuth)) {
    toast('Вход через соцсети доступен только в Anix для Windows');
    return;
  }
  try {
    const ex = await socialToken(provider, label);
    if (!ex) return;
    const r = await socialAuthRequest(provider, ex.field, ex.token);
    if (r.code === 0 && r.profile && r.profileToken) return finishLogin(r);
    // 3 — аккаунта ещё нет: регистрация. Почту подставляем: Яндекс отдаёт её в ответе, Google — Firebase
    if (r.code === 3) return navigate('social-register', { provider, label, field: ex.field, token: ex.token, email: provider === 'yandex' ? (r.email || '') : (ex.email || '') });
    if (r.code === 2) return toast(`${label} не подтвердил вход. Попробуйте ещё раз.`);
    toast(`Не удалось войти через ${label} (код ${r.code ?? '—'})`);
  } catch (e) { toast(netError(e) ? 'Нет связи с сервером Anixart — проверьте интернет и попробуйте ещё раз' : String(e.message || e)); }
}

// Регистрация через соцсеть: никнейм + email → auth/<соцсеть> → код на почту → auth/verify с токеном.
// Коды у Google свои: 8/9 — код отправлен (9 — уже был), 10 почтовый сервис запрещён, 11 слишком много регистраций;
// у VK, Telegram и Яндекса: 8 — код уже был отправлен, 9 почтовый сервис запрещён, 10 слишком много регистраций.
registerScreen('social-register', ({ provider, label, field: tokenField, token, email: emailValue }) => {
  const google = provider === 'google';
  const login = loginField();
  const email = field('Email', 'email');
  if (emailValue) email.input.value = emailValue;
  const btn = h('button', { class: 'btn btn-primary lg block' }, 'Создать профиль');
  btn.onclick = async () => {
    login.setError(''); email.setError('');
    const l = checkLogin(login); const e = checkEmail(email);
    if (!l || !e) return;
    btn.disabled = true;
    try {
      const r = await api.form(`auth/${provider}`, { login: l, email: e, [tokenField]: token }, {}, { withToken: false });
      if (r.code === 0 && r.profile && r.profileToken) return finishLogin(r);
      const sent = google ? [8, 9] : [0, 8];
      const already = google ? 9 : 8;
      if (sent.includes(r.code)) {
        if (r.code === already) toast(TEXT.codeAlreadySent);
        return replace('verify', { login: l, email: e, social: { field: tokenField, token }, hash: r.hash, expires: r.codeTimestampExpires });
      }
      if (r.code === 2) return toast(`${label} не подтвердил вход. Начните заново.`);
      if (r.code === 4) return login.setError(TEXT.loginInvalid);
      if (r.code === 5) return email.setError(TEXT.emailInvalid);
      if (r.code === 6) { login.setError(TEXT.loginTaken); return login.showSuggestions(r.suggested_logins); }
      if (r.code === 7) return email.setError(TEXT.emailTaken);
      if (r.code === (google ? 10 : 9)) return email.setError(TEXT.emailDisallowed);
      if (r.code === (google ? 11 : 10)) return tooManyRegistrations();
      toast(`Не удалось создать профиль (код ${r.code ?? '—'})`);
    } catch (err) { toast(String(err.message || err)); } finally { btn.disabled = false; }
  };
  return wrap('Почти готово', `Осталось придумать никнейм — вход через ${label}`, login, login.suggestions, email, btn);
});

// ---------- Вход ----------

registerScreen('auth', () => {
  const login = field('Почта или никнейм', 'text', { autocomplete: 'username' });
  const pass = field('Пароль', 'password', { autocomplete: 'current-password' });
  const btn = h('button', { class: 'btn btn-primary lg block' }, 'Войти');
  async function submit() {
    login.setError(''); pass.setError('');
    const l = login.input.value.trim(); const p = pass.input.value;
    if (!l) return login.setError('Никнейм или Email не указан');
    if (!p) return pass.setError('Пароль не указан');
    btn.disabled = true;
    try {
      const r = await A.signIn(l, p);
      if (r.code === 0 && r.profile && r.profileToken) return finishLogin(r);
      if (r.code === 2) login.setError(TEXT.profileNotFound);
      else if (r.code === 3) pass.setError('Неверный пароль');
      else toast(`Не удалось войти (код ${r.code ?? '—'})`);
    } catch (e) { toast(String(e.message || e)); } finally { btn.disabled = false; }
  }
  btn.onclick = submit;
  pass.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  const inApp = !!(window.anixartNative && window.anixartNative.socialAuth);
  const socialButtons = SOCIAL.map(([provider, label2, ic]) => h('button', {
    class: 'icon-btn', title: `Войти через ${label2}`, style: { width: '52px', height: '52px', border: '1px solid var(--sep)' },
    onclick: () => socialLogin(provider, label2),
  }, h('img', { src: `/icons/${ic}.svg`, style: { width: '24px', height: '24px' }, alt: label2 })));
  const socialTitle = h('div', { class: 'muted', style: { textAlign: 'center', marginTop: '14px', fontSize: '13px' } }, 'Войти с помощью');
  const socialRow = h('div', { class: 'row', style: { justifyContent: 'center', gap: '12px', margin: '18px 0 4px' } }, socialButtons);
  const socialNote = inApp ? null : h('div', { class: 'muted3', style: { fontSize: '12px', textAlign: 'center', marginTop: '6px' } }, 'Яндекс, ВКонтакте и Telegram — в Anix для Windows');
  // Без ключей провайдера (config.local.json) его кнопка скрыта; без всех — весь блок.
  // В браузере работает только Google (через системный браузер), остальным нужно окно Electron.
  fetch('/__features').then((r) => r.json()).then((f) => {
    SOCIAL.forEach(([provider], i) => { if (!f.social[provider] || (!inApp && provider !== 'google')) socialButtons[i].remove(); });
    if (!socialRow.children.length) [socialTitle, socialRow, socialNote].forEach((el) => el && el.remove());
  }).catch(() => {});
  return wrap('С возвращением', 'Войдите в аккаунт Anixart', login, pass, btn,
    h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '16px' } },
      h('button', { class: 'btn btn-text', onclick: () => navigate('restore') }, 'Забыли пароль? Восстановить'),
      h('button', { class: 'btn btn-text', onclick: () => navigate('signup') }, 'Регистрация')),
    socialTitle, socialRow, socialNote);
});

// ---------- Регистрация ----------

registerScreen('signup', () => {
  const login = loginField(); const email = field('Email', 'email'); const pass = field('Пароль', 'password'); const pass2 = field('Повторите пароль', 'password');
  const terms = h('input', { type: 'checkbox' });
  const btn = h('button', { class: 'btn btn-primary lg block' }, 'Создать профиль');
  btn.onclick = async () => {
    [login, email, pass, pass2].forEach((f) => f.setError(''));
    const l = checkLogin(login); const e = checkEmail(email); const p = checkPassword(pass, pass2);
    if (!l || !e || !p) return;
    if (!terms.checked) return toast('Чтобы создать профиль, примите пользовательское соглашение.');
    btn.disabled = true;
    try {
      const r = await A.signUp(l, e, p);
      if (r.code === 0 || r.code === 7) {
        if (r.code === 7) toast(TEXT.codeAlreadySent);
        return navigate('verify', { login: l, email: e, password: p, hash: r.hash, expires: r.codeTimestampExpires });
      }
      if (r.code === 2) return login.setError(TEXT.loginInvalid);
      if (r.code === 3) return email.setError(TEXT.emailInvalid);
      if (r.code === 4) return pass.setError(TEXT.passwordInvalid);
      if (r.code === 5) { login.setError(TEXT.loginTaken); return login.showSuggestions(r.suggested_logins); }
      if (r.code === 6) return email.setError(TEXT.emailTaken);
      if (r.code === 8) return dialog({ title: 'Ошибка', content: h('p', null, TEXT.codeCannotSend), actions: [{ label: 'OK', primary: true }] });
      if (r.code === 9) return email.setError(TEXT.emailDisallowed);
      if (r.code === 10) return tooManyRegistrations();
      toast(`Не удалось создать профиль (код ${r.code ?? '—'})`);
    } catch (er) { toast(String(er.message || er)); } finally { btn.disabled = false; }
  };
  return wrap('Создать профиль', 'Аккаунт Anixart — займёт меньше минуты', login, login.suggestions, email, pass, pass2,
    h('label', { class: 'row', style: { margin: '4px 0 16px', alignItems: 'flex-start' } }, terms, h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Я принимаю пользовательское соглашение и политику конфиденциальности Anixart')),
    btn, h('button', { class: 'btn btn-text', style: { marginTop: '12px' }, onclick: () => history.back() }, 'Уже есть профиль? Войти'));
});

// ---------- Ввод кода из письма ----------

function codeScreen(title, text, onVerify, onResend, expires) {
  const code = field('Код из письма', 'text', { inputmode: 'numeric', maxlength: 4, style: { letterSpacing: '10px', fontSize: '22px', textAlign: 'center' } });
  const btn = h('button', { class: 'btn btn-primary lg block' }, 'Подтвердить');
  const resend = h('button', { class: 'btn btn-text', style: { marginTop: '12px' } }, 'Не получили код? Отправить ещё раз');
  let until = expires || 0;
  const tick = () => {
    const left = Math.ceil(until - Date.now() / 1000);
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? `Отправить ещё раз через ${left} c` : 'Не получили код? Отправить ещё раз';
    if (left > 0) setTimeout(tick, 1000);
  };
  tick();
  const submit = async () => {
    code.setError('');
    const v = code.input.value.trim();
    if (!v) return code.setError(TEXT.codeInvalid);
    btn.disabled = true;
    try { await onVerify(v, code); } catch (e) { toast(String(e.message || e)); } finally { btn.disabled = false; }
  };
  btn.onclick = submit;
  code.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  resend.onclick = async () => {
    resend.disabled = true;
    try { const exp = await onResend(); if (exp) until = exp; } catch (e) { toast(String(e.message || e)); }
    tick();
  };
  return wrap(title, text, code, btn, resend, h('div', { class: 'muted', style: { fontSize: '12px', textAlign: 'center', marginTop: '10px' } }, 'Код всё ещё не приходит? Проверьте папку «Спам»'));
}

// Подтверждение почты при регистрации: обычной (password) или через соцсеть (social: { field, token })
registerScreen('verify', ({ login, email, password, social, hash, expires }) => {
  const base = { login, email, password: social ? null : password, ...(social ? { [social.field]: social.token } : {}), hash };
  return codeScreen('Подтвердите почту', `Anixart отправил код на ${email}`,
    async (code, f) => {
      const r = await A.verify({ ...base, code });
      if (r.code === 0 && r.profile && r.profileToken) return finishLogin(r);
      const msg = {
        2: TEXT.loginInvalid, 3: TEXT.emailInvalid, 4: TEXT.passwordInvalid, 5: TEXT.loginTaken, 6: TEXT.emailTaken,
        7: TEXT.codeInvalid, 8: TEXT.codeExpired, 9: TEXT.hashInvalid, 10: TEXT.emailDisallowed,
      }[r.code];
      if (r.code === 11) return tooManyRegistrations();
      f.setError(msg || `Не удалось подтвердить (код ${r.code ?? '—'})`);
    },
    async () => {
      const r = await A.resend(base);
      if (r.code === 0) { toast(TEXT.codeResent); return r.timestampExpires; }
      toast(r.code === 6 ? TEXT.codeStillActual : `Не удалось отправить код (код ${r.code ?? '—'})`);
      return null;
    }, expires);
});

// ---------- Восстановление пароля ----------

registerScreen('restore', () => {
  const data = field('Почта или никнейм'); const p1 = field('Новый пароль', 'password'); const p2 = field('Повторите пароль', 'password');
  const btn = h('button', { class: 'btn btn-primary lg block' }, 'Продолжить');
  btn.onclick = async () => {
    [data, p1, p2].forEach((f) => f.setError(''));
    const d = data.input.value.trim();
    if (!d) { data.setError('Никнейм или Email не указан'); }
    const p = checkPassword(p1, p2);
    if (!d || !p) return;
    btn.disabled = true;
    try {
      const r = await A.restore(d);
      if (r.code === 0 || r.code === 3) {
        if (r.code === 3) toast(TEXT.codeAlreadySent);
        return replace('restore-verify', { data: d, password: p, hash: r.hash, expires: r.codeTimestampExpires });
      }
      if (r.code === 2) return data.setError(TEXT.profileNotFound);
      if (r.code === 4) return dialog({ title: 'Ошибка', content: h('p', null, TEXT.codeCannotSend), actions: [{ label: 'OK', primary: true }] });
      toast(`Не удалось восстановить пароль (код ${r.code ?? '—'})`);
    } catch (e) { toast(String(e.message || e)); } finally { btn.disabled = false; }
  };
  return wrap('Забыли пароль?', 'Укажите никнейм или почту профиля Anixart и придумайте новый пароль', data, p1, p2, btn);
});

registerScreen('restore-verify', ({ data, password, hash, expires }) => codeScreen('Подтвердите почту', `Anixart отправил код на почту профиля ${data}`,
  async (code, f) => {
    const r = await A.restoreVerify({ data, password, hash, code });
    if (r.code === 0 && r.profile && r.profileToken) return finishLogin(r);
    const msg = { 2: TEXT.profileNotFound, 3: TEXT.passwordInvalid, 4: TEXT.codeInvalid, 5: TEXT.codeExpired, 6: TEXT.hashInvalid }[r.code];
    f.setError(msg || `Не удалось подтвердить (код ${r.code ?? '—'})`);
  },
  async () => {
    const r = await A.restoreResend({ data, password, hash });
    if (r.code === 0) { toast(TEXT.codeResent); return r.timestampExpires; }
    toast(r.code === 4 ? TEXT.codeStillActual : `Не удалось отправить код (код ${r.code ?? '—'})`);
    return null;
  }, expires));
