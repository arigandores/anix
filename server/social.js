'use strict';
// Вход через соцсети:
//   Google   — Firebase: id_token Google → Firebase signInWithIdp → Firebase idToken (googleIdToken)
//   Telegram — PKCE, oauth.telegram.org/auth → code → /token → id_token (telegramIdToken)
//   VK       — VK ID: PKCE, id.vk.ru/authorize → code → /oauth2/auth → access_token
//   Yandex   — oauth.yandex.ru/authorize response_type=token → access_token из фрагмента
// Клиентские идентификаторы — из конфига (server/config.js); без них провайдер недоступен.
const crypto = require('crypto');
const config = require('./config');

const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

const GOOGLE = {
  apiKey: config.get('social.google.apiKey'),
  authHandler: config.get('social.google.authHandler'),
};
const TELEGRAM = {
  clientId: config.get('social.telegram.clientId'),
  redirectUri: config.get('social.telegram.redirectUri'),
  redirectHost: hostOf(config.get('social.telegram.redirectUri')),
  scope: 'openid profile',
};
const vkId = config.get('social.vk.clientId');
const VK = {
  clientId: vkId,
  redirectUri: `vk${vkId}://vk.ru/blank.html`,
  scheme: `vk${vkId}`,
  scope: 'email',
};
const yandexId = config.get('social.yandex.clientId');
const YANDEX = {
  clientId: yandexId,
  redirectUri: `https://yx${yandexId}.oauth.yandex.ru/auth/finish?platform=android`,
  redirectHost: `yx${yandexId}.oauth.yandex.ru`,
};

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// Параметры окна авторизации для каждого провайдера
function authRequest(provider) {
  if (!(config.features().social || {})[provider]) throw new Error('Вход через этот сервис недоступен в этой сборке');
  const state = b64url(crypto.randomBytes(16));
  if (provider === 'google') {
    // url и sessionId заполняются в googleAuthUri(); redirect — Firebase auth handler
    return { kind: 'google-pre', continueUri: GOOGLE.authHandler, redirectHost: hostOf(GOOGLE.authHandler) };
  }
  if (provider === 'telegram') {
    const { verifier, challenge } = pkce();
    const url = `https://oauth.telegram.org/auth?client_id=${TELEGRAM.clientId}&response_type=code`
      + `&scope=${encodeURIComponent(TELEGRAM.scope)}&redirect_uri=${encodeURIComponent(TELEGRAM.redirectUri)}`
      + `&code_challenge=${challenge}&code_challenge_method=S256`;
    return { url, redirectHost: TELEGRAM.redirectHost, redirectPrefix: TELEGRAM.redirectUri, verifier, state };
  }
  if (provider === 'vk') {
    const { verifier, challenge } = pkce();
    const url = `https://id.vk.ru/authorize?client_id=${VK.clientId}&response_type=code`
      + `&redirect_uri=${encodeURIComponent(VK.redirectUri)}&code_challenge_method=s256&code_challenge=${challenge}`
      + `&state=${state}&scope=${encodeURIComponent(VK.scope)}&prompt=login&sdk_type=vkid`;
    return { url, redirectScheme: VK.scheme, redirectPrefix: VK.redirectUri, verifier, state };
  }
  if (provider === 'yandex') {
    const url = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${YANDEX.clientId}`
      + `&redirect_uri=${encodeURIComponent(YANDEX.redirectUri)}&state=${state}&force_confirm=true`;
    return { url, redirectHost: YANDEX.redirectHost, tokenInFragment: true, state };
  }
  throw new Error('unknown provider');
}

async function postForm(url, form, headers = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = {}; }
  return { status: r.status, json, text };
}

// Обмен перехваченного редиректа на токен для бекенда Anixart
async function exchange(provider, params) {
  if (provider === 'telegram') {
    const { status, json, text } = await postForm('https://oauth.telegram.org/token', {
      grant_type: 'authorization_code', client_id: TELEGRAM.clientId, code: params.code,
      redirect_uri: TELEGRAM.redirectUri, code_verifier: params.verifier,
    });
    const token = json.id_token || json.result;
    if (!token) throw new Error(`Telegram: нет id_token (HTTP ${status}): ${text.slice(0, 150)}`);
    return { field: 'telegramIdToken', token };
  }
  if (provider === 'vk') {
    const { status, json, text } = await postForm('https://id.vk.ru/oauth2/auth', {
      grant_type: 'authorization_code', code: params.code, code_verifier: params.verifier,
      client_id: VK.clientId, device_id: params.device_id, redirect_uri: VK.redirectUri, state: params.state,
    });
    if (!json.access_token) throw new Error(`VK: нет access_token (HTTP ${status}): ${text.slice(0, 150)}`);
    return { field: 'vkAccessToken', token: json.access_token };
  }
  if (provider === 'yandex') {
    if (!params.access_token) throw new Error('Yandex: нет access_token');
    return { field: 'yandexAccessToken', token: params.access_token };
  }
  if (provider === 'google') {
    // id_token Google → Firebase signInWithIdp → Firebase idToken (googleIdToken для auth/google).
    // sessionId из createAuthUri обязателен: по нему Firebase сверяет nonce в id_token.
    const body = { requestUri: params.requestUri || GOOGLE.authHandler, returnIdpCredential: true, returnSecureToken: true };
    if (params.sessionId) body.sessionId = params.sessionId;
    else body.postBody = `id_token=${params.id_token}&providerId=google.com`;
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${GOOGLE.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = {}; }
    if (!json.idToken) {
      const msg = (json.error && json.error.message) || text.slice(0, 150);
      throw new Error(`Google: Firebase не вернул idToken (HTTP ${r.status}): ${msg}`);
    }
    return { field: 'googleIdToken', token: json.idToken, email: json.email || '' };
  }
  throw new Error('unknown provider');
}

// Google: createAuthUri → authUri (для окна) и sessionId (для проверки nonce при обмене)
async function googleAuthUri() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${GOOGLE.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'google.com', continueUri: GOOGLE.authHandler }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  return { url: j.authUri, sessionId: j.sessionId };
}

module.exports = { authRequest, exchange, googleAuthUri, GOOGLE };
