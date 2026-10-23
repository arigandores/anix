// Где запущено приложение: Windows (Electron) / браузер или Android (android/: WebView, мост window.anixAndroid).
// На Android нет AI-помощника, статуса в Discord, стороннего плеера (mpv/VLC) и апскейла с ПК (upscale/: на мобильной
// видеокарте его WebGPU-движок медленный) — пункты и вкладки для них не показываются. Улучшение картинки на телефоне —
// своё: резкость (sharpen.js) и нейросеть Anime4K фрагментными шейдерами (anime4k-gl.js), если телефон её тянет
// (upscale/phone-check.js)
export const ANDROID = !!window.anixAndroid;

export const has = {
  upscale: !ANDROID,
  ai: !ANDROID,
  discord: !ANDROID,
  externalPlayer: !ANDROID,
  sharpen: ANDROID, // улучшение картинки на телефоне: резкость и Anime4K (player.js)
};

// Название приложения в «О приложении» и подсказках
export const APP_NAME = 'Anix';

// Палец, а не мышь (телефон, сенсорный экран): поле в выпадающем меню не получает фокус само — иначе
// клавиатура закрывает половину экрана вместе со списком
export const touch = matchMedia('(pointer: coarse)').matches;

// Ссылка, которой открыли приложение (приглашение anixdesktop://, ссылка на Anixart): мост отдаёт её один раз —
// читаем один раз на всех (party/ui.js, links.js)
let launch = null;
export const launchLink = () => (launch ??= Promise.resolve(window.anixartNative?.pendingDeepLink?.() ?? null).catch(() => null));

// Отклик вибрацией (телефон, как в Anixart): 'long' — открылось меню по долгому нажатию, 'tap' — голос, оценка
export const haptic = (kind = 'tap') => window.anixartNative?.haptic?.(kind);
