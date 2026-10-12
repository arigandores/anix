// Настройки: Воспроизведение / Внешний вид / Профиль (основное)
import { h, icon, toast, sheet, prompt, confirmDialog, dialog } from '../ui.js';
import { A, auth } from '../api.js';
import { t, prefs, theme, setTheme } from '../store.js';
import { registerScreen, navigate } from '../router.js';
import { backToolbar } from './common.js';
import { choosePlayer } from './episodes.js';
import { AI_MODELS, AI_EFFORTS } from './ai.js';

function item(ic, title, sub, onClick) {
  return h('div', { class: 'menu-item', onclick: onClick }, icon(ic), h('div', { class: 'grow' }, h('div', null, title), sub ? h('div', { class: 'sub' }, sub) : null));
}
function toggle(ic, title, sub, key, onChange) {
  const cb = h('input', { type: 'checkbox' }); cb.checked = !!prefs.get(key);
  cb.onchange = () => { prefs.set(key, cb.checked); onChange && onChange(cb.checked); };
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

registerScreen('settings', () => {
  // строки берутся при открытии экрана: strings.json грузится после импорта модулей
  const PLAYERS = [[0, t('player_always_ask')], [2, t('player_embedded')], [1, t('player_web')], [3, t('player_third_party')]];
  const QUALITY = [[0, t('quality_max_available')], [1, t('quality_min_available')], [3, '480p'], [4, '720p'], [5, '1080p'], [6, '1440p'], [7, '2160p']];
  const root = h('div', null, backToolbar('Настройки'));
  const list = h('div', { class: 'menu-list', style: { maxWidth: '760px' } });
  list.append(h('div', { class: 'menu-cat' }, 'Внешний вид'),
    choice('ic_preference_night', 'Тёмная тема', [['system', 'Как в системе'], ['light', 'Светлая'], ['dark', 'Тёмная']], theme, setTheme),
    choice('ic_preference_appearance', 'Вид списков', [[0, 'Список'], [1, 'Сетка']], () => prefs.get('VIEW_TYPE') || 0, (v) => prefs.set('VIEW_TYPE', v)),
    choice('ic_bookmarks', 'Вкладка в закладках по умолчанию', ['Коллекции', 'История', 'Избранное', 'Смотрю', 'В планах', 'Просмотрено', 'Отложено', 'Брошено'].map((l, i) => [i, l]),
      () => prefs.get('BOOKMARKS_DEFAULT_PAGE') ?? 2, (v) => prefs.set('BOOKMARKS_DEFAULT_PAGE', v)),
    h('div', { class: 'menu-cat' }, 'Воспроизведение'),
    choice('ic_play_circle', t('player'), PLAYERS, () => prefs.get('SELECTED_PLAYER'), (v) => prefs.set('SELECTED_PLAYER', v)),
    choice('ic_quality', t('video_quality_priority'), QUALITY, () => prefs.get('SELECTED_VIDEO_QUALITY_V2'), (v) => prefs.set('SELECTED_VIDEO_QUALITY_V2', v)),
    choice('ic_quality', t('kodik_video_quality'), [[0, `${t('quality_high_title')} (720p, с рекламой)`], [1, `${t('quality_medium_title')} (480p, без рекламы)`]],
      () => prefs.get('SELECTED_KODIK_VIDEO_QUALITY'), (v) => prefs.set('SELECTED_KODIK_VIDEO_QUALITY', v)),
    toggle('ic_player_next', t('pref_autoplay_title'), t('pref_autoplay_summary'), 'AUTO_PLAY'),
    toggle('ic_voice', t('remember_type_source'), t('remember_type_source_summary'), 'IS_REMEMBERING_TYPE_SOURCE'),
    toggle('ic_streaming_platform', t('remember_third_party_platform'), t('remember_third_party_platform_summary'), 'IS_REMEMBERING_SKIP_THIRD_PARTY_PLATFORM'),
    item('ic_player_rewind_fast', t('title_player_rewind'), `${prefs.get('PLAYER_REWIND_TIME')} c`, async (e) => {
      const v = await prompt(t('selected_player_rewind_time'), { value: String(prefs.get('PLAYER_REWIND_TIME')) });
      const n = Number(v);
      if (v != null && n >= 5 && n < 3600) { prefs.set('PLAYER_REWIND_TIME', Math.floor(n)); e.currentTarget?.querySelector?.('.sub') && (e.currentTarget.querySelector('.sub').textContent = `${n} c`); toast('Сохранено'); }
    }),
    item('ic_open_link', t('pref_external_player'), prefs.get('THIRD_PARTY_PLAYER_PATH') || 'mpv / VLC (автоопределение)', async () => {
      const v = await prompt('Путь к плееру (mpv.exe или vlc.exe)', { value: prefs.get('THIRD_PARTY_PLAYER_PATH') });
      if (v != null) { prefs.set('THIRD_PARTY_PLAYER_PATH', v.trim()); toast('Сохранено'); }
    }),
    item('ic_play_speed', t('title_choose_player'), 'Выбрать плеер сейчас', () => choosePlayer(true)));

  list.append(h('div', { class: 'menu-cat' }, 'AI-помощник'),
    choice('ic_ai', 'Модель', AI_MODELS.map(([v, l, d]) => [v, `${l} — ${d}`]), () => prefs.get('AI_MODEL'), (v) => prefs.set('AI_MODEL', v)),
    choice('ic_tune', 'Глубина рассуждений (effort)', AI_EFFORTS.map(([v, l]) => [v, v === 'medium' ? `${l} — по умолчанию` : v === 'low' ? `${l} — быстрее всего` : v === 'max' ? `${l} — медленно, расходует больше лимитов` : l]), () => prefs.get('AI_EFFORT'), (v) => prefs.set('AI_EFFORT', v)));
  list.append(h('div', { class: 'menu-cat' }, 'Дополнительно'),
    restartToggle('ic_preference_data', t('alternative_connection'), t('alternative_connection_summary'), 'FORCE_SHOULD_USE_MIRROR_URLS',
      t('alternative_connection_enable_text'), t('alternative_connection_disable_text')),
    restartToggle('ic_preference_update', t('economy_mode'), t('economy_mode_summary'), 'ECONOMY_MODE', t('economy_mode_enable_text'), t('economy_mode_disable_text')),
    window.anixartNative?.clearWebCache ? item('ic_trash_outline', t('clear_webview_cache'), t('clear_webview_cache_summary'), async () => {
      if (!(await confirmDialog(t('clear_webview_cache'), t('clear_webview_cache_summary'), t('yes')))) return;
      toast(t('clearing_cache_progress'));
      try { const n = await window.anixartNative.clearWebCache(); toast(n ? t('cache_cleared_size', fmtBytes(n)) : t('cache_cleared')); } catch { toast(t('cache_clear_error')); }
    }) : null);

  if (auth.loggedIn) {
    list.append(h('div', { class: 'menu-cat' }, 'Профиль'),
      item('ic_pencil', 'Изменить статус', null, async () => {
        const v = await prompt('Изменить статус', { placeholder: 'Ваш статус…', okLabel: 'Сохранить' });
        if (v == null) return;
        try { const r = await A.statusEdit(v); toast(r.code === 0 ? 'Сохранено' : t('error_load')); } catch { toast(t('error_load')); }
      }),
      item('ic_lock', 'Изменить пароль', null, () => changePassword()),
      item('ic_history', 'Выйти из учетной записи', auth.profile?.login, async () => {
        if (await confirmDialog('Выход', 'Выйти из учетной записи?', 'Выйти')) { auth.clear(); toast('Вы вышли из учетной записи'); }
      }));
  } else {
    list.append(h('div', { class: 'menu-cat' }, 'Профиль'), item('ic_profile', t('log_in'), null, () => navigate('auth')));
  }
  const about = item('ic_info_outline', 'Anix Desktop', 'Неофициальный клиент Anixart', () => {});
  fetch('/__info').then((r) => r.json()).then((i) => {
    about.querySelector('.sub').textContent = `Версия ${i.appVersion} • неофициальный клиент Anixart`;
  }).catch(() => {});
  list.append(h('div', { class: 'menu-cat' }, 'О приложении'), about,
    item('ic_open_in_new', 'Исходный код', 'github.com/arigandores/anix-desktop', () => window.open('https://github.com/arigandores/anix-desktop', '_blank')),
    h('div', { class: 'muted3', style: { fontSize: '12px', padding: '8px 16px 16px' } },
      'Anix Desktop не связан с разработчиками Anixart. Аккаунт, каталог и комментарии — сервис Anixart, видео — сторонние источники.'));
  root.append(list);
  return root;
});

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
