// Статус «Смотрит <тайтл>» в Discord: окно собирает activity, локальный сервер шлёт её в Discord на этом компьютере
// (server/discord.js) — и в приложении, и в браузере. Во встроенном плеере — с полосой времени серии (начало и конец
// по часам, с учётом скорости), на паузе — «На паузе»; в веб-плеере — сколько смотрим. Пока статус показан, окно
// подтверждает его раз в минуту: закрыли вкладку, не убрав статус, — сервер уберёт его сам.
// Включается в настройках (DISCORD_PRESENCE), по умолчанию выключено.
import { prefs } from './store.js';
import { has } from './platform.js';

const KEEP_MS = 60000;
let shown = null; let keep = 0;
const on = () => has.discord && prefs.get('DISCORD_PRESENCE') === true;

function post(activity) {
  fetch('/discord/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(activity), keepalive: true }).catch(() => {});
}
function send(activity) {
  shown = activity; post(activity);
  clearInterval(keep);
  if (activity) keep = setInterval(() => post(shown), KEEP_MS);
}
export function clearPresence() { if (shown) send(null); } // выключено и ничего не показано — к серверу не обращаемся
// вкладку закрыли — статус убираем сразу
addEventListener('pagehide', () => { if (shown) navigator.sendBeacon('/discord/presence', new Blob(['null'], { type: 'application/json' })); });

export async function discordStatus() {
  try { return await (await fetch('/discord/status')).json(); } catch { return { configured: false }; }
}

function activity({ release, ep, dub, video, since }) {
  const title = release.title_ru || release.title_original || 'Аниме';
  const epName = ep ? ep.name || `${ep.position} серия` : '';
  const paused = video && video.paused;
  const a = {
    type: 3, // «Смотрит»
    status_display_type: 2, // в списке участников — «Смотрит <тайтл>», а не название приложения
    details: title,
    state: [paused ? 'На паузе' : null, epName, dub].filter(Boolean).join(' · ') || undefined,
    assets: {
      large_image: /^https:\/\//.test(release.image || '') ? release.image : undefined,
      large_text: release.title_original && release.title_original !== title ? release.title_original : title,
    },
  };
  const d = video && video.duration; const rate = (video && video.playbackRate) || 1;
  if (video && !paused && d > 0 && isFinite(d)) {
    const start = Date.now() - (video.currentTime / rate) * 1000;
    a.timestamps = { start, end: start + (d / rate) * 1000 };
  } else if (!video && since) a.timestamps = { start: since };
  if (release.id) {
    const base = (window.__toggles && window.__toggles.baseUrl) || 'https://anixart-app.com/';
    a.buttons = [{ label: 'Открыть в Anixart', url: `${base}release/${release.id}` }];
  }
  return a;
}

// Встроенный плеер: статус по событиям <video>; episode(ep) — при смене серии, stop() — при закрытии
export function playerPresence(opts) {
  let { release, dub } = opts; const { video } = opts; // тайтл меняется, когда в том же плеере включают другое аниме
  let ep = null;
  const update = () => { if (on() && ep) send(activity({ release, ep, dub, video })); };
  const evs = ['play', 'pause', 'seeked', 'ratechange', 'durationchange'];
  for (const e of evs) video.addEventListener(e, update);
  return {
    episode(x) { ep = x; update(); },
    setRelease(r, d) { release = r; dub = d; },
    stop() { for (const e of evs) video.removeEventListener(e, update); clearPresence(); },
  };
}

// Веб-плеер (iframe): времени серии не видно — показываем, сколько уже смотрим
export function webPresence({ release, ep, dub }) {
  if (on()) send(activity({ release, ep, dub, since: Date.now() }));
  return { stop() { clearPresence(); } };
}
