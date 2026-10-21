// Где запущено приложение: Windows (Electron) / браузер или Android (android/: WebView, мост window.anixAndroid).
// На Android нет улучшения картинки, AI-помощника, статуса в Discord и стороннего плеера (mpv/VLC) — пункты и вкладки
// для них не показываются
export const ANDROID = !!window.anixAndroid;

export const has = {
  upscale: !ANDROID,
  ai: !ANDROID,
  discord: !ANDROID,
  externalPlayer: !ANDROID,
};

// Название приложения в «О приложении» и подсказках
export const APP_NAME = ANDROID ? 'Anix' : 'Anix Desktop';

// Палец, а не мышь (телефон, сенсорный экран): поле в выпадающем меню не получает фокус само — иначе
// клавиатура закрывает половину экрана вместе со списком
export const touch = matchMedia('(pointer: coarse)').matches;

// Ссылка, которой открыли приложение (приглашение anixdesktop://, ссылка на Anixart): мост отдаёт её один раз —
// читаем один раз на всех (party/ui.js, links.js)
let launch = null;
export const launchLink = () => (launch ??= Promise.resolve(window.anixartNative?.pendingDeepLink?.() ?? null).catch(() => null));

// Отклик вибрацией (телефон, как в Anixart): 'long' — открылось меню по долгому нажатию, 'tap' — голос, оценка
export const haptic = (kind = 'tap') => window.anixartNative?.haptic?.(kind);
