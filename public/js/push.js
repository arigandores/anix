// Уведомления Anixart на телефоне (Android: MainActivity, NotifyJob.kt — фоновая проверка раз в ~30 мин). Включены,
// пока вошли в аккаунт, есть разрешение Android и не выключены в настройках приложения («Уведомления на телефоне»).
// Разрешение спрашиваем не при запуске, а когда понятно зачем: после входа и при открытии «Уведомлений»; выключены —
// плашка на экране уведомлений (как в Anixart). На ПК — нет (anixartNative.notify только в shim.js)
import { auth } from './api.js';
import { prefs } from './store.js';

const LAST = 'anix.notify.last'; // время самого нового присланного (android/web/background.js)
const native = () => window.anixartNative?.notify;

export const pushSupported = () => !!native();
// granted | ask | denied (отказали насовсем — только в настройках Android) | off (выключены в настройках Android)
export const pushPermission = () => native()?.permission() || 'off';
export const pushOn = () => pushSupported() && auth.loggedIn && !!prefs.get('PHONE_NOTIFY') && pushPermission() === 'granted';

export function syncPush() {
  if (!pushSupported()) return;
  const on = pushOn();
  // включили — присылаем то, что придёт с этого момента, а не накопившееся непрочитанное
  try { if (on && !localStorage.getItem(LAST)) localStorage.setItem(LAST, String(Math.floor(Date.now() / 1000))); else if (!on) localStorage.removeItem(LAST); } catch { /* storage */ }
  native().set(on);
}

// спросить разрешение (если ещё можно) и включить; true — включены
export async function askPush() {
  if (!pushSupported() || !auth.loggedIn) return false;
  if (pushPermission() === 'ask') await native().request();
  syncPush();
  return pushOn();
}

export function initPush() {
  if (!pushSupported()) return;
  syncPush();
  window.addEventListener('auth-changed', () => { if (auth.loggedIn) askPush(); else syncPush(); });
}

export const openPushSettings = () => native()?.openSettings();
