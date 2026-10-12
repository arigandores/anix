// Вход, регистрация, подтверждение, восстановление (form-urlencoded) + соцвход
import { h, icon, toast, dialog, spinner } from '../ui.js';
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

// Полный flow соцвхода: окно Electron → обмен токена на сервере → auth/<provider>.
// NOT_REGISTERED (код 3) → экран «Почти готово»: никнейм + email, затем тот же endpoint с регистрацией.
async function socialLogin(provider, label) {
  if (!(window.anixartNative && window.anixartNative.socialAuth)) {
    toast('Вход через соцсети доступен только в Anix Desktop для Windows');
    return;
  }
  const loading = dialog({ title: `Вход через ${label}`, content: spinner() });
  try {
    const req = await (await fetch(`/social/request?provider=${provider}`)).json();
    if (req.error) throw new Error(req.error);
    req.provider = provider;
    const res = await window.anixartNative.socialAuth(req);
    if (!res || !res.ok) { loading.close(); if (res && res.error && res.error !== 'canceled') toast(res.error); return; }
    const exchangeParams = { ...res.params };
    if (req.sessionId) exchangeParams.sessionId = req.sessionId; // Google: nonce проверяется по sessionId
    const ex = await (await fetch(`/social/exchange?provider=${provider}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exchangeParams),
    })).json();
    loading.close();
    if (ex.error) { toast(ex.error); return; }
    const r = await api.form(`auth/${provider}`, { [ex.field]: ex.token }, {}, { withToken: false });
    if (r.code === 0 && r.profileToken) return finishLogin(r);
    if (r.code === 3) { socialRegister(provider, label, ex); return; }
    toast(socialError(r.code));
  } catch (e) { loading.close(); toast(String(e.message || e)); }
}

function socialError(code) {
  return ({ 2: 'Что-то пошло не так, попробуйте позже', 6: 'Никнейм уже занят', 7: 'Email уже занят', 4: 'Неверный никнейм', 5: 'Неверный Email' })[code] || t('error_load');
}

function socialRegister(provider, label, ex) {
  const login = field('Никнейм');
  const email = field('Email', 'email');
  if (ex.email) email.input.value = ex.email;
  const btn = h('button', { class: 'btn btn-primary lg block' }, 'Создать профиль');
  btn.onclick = async () => {
    login.setError(''); email.setError('');
    const l = login.input.value.trim(); const e = email.input.value.trim();
    if (l.length < 3) return login.setError('Никнейм слишком короткий');
    if (!e) return email.setError('Email не указан');
    btn.disabled = true;
    try {
      const r = await api.form(`auth/${provider}`, { login: l, email: e, [ex.field]: ex.token }, {}, { withToken: false });
      if (r.code === 0 && r.profileToken) return finishLogin(r);
      if ((r.code === 8 || r.code === 9) && r.hash) return replace('verify', { login: l, email: e, password: '', hash: r.hash, expires: r.codeTimestampExpires, socialProvider: provider, socialField: ex.field, socialToken: ex.token });
      if (r.code === 6) { login.setError('Никнейм уже занят'); return; }
      if (r.code === 7) { email.setError('Email уже занят'); return; }
      toast(socialError(r.code));
    } finally { btn.disabled = false; }
  };
  replace('social-register', { label, login, email, btn });
}

registerScreen('social-register', ({ label, login, email, btn }) => wrap('Почти готово', `Осталось придумать никнейм — вход через ${label}`, login, email, btn));

function field(label, type = 'text', attrs = {}) {
  const input = h('input', { class: 'input', type, ...attrs });
  const err = h('div', { class: 'err-text' });
  const wrap = h('div', { class: 'field' }, h('label', null, label), input, err);
  wrap.input = input; wrap.setError = (m) => { err.textContent = m || ''; };
  return wrap;
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

registerScreen('auth', () => {
  const login = field('Почта или никнейм', 'text', { autocomplete: 'username' });
  const pass = field('Пароль', 'password', { autocomplete: 'current-password' });
  const btn = h('button', { class: 'btn btn-primary lg block' }, 'Войти');
  async function submit() {
    login.setError(''); pass.setError('');
    const l = login.input.value.trim(); const p = pass.input.value;
    if (!l) return login.setError('Никнейм или Email не указан');
    if (!p) return pass.setError('Пароль не указан');
    if (p.length > 32) return pass.setError('Пароль слишком длинный');
    if (p.length < 6) return pass.setError('Пароль слишком короткий');
    btn.disabled = true;
    try {
      const r = await A.signIn(l, p);
      if (r.code === 0 && r.profile && r.profileToken) return finishLogin(r);
      if (r.code === 2) login.setError('Пользователь не найден');
      else if (r.code === 3) pass.setError('Неверный пароль');
      else toast(t('error_load'));
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
  const socialNote = inApp ? null : h('div', { class: 'muted3', style: { fontSize: '12px', textAlign: 'center', marginTop: '6px' } }, 'Вход через соцсети доступен в Anix Desktop для Windows');
  // Без ключей провайдера (config.local.json) его кнопка скрыта; без всех — весь блок
  fetch('/__features').then((r) => r.json()).then((f) => {
    SOCIAL.forEach(([provider], i) => { if (!f.social[provider]) socialButtons[i].remove(); });
    if (!socialRow.children.length) [socialTitle, socialRow, socialNote].forEach((el) => el && el.remove());
  }).catch(() => {});
  return wrap('С возвращением', 'Войдите, чтобы продолжить', login, pass, btn,
    h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '16px' } },
      h('button', { class: 'btn btn-text', onclick: () => navigate('restore') }, 'Забыли пароль? Восстановить'),
      h('button', { class: 'btn btn-text', onclick: () => navigate('signup') }, 'Регистрация')),
    socialTitle, socialRow, socialNote);
});

registerScreen('signup', () => {
  const login = field('Никнейм'); const email = field('Email', 'email'); const pass = field('Пароль', 'password'); const pass2 = field('Повторите пароль', 'password');
  const terms = h('input', { type: 'checkbox' });
  const sugg = h('div', { class: 'chips', style: { marginTop: '-6px', marginBottom: '10px' } });
  let timer;
  login.input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const v = login.input.value.trim(); if (v.length < 3) return;
      try {
        const { api } = await import('../api.js');
        const r = await api.form('auth/checkLogin', { login: v }, {}, { withToken: false });
        if (r.code === 0 && r.available !== false) { login.setError(''); sugg.replaceChildren(h('span', { style: { color: 'var(--green)', fontSize: '13px' } }, 'Никнейм свободен')); }
        else { login.setError('Никнейм уже занят'); showSugg(r.suggested_logins); }
      } catch { /* ignore */ }
    }, 500);
  });
  function showSugg(list) { sugg.replaceChildren(...(list || []).map((s) => h('button', { class: 'chip', onclick: () => { login.input.value = s; login.setError(''); } }, s))); }
  const btn = h('button', { class: 'btn btn-primary lg block' }, 'Создать профиль');
  btn.onclick = async () => {
    [login, email, pass, pass2].forEach((f) => f.setError(''));
    const l = login.input.value.trim(); const e = email.input.value.trim(); const p = pass.input.value;
    if (!l) return login.setError('Никнейм не указан');
    if (l.length < 3) return login.setError('Никнейм слишком короткий');
    if (l.length > 20) return login.setError('Никнейм слишком длинный');
    if (!e) return email.setError('Email не указан');
    if (p.length < 6 || p.length > 32) return pass.setError('Пароль слишком короткий');
    if (p !== pass2.input.value) return pass2.setError('Пароль не совпадает');
    if (!terms.checked) return toast('Чтобы создать профиль, примите пользовательское соглашение.');
    btn.disabled = true;
    try {
      const r = await A.signUp(l, e, p);
      const go = () => navigate('verify', { login: l, email: e, password: p, hash: r.hash, expires: r.codeTimestampExpires });
      if (r.code === 0) return go();
      if (r.code === 7) { dialog({ title: 'Предупреждение', content: h('p', null, 'Код уже отправлен.'), actions: [{ label: 'OK', primary: true, onClick: go }] }); return; }
      const map = { 2: [login, 'Никнейм слишком короткий'], 3: [email, 'Неверный Email'], 4: [pass, 'Пароль слишком короткий'], 5: [login, 'Никнейм уже занят'], 6: [email, 'Email уже занят'], 9: [email, 'Регистрация через данный Email невозможна'] };
      if (map[r.code]) { map[r.code][0].setError(map[r.code][1]); if (r.code === 5) showSugg(r.suggested_logins); return; }
      if (r.code === 8) dialog({ title: 'Ошибка', content: h('p', null, 'Код не может быть отправлен. Повторите попытку позднее.'), actions: [{ label: 'OK', primary: true }] });
      else if (r.code === 10) dialog({ title: 'Ошибка', content: h('p', { style: { whiteSpace: 'pre-line' } }, t('error_too_many_registrations')), actions: [{ label: 'OK', primary: true }] });
      else toast(t('error_load'));
    } catch (er) { toast(String(er.message || er)); } finally { btn.disabled = false; }
  };
  return wrap('Создать профиль', 'Это займёт меньше минуты', login, sugg, email, pass, pass2,
    h('label', { class: 'row', style: { margin: '4px 0 16px', alignItems: 'flex-start' } }, terms, h('span', { class: 'muted', style: { fontSize: '13px' } }, 'Я принимаю пользовательское соглашение и политику конфиденциальности')),
    btn, h('button', { class: 'btn btn-text', style: { marginTop: '12px' }, onclick: () => history.back() }, 'Уже есть профиль? Войти'));
});

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
  btn.onclick = async () => { code.setError(''); const v = code.input.value.trim(); if (v.length !== 4) return code.setError('Неверный код.'); btn.disabled = true; try { await onVerify(v, code); } finally { btn.disabled = false; } };
  resend.onclick = async () => { const exp = await onResend(); if (exp) { until = exp; tick(); } };
  return wrap(title, text, code, btn, resend, h('div', { class: 'muted', style: { fontSize: '12px', textAlign: 'center', marginTop: '10px' } }, 'Код всё ещё не приходит? Проверьте папку «Спам»'));
}

registerScreen('verify', ({ login, email, password, hash, expires, socialProvider, socialField, socialToken }) => codeScreen('Подтвердите почту', `Мы отправили код на ${email}`,
  async (code, f) => {
    const r = socialProvider
      ? await api.form(`auth/${socialProvider}`, { login, email, [socialField]: socialToken, hash, code }, {}, { withToken: false })
      : await A.verify({ login, email, password, hash, code });
    if (r.code === 0 && r.profileToken) return finishLogin(r);
    f.setError({ 7: 'Неверный код.', 8: 'Код более не действителен.', 9: 'Неверный hash.', 5: 'Никнейм уже занят', 6: 'Email уже занят' }[r.code] || t('error_load'));
  },
  async () => {
    const r = await A.resend({ login, email, password, hash });
    if (r.code === 0) { toast('Новый код был успешно отправлен.'); return r.timestampExpires; }
    toast(t('error_load')); return null;
  }, expires));

registerScreen('restore', () => {
  const data = field('Почта или никнейм'); const p1 = field('Новый пароль', 'password'); const p2 = field('Повторите пароль', 'password');
  const btn = h('button', { class: 'btn btn-primary lg block' }, 'Продолжить');
  btn.onclick = async () => {
    [data, p1, p2].forEach((f) => f.setError(''));
    const d = data.input.value.trim(); const p = p1.input.value;
    if (!d) return data.setError('Никнейм или Email не указан');
    if (p.length < 6) return p1.setError('Пароль слишком короткий');
    if (p.length > 32) return p1.setError('Пароль слишком длинный');
    if (p !== p2.input.value) return p2.setError('Пароль не совпадает');
    btn.disabled = true;
    try {
      const r = await A.restore(d);
      const go = () => replace('restore-verify', { data: d, password: p, hash: r.hash, expires: r.codeTimestampExpires });
      if (r.code === 0) return go();
      if (r.code === 3) { dialog({ title: 'Предупреждение', content: h('p', null, 'Код уже отправлен.'), actions: [{ label: 'OK', primary: true, onClick: go }] }); return; }
      if (r.code === 2) data.setError('Профиль с указанным именем или Email не найден');
      else toast('Код не может быть отправлен. Повторите попытку позднее.');
    } finally { btn.disabled = false; }
  };
  return wrap('Забыли пароль?', 'Укажите никнейм или почту, к которой привязан ваш профиль', data, p1, p2, btn);
});

registerScreen('restore-verify', ({ data, password, hash, expires }) => codeScreen('Подтвердите почту', `Мы отправили код на почту, привязанную к профилю ${data}`,
  async (code, f) => {
    const r = await A.restoreVerify({ data, password, hash, code });
    if (r.code === 0 && r.profileToken) return finishLogin(r);
    f.setError({ 2: 'Профиль с указанным именем или Email не найден', 3: 'Пароль слишком короткий', 4: 'Неверный код.', 5: 'Код более не действителен.', 6: 'Неверный hash.' }[r.code] || t('error_load'));
  },
  async () => {
    const r = await A.restoreResend({ data, password, hash });
    if (r.code === 0) { toast('Новый код был успешно отправлен.'); return r.codeTimestampExpires || r.timestampExpires; }
    toast(t('error_load')); return null;
  }, expires));
