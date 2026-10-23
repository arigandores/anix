// Настройки: разделы в боковом меню (на узком окне — полоса сверху), справа — пункты выбранного раздела
import { h, icon, toast, sheet, prompt, confirmDialog, dialog, nudge, swipePages } from '../ui.js';
import { A, auth } from '../api.js';
import { t, prefs, theme, setTheme } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { backToolbar } from './common.js';
import { homeTabTitles } from './home.js';
import { exportBookmarks, importBookmarks } from './bookmarks-data.js';
import { AI_MODELS, AI_EFFORTS } from './ai.js';
import { SPEEDS, speedName } from '../player.js';
import { trtStatus, trtInstall, benchRunDialog, benchResultsDialog, benchInfo, SHARPNESS, SHARP_LABEL } from '../upscale/index.js';
import { AUDIO_OPTS } from '../audio.js';
import { clearPresence, discordStatus } from '../discord.js';
import { canUpdate, checkUpdate, lastCheck, updateDialog, whatsNewDialog, releaseNotes } from '../update.js';
import { has, APP_NAME, touch, ANDROID } from '../platform.js';
import { neuralOk } from '../upscale/phone-check.js';

function item(ic, title, sub, onClick) {
  return h('div', { class: 'menu-item', onclick: onClick }, icon(ic), h('div', { class: 'grow' }, h('div', null, title), sub ? h('div', { class: 'sub' }, sub) : null));
}
// Переключатель: key — настройка-флаг или { get, set } для настроек с другими значениями
function toggle(ic, title, sub, key, onChange) {
  const { get, set } = typeof key === 'string' ? { get: () => !!prefs.get(key), set: (v) => prefs.set(key, v) } : key;
  const cb = h('input', { type: 'checkbox' }); cb.checked = get();
  cb.onchange = () => { set(cb.checked); onChange && onChange(cb.checked); };
  return h('label', { class: 'menu-item' }, icon(ic), h('div', { class: 'grow' }, h('div', null, title), sub ? h('div', { class: 'sub' }, sub) : null), h('span', { class: 'switch' }, cb, h('span')));
}
// Переключатель с подтверждением и перезапуском (альтернативное соединение, режим экономии)
function restartToggle(ic, title, sub, key, enableText, disableText) {
  const cb = h('input', { type: 'checkbox' }); cb.checked = !!prefs.get(key);
  cb.onchange = async () => {
    const want = cb.checked;
    cb.checked = !want; // применяем только после «Да»
    if (!(await confirmDialog(title, want ? enableText : disableText, t('yes')))) return;
    prefs.set(key, want);
    location.reload(); // «Приложение будет перезапущено»
  };
  return h('label', { class: 'menu-item' }, icon(ic), h('div', { class: 'grow' }, h('div', null, title), h('div', { class: 'sub' }, sub)), h('span', { class: 'switch' }, cb, h('span')));
}
function fmtBytes(n) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} ГБ`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} МБ`;
  if (n >= 1 << 10) return `${Math.round(n / (1 << 10))} КБ`;
  return `${n} Б`;
}

function choice(ic, title, options, get, set) {
  const sub = h('div', { class: 'sub' });
  const paint = () => { sub.textContent = (options.find((o) => o[0] === get()) || options[0])[1]; };
  paint();
  return h('div', { class: 'menu-item', onclick: () => sheet(title, options.map(([v, l]) => ({ label: l, checked: v === get(), onClick: () => { set(v); paint(); } }))) },
    icon(ic), h('div', { class: 'grow' }, h('div', null, title), sub));
}
const cat = (title) => h('div', { class: 'menu-cat' }, title);

// --- Разделы. Строки берутся при сборке раздела: strings.json грузится после импорта модулей ---

function lookSection() {
  return [
    choice('ic_preference_night', 'Тёмная тема', [['system', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']], theme, setTheme),
    choice('ic_preference_appearance', 'Вид списков', [[0, 'Список'], [1, 'Сетка']], () => prefs.get('VIEW_TYPE') || 0, (v) => prefs.set('VIEW_TYPE', v)),
    // то же, что «Вкладка по умолчанию» в ic_tune на Главной (home.js)
    choice('ic_home', 'Вкладка Главной по умолчанию', homeTabTitles().map((l, i) => [i, l]),
      () => prefs.get('HOME_DEFAULT_PAGE') ?? 1, (v) => prefs.set('HOME_DEFAULT_PAGE', v)),
    choice('ic_bookmarks', 'Вкладка в закладках по умолчанию', ['Коллекции', 'История', 'Избранное', 'Смотрю', 'В планах', 'Просмотрено', 'Отложено', 'Брошено'].map((l, i) => [i, l]),
      () => prefs.get('BOOKMARKS_DEFAULT_PAGE') ?? 2, (v) => prefs.set('BOOKMARKS_DEFAULT_PAGE', v)),
    choice('ic_history', 'Время просмотра в профиле', [['days', 'Дни и часы'], ['hours', 'Часы']], () => prefs.get('WATCHED_TIME_FORMAT'), (v) => prefs.set('WATCHED_TIME_FORMAT', v)),
    // нижнее меню без подписей — ниже, больше места списку (как «Компактное нижнее меню» в Anixart)
    // значок на рабочем столе (как в Anixart — несколько на выбор); сменяется через несколько секунд
    window.anixartNative?.appIcon ? choice('ic_home', 'Значок приложения', [['default', 'Основной'], ['light', 'Светлый'], ['carmine', 'Карминовый']],
      () => window.anixartNative.appIcon.get(), (v) => { window.anixartNative.appIcon.set(v); toast('Значок на рабочем столе сменится через несколько секунд'); }) : null,
    ANDROID ? toggle('ic_preference_appearance', 'Компактное нижнее меню', 'Только значки, без подписей', 'COMPACT_NAV',
      (on) => document.documentElement.classList.toggle('compact-nav', on)) : null,
  ];
}

function playbackSection() {
  // от лучшего качества к худшему, как в чипе плеера над сериями; «спрашивать» — диалог перед каждой серией
  const PLAYERS = [[2, t('player_embedded')], [3, t('player_third_party')], [1, t('player_web')], [0, 'Спрашивать перед каждой серией']]
    .filter(([id]) => id !== 3 || has.externalPlayer);
  const QUALITY = [[0, t('quality_max_available')], [1, t('quality_min_available')], [3, '480p'], [4, '720p'], [5, '1080p'], [6, '1440p'], [7, '2160p']];
  // пропуск опенинга и эндинга — то же, что «Пропуски» в шестерёнке плеера: 'auto' — сам, иначе кнопка «Пропустить»
  const skip = (key) => ({ get: () => prefs.get(key) === 'auto', set: (v) => prefs.set(key, v ? 'auto' : 'watch') });
  const EXT_AUTO = 'mpv / VLC (автоопределение)';
  const ext = item('ic_open_link', t('pref_external_player'), prefs.get('THIRD_PARTY_PLAYER_PATH') || EXT_AUTO, async () => {
    const v = await prompt('Путь к плееру (mpv.exe или vlc.exe)', { value: prefs.get('THIRD_PARTY_PLAYER_PATH') });
    if (v == null) return;
    prefs.set('THIRD_PARTY_PLAYER_PATH', v.trim());
    ext.querySelector('.sub').textContent = v.trim() || EXT_AUTO;
    toast('Сохранено', { ok: true });
  });
  return [
    choice('ic_play_circle', t('player'), PLAYERS, () => prefs.get('SELECTED_PLAYER'), (v) => prefs.set('SELECTED_PLAYER', v)),
    choice('ic_quality', t('video_quality_priority'), QUALITY, () => prefs.get('SELECTED_VIDEO_QUALITY_V2'), (v) => prefs.set('SELECTED_VIDEO_QUALITY_V2', v)),
    // скорость запоминается и из шестерёнки плеера
    choice('ic_play_speed', 'Скорость воспроизведения', SPEEDS.map((s, i) => [i, s === 1 ? 'Обычная' : speedName(s)]), () => prefs.get('SELECTED_PLAYER_SPEED') ?? 3, (v) => prefs.set('SELECTED_PLAYER_SPEED', v)),
    toggle('ic_voice', t('remember_type_source'), t('remember_type_source_summary'), 'IS_REMEMBERING_TYPE_SOURCE'),
    has.externalPlayer ? ext : null,
    cat('Серии и пропуски'),
    toggle('ic_player_next', t('pref_autoplay_title'), t('pref_autoplay_summary'), 'AUTO_PLAY'),
    toggle('ic_player_rewind_fast', 'Пропускать опенинг', 'Сам, после короткого отсчёта; иначе — кнопка «Пропустить»', skip('SKIP_OPENING')),
    toggle('ic_player_rewind_fast', 'Пропускать эндинг', 'Сам, после короткого отсчёта; иначе — кнопка «Пропустить»', skip('SKIP_ENDING')),
    // серия без меток опенинга — кнопка «⏩» в плеере перематывает на это время (как в Anixart)
    choice('ic_player_rewind_fast', 'Перемотка опенинга без меток', [[60, '1:00'], [75, '1:15'], [85, '1:25 — рекомендуется'], [90, '1:30'], [105, '1:45'], [120, '2:00']],
      () => prefs.get('PLAYER_REWIND_TIME'), (v) => prefs.set('PLAYER_REWIND_TIME', v)),
    ANDROID ? toggle('ic_player_fill', 'Только горизонтально', 'Выключите — плеер поворачивается вместе с телефоном', 'PLAYER_LANDSCAPE_ONLY') : null,
    toggle('ic_player_next', 'Пропускать филлеры', '«Следующая серия» перескакивает филлеры; в плеере покажем, сколько пропущено', 'SKIP_FILLERS'),
  ];
}

function pictureSection() {
  return [
    ...(has.upscale ? upscaleItems() : []),
    ...(has.sharpen ? [cat('Улучшение картинки'),
      // телефон: резкость контуров в плеере (sharpen.js) — то же, что «Улучшение» в шестерёнке плеера
      // «Нейросеть» (Anime4K, anime4k-gl.js) — только если телефон её тянет (upscale/phone-check.js)
      choice('ic_upscale', 'Улучшение картинки', [['off', 'Выключено'], ['soft', 'Чётче — контуры чище у серий до 720p, чуть больше расход батареи'], ['strong', 'Сильнее — ещё резче'],
        neuralOk() ? ['neural', 'Нейросеть — Anime4K, как «720p +» в Anixart: чище линии; больше расход батареи'] : null].filter(Boolean),
        () => prefs.get('PLAYER_SHARPEN') || 'off', (v) => prefs.set('PLAYER_SHARPEN', v))] : []),
    cat('Звук'),
    // улучшение звука во встроенном плеере — то же, что «Звук» в шестерёнке плеера (audio.js)
    ...AUDIO_OPTS.map((o) => toggle(o.icon, o.label, o.sub, o.pref)),
  ];
}

function upscaleItems() {
  return [
    cat('Улучшение картинки'),
    // улучшение картинки во встроенном плеере — то же, что в шестерёнке плеера (upscale/index.js)
    choice('ic_upscale', 'Улучшение картинки', [['off', 'Выключено'], ['auto', 'Авто — подберёт под серию и видеокарту'],
      ['fast', 'Лёгкое — немного чётче, почти без нагрузки'], ['quality', 'Сильное — чистые линии, меньше артефактов сжатия'],
      ['max', 'Максимальное — лучшее качество, для мощной видеокарты']], () => prefs.get('UPSCALE_MODE'), (v) => prefs.set('UPSCALE_MODE', v)),
    choice('ic_quality', 'Разрешение улучшения', [['auto', 'Авто — под размер окна'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '4K']],
      () => prefs.get('UPSCALE_TARGET'), (v) => prefs.set('UPSCALE_TARGET', v)),
    trtSetting(),
    choice('ic_tune_variant', 'Резкость на ручном уровне', SHARPNESS.map((v) => [v, SHARP_LABEL[v]]), () => prefs.get('UPSCALE_SHARP') || 'normal', (v) => prefs.set('UPSCALE_SHARP', v)),
    // бенчмарк: каждая модель на 480p / 720p / 1080p (WebGPU и TensorRT) — по нему «Авто» берёт лучшую, что успевает
    item('ic_play_speed', 'Проверить видеокарту', benchInfo() && !benchInfo().partial ? `Проверено ${new Date(benchInfo().at).toLocaleDateString('ru-RU')} — нажмите, чтобы повторить` : 'Подобрать модели улучшения под видеокарту · несколько секунд', async () => {
      const r = await benchRunDialog();
      toast(r ? 'Готово — «Авто» будет брать лучшую модель, которая успевает' : 'Проверка остановлена');
      if (r) benchResultsDialog();
    }),
    item('ic_info_outline', 'Результаты проверки', 'Сколько мс на кадр занимает каждая модель', () => benchResultsDialog()),
  ];
}

function aiSection() {
  return [
    choice('ic_ai', 'Модель', AI_MODELS.map(([v, l, d]) => [v, `${l} — ${d}`]), () => prefs.get('AI_MODEL'), (v) => prefs.set('AI_MODEL', v)),
    choice('ic_tune', 'Глубина рассуждений (effort)', AI_EFFORTS.map(([v, l]) => [v, v === 'medium' ? `${l} — по умолчанию` : v === 'low' ? `${l} — быстрее всего` : v === 'max' ? `${l} — медленно, расходует больше лимитов` : l]), () => prefs.get('AI_EFFORT'), (v) => prefs.set('AI_EFFORT', v)),
  ];
}

function advancedSection() {
  return [
    // как «Данные» в настройках Anixart: экспорт списков в файл и перенос закладок с Shikimori (bookmarks-data.js)
    auth.loggedIn ? item('ic_export_variant', 'Экспорт закладок', 'Списки — в таблицу CSV или текстовый файл', () => exportBookmarks()) : null,
    auth.loggedIn ? item('ic_preference_data', 'Импорт закладок', 'Перенести списки с Shikimori', () => importBookmarks()) : null,
    restartToggle('ic_preference_data', t('alternative_connection'), t('alternative_connection_summary'), 'FORCE_SHOULD_USE_MIRROR_URLS',
      t('alternative_connection_enable_text'), t('alternative_connection_disable_text')),
    restartToggle('ic_preference_update', t('economy_mode'), t('economy_mode_summary'), 'ECONOMY_MODE', t('economy_mode_enable_text'), t('economy_mode_disable_text')),
    window.anixartNative?.clearWebCache ? item('ic_trash_outline', t('clear_webview_cache'), t('clear_webview_cache_summary'), async () => {
      if (!(await confirmDialog(t('clear_webview_cache'), t('clear_webview_cache_summary'), t('yes')))) return;
      toast(t('clearing_cache_progress'));
      try { const n = await window.anixartNative.clearWebCache(); toast(n ? t('cache_cleared_size', fmtBytes(n)) : t('cache_cleared')); } catch { toast(t('cache_clear_error')); }
    }) : null,
    // Android: ссылки anixart.tv открывает браузер, пока их не разрешили приложению (домены не наши, links.js)
    window.anixartNative?.openLinkSettings ? item('ic_open_in_new', 'Открывать ссылки Anixart здесь',
      'Ссылки anixart.tv на аниме, коллекции и профили — в этом приложении: «Добавить ссылку» в настройках Android', () => window.anixartNative.openLinkSettings()) : null,
  ];
}

function accountSection() {
  if (!auth.loggedIn) return [item('ic_profile', t('log_in'), 'Закладки, история и комментарии — с аккаунтом Anixart', () => navigate('auth'))];
  return [
    // фото, ник, приватность, блоклист, значок, соцсети, Email, привязки, удаление — как «Профиль» в настройках Anixart
    item('ic_profile', 'Настройки профиля', 'Фото, никнейм, приватность, блоклист, соцсети', () => navigate('profile-settings')),
    item('ic_bell', 'Уведомления', 'Какие уведомления присылать', () => navigate('notification-settings')),
    item('ic_pencil', 'Изменить статус', null, async () => {
      const v = await prompt('Изменить статус', { placeholder: 'Ваш статус…', okLabel: 'Сохранить' });
      if (v == null) return;
      try { const r = await A.statusEdit(v); toast(r.code === 0 ? 'Сохранено' : t('error_load')); } catch { toast(t('error_load')); }
    }),
    item('ic_lock', 'Изменить пароль', null, () => changePassword()),
    item('ic_history', 'Выйти из учетной записи', auth.profile?.login, async () => {
      if (await confirmDialog('Выход', 'Выйти из учетной записи?', 'Выйти')) { auth.clear(); toast('Вы вышли из учетной записи'); }
    }),
  ];
}

function aboutSection() {
  const about = item('ic_info_outline', APP_NAME, 'Неофициальный клиент Anixart', () => {});
  fetch('/__info').then((r) => r.json()).then((i) => {
    about.querySelector('.sub').textContent = `Версия ${i.appVersion} • неофициальный клиент Anixart`;
  }).catch(() => {});
  return [about, ...updateItems(),
    item('ic_open_in_new', 'Исходный код', 'github.com/arigandores/anix', () => window.open('https://github.com/arigandores/anix', '_blank')),
    // правила сообщества Anixart (комментарии, коллекции) — страница на сайте, как в его настройках
    item('ic_info_outline', 'Правила сообщества', 'Комментарии, коллекции, профиль — на сайте Anixart',
      () => window.open(`${(window.__toggles && window.__toggles.baseUrl) || 'https://anixart-app.com/'}rules`, '_blank')),
    h('div', { class: 'muted3', style: { fontSize: '12px', padding: '8px var(--page-pad) 16px' } },
      `${APP_NAME} не связан с разработчиками Anixart. Аккаунт, каталог и комментарии — сервис Anixart, видео — сторонние источники.`)];
}

const SECTIONS = [
  { id: 'look', icon: 'ic_preference_appearance', title: 'Внешний вид', render: lookSection },
  { id: 'playback', icon: 'ic_play_circle', title: 'Воспроизведение', render: playbackSection },
  has.upscale || has.sharpen ? { id: 'picture', icon: 'ic_upscale', title: 'Картинка и звук', render: pictureSection }
    : { id: 'picture', icon: 'ic_audio', title: 'Звук', render: pictureSection },
  has.discord ? { id: 'discord', icon: 'ic_discord', title: 'Discord', render: () => [discordSetting()] } : null,
  has.ai ? { id: 'ai', icon: 'ic_ai', title: 'AI-помощник', render: aiSection } : null,
  { id: 'advanced', icon: 'ic_tune', title: 'Дополнительно', render: advancedSection },
  { id: 'account', icon: 'ic_profile', title: 'Аккаунт', render: accountSection },
  { id: 'about', icon: 'ic_info_outline', title: 'О приложении', render: aboutSection },
].filter(Boolean);
let lastSection = 'look'; // повторный заход в настройки — в тот же раздел (до перезапуска)

// params.section — открыть сразу нужный раздел («Редактировать» в профиле → «Аккаунт»)
registerScreen('settings', ({ section } = {}) => {
  const nav = h('div', { class: 'settings-nav', role: 'tablist', 'aria-label': 'Разделы настроек' });
  const body = h('div', { class: 'settings-body', role: 'tabpanel' });
  const built = new Map();
  const buttons = new Map();
  let current = null;
  const visible = () => SECTIONS.filter((s) => buttons.get(s.id)?.isConnected);
  const build = (s) => {
    if (!built.has(s.id)) built.set(s.id, h('div', { class: 'menu-list', 'data-section': s.id }, h('h2', { class: 'settings-title' }, s.title), ...s.render()));
    return built.get(s.id);
  };
  // swiped — раздел сменили свайпом (swipePages): новый въезжает сбоку сам, без проявления
  function select(id, byUser, swiped = false) {
    const s = SECTIONS.find((x) => x.id === id) || SECTIONS[0];
    if (s.id === current) return;
    current = s.id; lastSection = s.id;
    buttons.forEach((b, k) => { const on = k === s.id; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    body.replaceChildren(build(s));
    if (!byUser) return; // первый показ — без своей анимации: идёт въезд экрана
    if (!swiped) nudge(built.get(s.id), [{ opacity: 0 }, { opacity: 1 }], 200);
    const vp = document.getElementById('viewport');
    if (vp && vp.scrollTop > 0) { vp.__jump = true; vp.scrollTop = 0; } // новый раздел — с начала (прыжок, не жест: hidebar.js)
    // телефон: разделы — строкой, выбранный по центру (видно, что есть ещё). Не scrollIntoView: строка липкая, и он
    // прокручивал ещё и экран
    const b = buttons.get(s.id);
    if (nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: nav.scrollLeft + b.getBoundingClientRect().left - nav.getBoundingClientRect().left - (nav.clientWidth - b.offsetWidth) / 2, behavior: 'smooth' });
  }
  for (const s of SECTIONS) {
    const b = h('button', { class: 'settings-tab', role: 'tab', 'data-section': s.id, onclick: () => select(s.id, true) }, icon(s.icon), h('span', null, s.title));
    buttons.set(s.id, b);
    nav.append(b);
  }
  // палец — свайп по разделу влево-вправо, как по вкладкам; стрелки — по разделам
  if (touch) swipePages(body, { count: () => visible().length, current: () => visible().findIndex((x) => x.id === current), page: () => built.get(current), peek: (i) => build(visible()[i]), select: (i) => select(visible()[i].id, true, true) });
  nav.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const list = visible(); const i = list.findIndex((s) => s.id === current);
    const next = list[(i + step + list.length) % list.length];
    select(next.id, true); buttons.get(next.id).focus();
  });
  // нет Discord-приложения в сборке — нет и раздела (флаг из /__features — без проверки, запущен ли Discord)
  fetch('/__features').then((r) => r.json()).then((f) => {
    if (f.discord !== false || !buttons.has('discord')) return;
    buttons.get('discord').remove();
    if (current === 'discord') select('look');
  }).catch(() => {});
  select(section || lastSection);
  return h('div', null, backToolbar('Настройки'), h('div', { class: 'settings' }, h('div', { class: 'settings-in' }, nav, body)));
});

// «Проверить обновления» и «Что нового» (update.js) — только в приложении для Windows. Проверка из настроек
// предлагает и версию, которую пропустили при запуске.
function updateItems() {
  if (!canUpdate()) return [];
  const known = lastCheck();
  const IDLE = 'Новые версии выходят на GitHub';
  let busy = false;
  const check = item('ic_preference_update', 'Проверить обновления', known?.version ? `Вышла версия ${known.version} — нажмите, чтобы обновить` : IDLE, async () => {
    if (busy) return;
    busy = true;
    const sub = check.querySelector('.sub');
    sub.textContent = 'Проверяем…';
    const r = await checkUpdate().catch(() => null);
    busy = false;
    // итог — и тостом: подпись под пунктом меняется незаметно, нажатие выглядело как «ничего не произошло»
    const say = (text, o) => { sub.textContent = text; toast(text, o); };
    if (!r) { say('Не удалось проверить — нет связи с GitHub'); return; }
    if (!r.supported) { say('Обновляется только установленное приложение'); return; }
    if (!r.version) { say(`Установлена последняя версия — ${r.current}`, { ok: true }); return; }
    sub.textContent = `Вышла версия ${r.version} — нажмите, чтобы обновить`;
    updateDialog(r);
  });
  const notes = item('ic_history', 'Что нового', 'Изменения в установленной версии', async () => {
    const [i, md] = await Promise.all([fetch('/__info').then((r) => r.json()), releaseNotes()]).catch(() => []);
    if (!md) { toast('Не удалось загрузить описание версии'); return; }
    whatsNewDialog(i.appVersion, md);
  });
  return [check, notes];
}

// Ускорение NVIDIA (TensorRT) для улучшения картинки: только на видеокартах RTX. Пока библиотеки не скачаны —
// пункт «Установить» с прогрессом, после — переключатель (electron/trt.js, upscale/index.js)
function trtSetting() {
  const slot = h('div');
  const TITLE = 'Ускорение NVIDIA (TensorRT)';
  const SUB = 'Тяжёлые модели улучшения картинки в 2–4 раза быстрее на тензорных ядрах';
  trtStatus().then((st) => {
    if (st.reason === 'driver') { slot.replaceWith(item('ic_upscale', TITLE, 'Обновите драйвер видеокарты NVIDIA (версия 580 или новее) — тогда ускорение заработает', () => {})); return; }
    if (!st.supported) { slot.remove(); return; }
    if (st.installed) { slot.replaceWith(toggle('ic_upscale', TITLE, SUB, 'UPSCALE_TRT')); return; }
    let busy = false;
    const el = item('ic_upscale', TITLE, `Не установлено · скачать ${Math.round(st.size / 1048576)} МБ (библиотеки NVIDIA)`, async () => {
      if (busy) return;
      busy = true;
      const sub = el.querySelector('.sub');
      const r = await trtInstall((p) => { sub.textContent = p.done ? 'Установка…' : `Скачивание ${Math.floor((p.received / (p.total || 1)) * 100)}%`; })
        .catch((e) => ({ ok: false, error: e.message }));
      busy = false;
      if (r.ok) { toast('Ускорение NVIDIA установлено'); el.replaceWith(toggle('ic_upscale', TITLE, SUB, 'UPSCALE_TRT')); } else { toast(`Не удалось установить: ${r.error}`); sub.textContent = 'Не установлено — нажмите, чтобы повторить'; }
    });
    slot.replaceWith(el);
  });
  return slot;
}

// Статус в Discord: привязывать ничего не нужно — статус уходит в Discord, запущенный на этом компьютере
// (server/discord.js). Подпись показывает, видит ли приложение Discord.
function discordSetting() {
  const sub = h('div', { class: 'sub' }, 'Проверяем Discord…');
  const el = toggle('ic_discord', 'Статус в Discord', '', 'DISCORD_PRESENCE', (on) => { if (!on) clearPresence(); paint(); });
  el.querySelector('.grow').append(sub);
  let st = null;
  const paint = () => {
    if (!st) return;
    sub.textContent = prefs.get('DISCORD_PRESENCE') !== true ? 'Выключено — включите, чтобы друзья видели, что вы смотрите'
      : st.running ? 'Discord подключён — друзья видят, что вы смотрите: тайтл, серию и время'
        : 'Discord не запущен на этом компьютере — статус появится, как только вы его откроете';
  };
  discordStatus().then((s) => { st = s; paint(); });
  return el;
}

function changePassword() {
  const cur = h('input', { class: 'input', type: 'password', placeholder: 'Текущий пароль' });
  const n1 = h('input', { class: 'input', type: 'password', placeholder: 'Новый пароль', style: { marginTop: '10px' } });
  const n2 = h('input', { class: 'input', type: 'password', placeholder: 'Повторите пароль', style: { marginTop: '10px' } });
  dialog({
    title: 'Изменить пароль', content: h('div', null, cur, n1, n2),
    actions: [{ label: 'Отмена' }, {
      label: 'Сохранить', primary: true,
      onClick: async () => {
        if (cur.value.length < 6 || cur.value.length > 32) { toast('Текущий пароль введен неверно.'); return true; }
        if (n1.value.length < 6 || n1.value.length > 32) { toast('Новый пароль слишком короткий или слишком длинный, или содержит недопустимые символы.'); return true; }
        if (n1.value !== n2.value) { toast('Вы ошиблись при повторном вводе пароля.'); return true; }
        const r = await A.changePassword(cur.value, n1.value);
        if (r.code === 0) { if (r.token) auth.save(r.token, auth.profile); toast('Пароль успешно изменен'); return false; }
        toast(r.code === 3 ? 'Текущий пароль введен неверно.' : 'Пароль слишком короткий');
        return true;
      },
    }],
  });
}
