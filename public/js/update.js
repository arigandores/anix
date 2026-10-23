// Обновление приложения (Electron — electron/updater.js; Android — Updater.kt через android/web/shim.js). При запуске — проверка; вышла новая версия — окно
// с «Что нового» из текста релиза. «Обновить» — скачивание с прогрессом, затем приложение закрывается, ставит новую
// версию поверх и запускается снова. «Пропустить эту версию» — при запуске её больше не предлагаем (следующую —
// снова; «Проверить обновления» в настройках предлагает и пропущенную). Первый запуск новой версии — тост.
import { h, toast, dialog } from './ui.js';
import { prefs } from './store.js';
import { markdown } from './screens/ai.js';
import { ANDROID, APP_NAME } from './platform.js';

const U = () => window.anixartNative?.update || null;
const RELEASES = 'https://github.com/arigandores/anix/releases/latest';
export const canUpdate = () => !!U();

let last = null; // последняя проверка: { supported, current, version?, notes? }
let offered = null; // версия, окно о которой уже открывали в этом сеансе
export const lastCheck = () => last;
export async function checkUpdate() { last = await U().check(); return last; }
export const releaseNotes = (version) => U().notes(version);

// Из текста релиза — первая строка (о чём версия) и список «Что нового»; «Как установить», SmartScreen и версия
// для браузера обновляющемуся не нужны. Нет раздела «Что нового» — текст целиком. У платформ бывают свои разделы
// после общего списка — «**Windows**» и «**Android**» (docs/RELEASE.md): показываются общий и свой, чужой — нет.
// Строка «Платформы: …» — для сборки (какие платформы выпускать), не для людей
const PLATFORM_HEAD = /^\s*(#{1,4}\s*)?(\*\*)?\s*(?:Для\s+|На\s+)?(Windows|Android)\s*:?\s*(\*\*)?\s*:?\s*$/i;
const PLATFORMS_LINE = /^\s*(Платформы|Platforms)\s*:/i;
export function whatsNew(md, platform = ANDROID ? 'android' : 'windows') {
  const lines = String(md || '').replace(/\r/g, '').split('\n').filter((l) => !PLATFORMS_LINE.test(l));
  const at = lines.findIndex((l) => /^\s*(#{1,4}\s*)?(\*\*)?\s*Что нового/i.test(l));
  if (at < 0) return lines.join('\n').trim();
  const lead = lines.slice(0, at).find((l) => l.trim() && !/^\s*>/.test(l) && !/Как установить/i.test(l));
  const out = lead ? [lead, ''] : [];
  let list = false; let section = null; // null — общий список, иначе 'windows' | 'android'
  for (const l of lines.slice(at + 1)) {
    const head = PLATFORM_HEAD.exec(l);
    if (head) { section = head[3].toLowerCase(); continue; }
    const item = /^\s*([-*•]|\d+[.)])\s/.test(l);
    if (item) { if (!section || section === platform) out.push(l); list = true; } else if (!l.trim()) continue; else if (list) break; else if (!section || section === platform) out.push(l);
  }
  return out.join('\n').trim();
}

function notesView(md) {
  const text = whatsNew(md);
  if (!text) return h('p', null, 'Что нового — ', h('a', { href: RELEASES, target: '_blank', rel: 'noopener noreferrer' }, 'на странице релиза'), '.');
  return h('div', { class: 'update-notes' }, markdown(text));
}

const mb = (n) => (n / 1048576).toFixed(n >= 100 * 1048576 ? 0 : 1).replace('.', ',');
const button = (label, onClick, primary) => h('button', { class: `btn ${primary ? 'btn-primary' : 'btn-text'}`, onclick: onClick }, label);

// Ошибка скачивания — понятным текстом, подробности — в консоли
function failReason(err) {
  const e = String(err || '');
  if (/sha512|checksum/i.test(e)) return 'Файл обновления скачался с ошибкой.';
  if (/ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|net::|socket|network/i.test(e)) return 'Не удалось скачать обновление — нет связи с GitHub. Проверьте подключение к интернету.';
  if (/ENOSPC/i.test(e)) return 'Не хватает места на диске для обновления.';
  return 'Не удалось скачать обновление.';
}

// Окно «Вышла новая версия»: предложение → скачивание с прогрессом → установка (или ошибка с «Повторить»)
export function updateDialog(info) {
  offered = info.version;
  const skip = h('input', { type: 'checkbox' }); skip.checked = prefs.get('UPDATE_SKIP_VERSION') === info.version;
  const body = h('div', { class: 'update' });
  const actions = h('div', { class: 'dialog-actions' });
  let started = false; let downloading = false; let off = null;
  const d = dialog({
    title: 'Вышла новая версия', cls: 'wide update-dialog', content: h('div', { class: 'update-wrap' }, body, actions),
    dismissible: () => !downloading, // скачивание прерывает только «Отмена»
    onClose: () => {
      off?.();
      if (downloading) U().cancel();
      if (!started) prefs.set('UPDATE_SKIP_VERSION', skip.checked ? info.version : null);
    },
  });
  const download = async () => {
    started = true; downloading = true;
    d.box.querySelector('.dialog-title').textContent = `Обновление до ${info.version}`;
    const fill = h('div', { class: 'bench-fill' });
    const label = h('div', { class: 'bench-label' }, 'Подключение…');
    body.replaceChildren(h('p', null, ANDROID ? 'Скачиваем новую версию. Потом Android спросит, обновить ли приложение, — вход и настройки сохранятся.'
      : 'Скачиваем новую версию. Потом приложение закроется, установит новую версию и откроется снова — вход и настройки сохранятся.'),
      h('div', { class: 'bench-bar' }, fill), label);
    actions.replaceChildren(button('Отмена', () => U().cancel()));
    off = U().onProgress((p) => {
      fill.style.width = `${p.percent}%`;
      label.textContent = `${Math.floor(p.percent)}% · ${mb(p.transferred)} из ${mb(p.total)} МБ${p.speed ? ` · ${mb(p.speed)} МБ/с` : ''}`;
    });
    const r = await U().download().catch((e) => ({ ok: false, error: e.message }));
    off(); off = null; downloading = false;
    if (r.ok) {
      fill.style.width = '100%'; label.textContent = ANDROID ? 'Подтвердите обновление в окне Android…' : 'Устанавливаем — приложение перезапустится…';
      // Android: отказались в системном окне или установка не прошла — сказать и дать повторить (на ПК приложение уже закрылось)
      const installNow = async () => {
        actions.replaceChildren();
        body.replaceChildren(h('div', { class: 'bench-bar' }, fill), label); // повтор — снова «подтвердите…», а не прошлая ошибка
        const ir = await U().install();
        if (!ir || ir.ok !== false) return;
        body.replaceChildren(h('p', null, `Обновление не установлено${ir.error ? `: ${ir.error}` : ''}.`));
        actions.replaceChildren(button('Закрыть', () => d.close()), button('Установить', installNow, true));
      };
      installNow();
      return;
    }
    if (r.canceled) { d.close(); toast('Обновление отменено'); return; }
    console.warn('[update] скачивание', r.error);
    body.replaceChildren(h('p', null, `${failReason(r.error)} Попробуйте ещё раз или скачайте установщик со страницы релиза.`));
    actions.replaceChildren(button('Скачать вручную', () => { window.open(RELEASES, '_blank'); d.close(); }), button('Закрыть', () => d.close()), button('Повторить', download, true));
  };
  body.append(h('div', { class: 'update-ver' }, `${APP_NAME} ${info.version} · у вас ${info.current}`), notesView(info.notes),
    h('label', { class: 'row update-skip' }, skip, 'Пропустить эту версию'));
  actions.append(button('Позже', () => d.close()), button('Обновить', download, true));
  return d;
}

export function whatsNewDialog(version, md) {
  dialog({ title: `Что нового в ${version}`, cls: 'wide update-dialog', content: notesView(md), actions: [{ label: 'OK', primary: true }] });
}

// Окно не открываем поверх плеера и другого окна (приглашение в комнату и т. п.) — ждём, пока закроются
const busyUi = () => document.fullscreenElement || document.querySelector('.player-overlay, .backdrop');
const whenFree = () => new Promise((ok) => { const tick = () => (busyUi() ? setTimeout(tick, 1000) : ok()); tick(); });

export async function startupUpdateCheck() {
  if (!U()) return;
  try {
    const { appVersion } = await (await fetch('/__info')).json();
    const seen = prefs.get('APP_VERSION');
    if (seen !== appVersion) { prefs.set('APP_VERSION', appVersion); if (seen) toast(`${APP_NAME} обновлён до ${appVersion}`, { ok: true, ms: 4000 }); }
  } catch { /* без тоста */ }
  let info;
  try { info = await checkUpdate(); } catch { return; } // нет сети или GitHub — молча, до следующего запуска
  if (!info.version || prefs.get('UPDATE_SKIP_VERSION') === info.version) return;
  await whenFree();
  if (offered !== info.version) updateDialog(info); // уже открывали из настроек — второй раз не предлагаем
}
