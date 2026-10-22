// Все тесты Android-приложения: сборка APK и тесты параллельно на нескольких эмуляторах (по умолчанию 4 —
// недостающие run-all запускает сам, пока идёт сборка, и гасит в конце; --keep — оставить для следующего прогона).
// node android/test/run-all.mjs [тест …] [--no-build] [--devices N] [--keep]
// ANDROID_SERIAL=<устройство> — всё по очереди на одном устройстве (телефон).
// Провал — строка FAIL или ненулевой код выхода; SKIP [что] причина — пропуск (бекенд недоступен и т. п.)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEmulators, adb, SHOTS } from './_device.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..', '..');
// [тест, таймаут в минутах, переменные окружения]
const SUITE = [
  ['bundle', 2], ['server', 5], ['launch', 5], ['features', 8], ['navigation', 10], ['watch', 10], ['pip', 8],
  ['links', 6], ['auth', 10], ['offline', 8], ['party', 8], ['update', 8], ['touch', 8], ['nav', 8], ['player-touch', 8], ['push', 8], ['extras', 8], ['editors', 8], ['home-ux', 8], ['layout', 25], ['layout', 25, { ANIX_FONT_SCALE: '1.3' }],
  ['layout', 25, { ANIX_LANDSCAPE: '1' }],
];
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--devices');
const tests = SUITE.filter(([n]) => !only.length || only.includes(n));
const label = ([name, , env = {}]) => name + (Object.keys(env).length ? ` (${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')})` : '');
const t0 = Date.now();

// длительность тестов прошлого прогона — самые долгие начинаются первыми (иначе в конце один долгий на одном устройстве)
const TIMINGS = path.join(SHOTS, '.timings.json');
let timings = {};
try { timings = JSON.parse(fs.readFileSync(TIMINGS, 'utf8')); } catch { /* первый прогон */ }

function runProc(cmd, argv, { env = {}, timeoutMs = 0, cwd = root } = {}) {
  return new Promise((done) => {
    const p = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, shell: process.platform === 'win32' && /\.bat$/.test(cmd) });
    let out = ''; let timedOut = false;
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; p.kill(); }, timeoutMs) : null;
    p.on('close', (code) => { if (timer) clearTimeout(timer); done({ code, out, timedOut }); });
  });
}

// устройства: одно (ANDROID_SERIAL) или эмуляторы — запускаются, пока идёт сборка
const single = process.env.ANDROID_SERIAL;
const want = single ? 1 : Math.max(1, Math.min(Number(opt('--devices') || process.env.ANIX_DEVICES || 4), tests.length));
const started = [];
const devicesReady = single ? Promise.resolve([single]) : startEmulators(want, { started });
devicesReady.catch(() => {}); // ошибка — ниже, после сборки

if (!args.includes('--no-build')) {
  console.log('== сборка APK');
  const gw = path.join(root, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const b = await runProc(gw, ['assembleDebug', '-q', '--warning-mode', 'none'], { cwd: path.join(root, 'android') });
  if (b.code !== 0) { console.log(b.out); console.log('FAIL сборка APK'); process.exit(1); }
}
let serials;
try { serials = await devicesReady; } catch (e) { console.log(`FAIL устройства: ${e.message}`); process.exit(1); }
console.log(`== устройства: ${serials.join(', ')} (${Math.round((Date.now() - t0) / 1000)} с с начала)`);

const queue = [...tests].sort((a, b) => (timings[label(b)] ?? b[1] * 10) - (timings[label(a)] ?? a[1] * 10));
const results = [];
async function worker(serial) {
  for (let test = queue.shift(); test; test = queue.shift()) {
    const [name, minutes, env = {}] = test;
    const lbl = label(test);
    const t = Date.now();
    const tag = Object.keys(env).length ? Object.values(env).join('-') : '';
    const r = await runProc(process.execPath, [path.join(dir, `${name}.mjs`)], { env: { ...env, ANDROID_SERIAL: serial, ANIX_SHOT_TAG: tag }, timeoutMs: minutes * 60000 });
    const lines = r.out.split('\n').map((l) => l.replace(/\r$/, ''));
    const fails = lines.filter((l) => l.startsWith('FAIL'));
    const skips = lines.filter((l) => l.startsWith('SKIP'));
    if (r.timedOut) fails.push(`FAIL таймаут ${minutes} мин`);
    const ok = r.code === 0 && !fails.length;
    const s = Math.round((Date.now() - t) / 1000);
    results.push({ label: lbl, ok, fails, skips, s });
    if (ok) timings[lbl] = s;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${lbl} — ${s} с [${serial}]${fails.length ? `\n${fails.map((f) => `     ${f}`).join('\n')}` : ''}`);
  }
}
await Promise.all(serials.map(worker));
try { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(TIMINGS, JSON.stringify(timings, null, 1)); } catch { /* не важно */ }

// устройства — в обычное состояние (шрифт, поворот после layout); запущенные здесь эмуляторы — погасить
const keep = args.includes('--keep');
await Promise.all(serials.map(async (serial) => {
  try {
    if (started.includes(serial) && !keep) adb('-s', serial, 'emu', 'kill');
    else await runProc(process.execPath, ['-e', "import('./android/test/_device.mjs').then(async (d) => { await d.ensureDevice(); process.exit(0); })"],
      { env: { ANDROID_SERIAL: serial, ANIX_FONT_SCALE: '', ANIX_LANDSCAPE: '' }, timeoutMs: 60000 });
  } catch { /* устройство уже закрыто */ }
}));

console.log(`\n== итог (${Math.round((Date.now() - t0) / 1000)} с, устройств: ${serials.length})`);
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.label} — ${r.s} с${r.skips.length ? `, пропусков: ${r.skips.length}` : ''}`);
const skipped = results.flatMap((r) => r.skips);
if (skipped.length) { console.log('\nпропущено:'); for (const s of skipped) console.log(`  ${s}`); }
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\nFAIL: ${bad.map((r) => r.label).join(', ')}` : '\nALL OK');
process.exit(bad.length ? 1 : 0);
