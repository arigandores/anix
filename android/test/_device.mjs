// Общее для тестов Android-приложения: эмулятор (или подключённый телефон) через adb, страница в WebView через
// DevTools (adb forward → webview_devtools_remote_<pid>), нажатия — как пальцем (adb input tap по координатам элемента).
// Тест печатает PASS/FAIL/SKIP построчно; провал — FAIL и код выхода 1 (android/test/run-all.mjs).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PKG = 'com.arigandores.anix';
export const PORT = 38371; // LocalServer: постоянный порт (localStorage привязан к адресу)
const SDK = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
const ADB = fs.existsSync(path.join(SDK, 'platform-tools', 'adb.exe')) ? path.join(SDK, 'platform-tools', 'adb.exe') : 'adb';
const AVD = process.env.ANIX_AVD || 'Anix_Test';
const APK = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
export const SHOTS = path.join(ROOT, 'android', 'test', 'shots');
// последний аргумент { timeout } — сколько ждать (по умолчанию 2 мин: зависший adb — ошибка теста, а не вечное ожидание)
const run = (...args) => {
  const o = args.length && typeof args[args.length - 1] === 'object' ? args.pop() : {};
  return execFileSync(ADB, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1' }, timeout: o.timeout ?? 120000 }).replace(/\r/g, '');
};
// Подключённые устройства: [серийный номер] в состоянии device
export const devices = () => run('devices').split('\n').slice(1).filter((l) => /\tdevice$/.test(l)).map((l) => l.split('\t')[0]);

// ---------- результат ----------
let failed = 0; let skipped = 0;
export function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== '' && extra != null ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`);
  if (!ok) failed++;
  return ok;
}
export function skip(name, why) { console.log(`SKIP [${name}] ${why}`); skipped++; }
export function done(name) {
  if (failed) { console.log(`FAIL ${name}: ${failed} провал(ов)`); process.exit(1); }
  console.log(`OK ${name}${skipped ? ` (пропущено: ${skipped})` : ''}`);
  process.exit(0);
}
// Упал сам тест — сразу FAIL, а не ожидание таймаута
process.on('unhandledRejection', (e) => { console.log(`FAIL необработанная ошибка: ${e && e.stack || e}`); process.exit(1); });
process.on('uncaughtException', (e) => { console.log(`FAIL необработанная ошибка: ${e && e.stack || e}`); process.exit(1); });

export const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------- adb ----------
export const adb = run;
export const sh = (cmd) => adb('shell', cmd);

export async function waitFor(fn, ms, step = 500) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* ещё нет */ }
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

// Устройство: ANDROID_SERIAL или свой эмулятор ANIX_AVD (по умолчанию Anix_Test), разблокированное
export async function ensureDevice() {
  // не сказано какое устройство (ANDROID_SERIAL) — свой эмулятор Anix_Test*, запущенный или новый. Не первый попавшийся:
  // на телефоне обычно release-сборка без DevTools, а чужие эмуляторы (Pixel_7 с PIN-кодом и т. п.) тесты не трогают
  if (!process.env.ANDROID_SERIAL) [process.env.ANDROID_SERIAL] = await startEmulators(1);
  if (!(await waitFor(() => sh('getprop sys.boot_completed').trim() === '1', 180000, 2000))) throw new Error('устройство не загрузилось');
  if (!/RUNNING_UNLOCKED/.test(sh('dumpsys user'))) {
    sh('input keyevent 224'); sh('wm dismiss-keyguard');
    if (!(await waitFor(() => /RUNNING_UNLOCKED/.test(sh('dumpsys user')), 10000))) throw new Error('устройство заблокировано (PIN) — нужен эмулятор без блокировки');
  }
  // размер шрифта и поворот — как просит тест (ANIX_FONT_SCALE, ANIX_LANDSCAPE), иначе обычные. Смена шрифта пересоздаёт
  // окно приложения — ждём, пока применится, до запуска (иначе страница перезагрузится посреди теста)
  sh('settings put system accelerometer_rotation 0');
  const want = { font_scale: process.env.ANIX_FONT_SCALE || '1.0', user_rotation: process.env.ANIX_LANDSCAPE === '1' ? '1' : '0' };
  let changed = false;
  for (const [k, v] of Object.entries(want)) if (sh(`settings get system ${k}`).trim() !== v) { sh(`settings put system ${k} ${v}`); changed = true; }
  if (changed) {
    // применилось — экран повёрнут как надо (а не «прошло 3 секунды»: медленный эмулятор не успевал)
    await waitFor(() => new RegExp(`mRotation=${want.user_rotation}\\b`).test(sh('dumpsys window | grep -E "mRotation="')), 15000, 500);
    await sleep(1500);
  }
  // Подсказка системы «Viewing full screen» при первом плеере без полос забирает касания и «Назад», пока не нажмут «Got it»:
  // у пользователя — один раз, в тестах — считаем уже показанной
  sh('settings put secure immersive_mode_confirmations confirmed');
  sh('settings put secure stylus_handwriting_enabled 0'); // Gboard на чистом эмуляторе предлагает ввод стилусом и забирает поле
  sh('settings put global window_animation_scale 0'); sh('settings put global transition_animation_scale 0');
}

// Эмуляторы для параллельных тестов: n штук, у каждого свой AVD (Anix_Test, Anix_Test_2, …; копии — config.ini
// основного, данные создаются при первом запуске). Свои узнаются по имени AVD (emu avd name), а не по порту: порт
// 5554 может занять эмулятор пользователя; новые — на свободных портах. Не -read-only одного AVD: так
// несколько экземпляров стартуют, но adb shell у всех зависает. Без снимков (-no-snapshot): загрузка с нуля ~25–50 с,
// а со снимка, сохранённого при падении, эмулятор висел без конца. Запуск по одному (дождаться появления в adb).
// Программная отрисовка: с аппаратной (-gpu auto) эмулятор после долгой работы падал при старте.
// Возвращает серийные номера n эмуляторов, загруженных до конца; started — какие запущены сейчас
const AVD_HOME = process.env.ANDROID_AVD_HOME || path.join(os.homedir(), '.android', 'avd');
function ensureAvd(name) {
  if (name === AVD || fs.existsSync(path.join(AVD_HOME, `${name}.ini`))) return;
  const config = fs.readFileSync(path.join(AVD_HOME, `${AVD}.avd`, 'config.ini'), 'utf8')
    .replace(/^AvdId=.*$/m, `AvdId=${name}`).replace(/^avd\.ini\.displayname=.*$/m, `avd.ini.displayname=${name}`);
  fs.mkdirSync(path.join(AVD_HOME, `${name}.avd`), { recursive: true });
  fs.writeFileSync(path.join(AVD_HOME, `${name}.avd`, 'config.ini'), config);
  const target = (/^target=.*$/m.exec(fs.readFileSync(path.join(AVD_HOME, `${AVD}.ini`), 'utf8')) || ['target=android-37.0'])[0];
  fs.writeFileSync(path.join(AVD_HOME, `${name}.ini`), `avd.ini.encoding=UTF-8\r\npath=${path.join(AVD_HOME, `${name}.avd`)}\r\npath.rel=avd\\${name}.avd\r\n${target}\r\n`);
}
const avdName = (serial) => { try { return run('-s', serial, 'emu', 'avd', 'name', { timeout: 5000 }).split('\n')[0].trim(); } catch { return ''; } };
export async function startEmulators(n, { started = [] } = {}) {
  const emu = path.join(SDK, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
  const all = () => run('devices').split('\n').slice(1).map((l) => l.split('\t')[0]).filter((d) => d.startsWith('emulator-'));
  const running = new Map(all().map((d) => [avdName(d), d]));
  const list = [];
  for (let i = 0; i < n; i++) {
    const name = i ? `${AVD}_${i + 1}` : AVD;
    if (running.has(name)) { list.push(running.get(name)); continue; }
    let port = 5554;
    const busy = new Set([...all(), ...list].map((d) => Number(d.replace('emulator-', ''))));
    while (busy.has(port)) port += 2;
    const serial = `emulator-${port}`;
    list.push(serial);
    ensureAvd(name);
    spawn(emu, ['-avd', name, '-no-snapshot', '-port', String(port), '-no-boot-anim', '-no-audio', '-no-window', '-gpu', 'swiftshader_indirect'], { detached: true, stdio: 'ignore' }).unref();
    if (!(await waitFor(() => all().includes(serial), 60000, 1000))) throw new Error(`эмулятор ${name} (${serial}) не запустился`);
    started.push(serial);
  }
  const booted = (d) => run('-s', d, 'shell', 'getprop sys.boot_completed', { timeout: 5000 }).trim() === '1';
  for (const d of list) if (!(await waitFor(() => booted(d), 240000, 2000))) throw new Error(`${d} не загрузился`);
  return list;
}

// APK собран заранее (./gradlew assembleDebug) — ставим, если на устройстве другая сборка
export function install() {
  if (!fs.existsSync(APK)) throw new Error(`нет ${APK} — сначала cd android && ./gradlew assembleDebug`);
  const stamp = String(fs.statSync(APK).mtimeMs);
  const mark = path.join(SHOTS, `.installed-${adb('get-serialno').trim().replace(/[^\w.-]/g, '_')}`);
  fs.mkdirSync(SHOTS, { recursive: true });
  const installed = /versionName/.test(sh(`dumpsys package ${PKG}`));
  if (installed && fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === stamp) return;
  adb('install', '-r', APK);
  fs.writeFileSync(mark, stamp);
}

export const pid = () => { try { return sh(`pidof ${PKG}`).trim(); } catch { return ''; } }; // нет процесса — pidof с ошибкой

// ---------- DevTools страницы ----------
let ws = null; let msgId = 0; const waiting = new Map(); const events = [];
let devtoolsPort = 0; // adb forward tcp:0 — свободный порт на каждый запуск: тесты на нескольких устройствах сразу
export const devtools = () => `http://127.0.0.1:${devtoolsPort}`;
export const pageErrors = [];
async function connect() {
  const p = await waitFor(() => pid(), 15000, 300);
  if (!p) throw new Error('приложение не запустилось');
  if (devtoolsPort) { try { adb('forward', '--remove', `tcp:${devtoolsPort}`); } catch { /* не было */ } }
  devtoolsPort = Number(adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${p}`).trim());
  // страниц приложения бывает две (пересоздали окно — старая ещё в списке): берём ту, что отвечает, с конца списка
  const ok = await waitFor(async () => {
    const list = (await (await fetch(`${devtools()}/json`)).json()).filter((t) => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${PORT}`));
    for (const target of list.reverse()) if (await attach(target)) return true;
    return false;
  }, 25000, 500);
  if (!ok) throw new Error('страница приложения не открылась');
}
async function attach(target) {
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  const opened = await new Promise((done) => { sock.onopen = () => done(true); sock.onerror = () => done(false); setTimeout(() => done(false), 3000); });
  if (!opened) { try { sock.close(); } catch { /* закрыт */ } return false; }
  ws = sock;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    events.push(m);
  };
  try { await cdp('Runtime.enable', {}, 3000); return true; } catch { try { sock.close(); } catch { /* закрыт */ } ws = null; return false; }
}
export function cdp(method, params = {}, ms = 30000) {
  return new Promise((ok, fail) => {
    const id = ++msgId;
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`DevTools ${method}: нет ответа`)); }, ms);
    waiting.set(id, (m) => { clearTimeout(timer); m.error ? fail(new Error(m.error.message)) : ok(m.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
// Выполнить выражение на странице (с await); исключение страницы — ошибка теста
export async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(`страница: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
// Ждать, пока выражение на странице станет истинным; null — не дождались
export const until = (expr, ms = 15000, step = 250) => {
  if (typeof expr !== 'string') throw new Error('until(): выражение для страницы — строкой; для проверок в тесте — waitFor()');
  return waitFor(() => js(expr), ms, step);
};

// Запуск приложения: fresh — с чистыми данными (как после установки)
export async function launch({ fresh = false, link = null } = {}) {
  if (ws) { try { ws.close(); } catch { /* закрыт */ } ws = null; }
  if (fresh) sh(`pm clear ${PKG}`); else sh(`am force-stop ${PKG}`);
  sh(link ? `am start -W -a android.intent.action.VIEW -d '${link}' ${PKG}` : `am start -W -n ${PKG}/.MainActivity`);
  await connect();
  await until('document.readyState === "complete" && document.querySelector(".nav-item")', 20000);
}
// Переподключиться к той же странице (после поворота, PiP, возврата из фона)
export async function reattach() { if (ws) { try { ws.close(); } catch { /* закрыт */ } } ws = null; await connect(); }

// Настоящий контент, не скелетон
export const REAL = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => !e.closest('.skeleton, .sk-root') && e.getClientRects().length).length`;

// ---------- палец ----------
// Центр элемента в пикселях экрана: CSS-пиксели × devicePixelRatio + где WebView на экране (anixAndroid.webOrigin)
export async function point(sel, { text = null, index = 0 } = {}) {
  return js(`(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.getClientRects().length && !e.closest('.skeleton, .sk-root'))
      .filter((e) => ${text == null ? 'true' : `e.textContent.includes(${JSON.stringify(text)})`});
    const el = all[${index}];
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const [ox, oy] = anixAndroid.webOrigin().split(',').map(Number);
    const x = Math.max(r.left, 0) + Math.min(r.width, innerWidth - Math.max(r.left, 0)) / 2;
    const y = Math.max(r.top, 0) + Math.min(r.height, innerHeight - Math.max(r.top, 0)) / 2;
    return { x: Math.round(ox + x * devicePixelRatio), y: Math.round(oy + y * devicePixelRatio) };
  })()`);
}
export async function tap(sel, opts = {}) {
  if (!topActivity().startsWith(PKG)) throw new Error(`приложение не на экране (сверху ${topActivity()}) — нажатие «${sel}» некуда`);
  const p = await waitFor(() => point(sel, opts), opts.wait ?? 10000, 250);
  if (!p) throw new Error(`не найден для нажатия: ${sel}${opts.text ? ` «${opts.text}»` : ''}`);
  sh(`input tap ${p.x} ${p.y}`);
  await sleep(opts.after ?? 400);
  return p;
}
// Аниме, которое можно смотреть: первая строка каталога с вышедшими сериями («2 из 11 эп»). Первым в каталоге бывает
// анонс — без серий, без «Смотреть» и «Смотреть вместе» (тесты, открывавшие первую строку, падали от смены каталога)
export async function tapWatchable(opts = {}) {
  const index = await waitFor(async () => {
    const i = await js(`[...document.querySelectorAll('.release-row')].filter((e) => e.getClientRects().length && !e.closest('.skeleton, .sk-root'))
      .findIndex((e) => /(^|\\D)[1-9]\\d* из (\\d+|\\?) эп/.test(e.textContent))`);
    return i >= 0 ? i + 1 : null;
  }, opts.wait ?? 25000, 300);
  if (!index) throw new Error('в каталоге нет аниме с вышедшими сериями');
  return tap('.release-row', { ...opts, index: index - 1 });
}
export const key = async (k, after = 600) => { sh(`input keyevent ${k}`); await sleep(after); };
export const back = () => key(4, 900);
export async function typeText(s) { sh(`input text ${JSON.stringify(s.replace(/ /g, '%s'))}`); await sleep(400); }

// ---------- окно ----------
export function screenshot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${process.env.ANIX_SHOT_TAG ? `${process.env.ANIX_SHOT_TAG}-` : ''}${name}.png`);
  fs.writeFileSync(file, execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 }));
  return file;
}
export const topActivity = () => (/topResumedActivity=ActivityRecord\{\S+ \S+ (\S+)/.exec(sh('dumpsys activity activities')) || [])[1] || '';
export const rotation = () => Number((/mCurrentRotation=(?:ROTATION_)?(\d+)/.exec(sh('dumpsys display')) || /rotation=(\d)/.exec(sh('dumpsys window displays')) || [])[1] || 0);
// Состояние окна глазами приложения (MainActivity.Bridge.state): полосы, «экран не гаснет», ориентация, PiP
export const windowState = async () => JSON.parse(await js('anixAndroid.state()'));
// localStorage WebView пишет на диск с задержкой: перед перезапуском — как пользователь, свернуть и дождаться записи.
// Не пауза наугад (2 с под нагрузкой четырёх эмуляторов не хватало — «Пропустить версию» терялась): метка в
// localStorage, ждём её в файле на диске (run-as — тестовая сборка debuggable); записи до неё ушли вместе с ней
export async function persist() {
  const mark = `persist-${Date.now().toString(36)}`;
  await js(`(localStorage.setItem('anix.test.persist', ${JSON.stringify(mark)}), 1)`);
  sh('input keyevent 3');
  const onDisk = () => Number(sh(`run-as ${PKG} sh -c 'cat "app_webview/Default/Local Storage/leveldb/"*.log 2>/dev/null | grep -ac ${mark}' || true`).trim()) > 0;
  if (!(await waitFor(onDisk, 20000, 250))) throw new Error('localStorage не записался на диск за 20 с');
}
