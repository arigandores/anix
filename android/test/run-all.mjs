// Все тесты Android-приложения по очереди: сборка APK, затем тесты на эмуляторе или телефоне (adb).
// node android/test/run-all.mjs [тест …] [--no-build]
// Провал — строка FAIL или ненулевой код выхода; SKIP [что] причина — пропуск (бекенд недоступен и т. п.)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '..', '..');
// [тест, таймаут в минутах, переменные окружения]
const SUITE = [
  ['bundle', 2], ['server', 5], ['launch', 5], ['features', 8], ['navigation', 10], ['watch', 10], ['pip', 8],
  ['links', 6], ['auth', 10], ['offline', 8], ['party', 8], ['update', 8], ['layout', 25], ['layout', 25, { ANIX_FONT_SCALE: '1.3' }],
  ['layout', 25, { ANIX_LANDSCAPE: '1' }],
];
const args = process.argv.slice(2);
const only = args.filter((a) => !a.startsWith('--'));
const tests = SUITE.filter(([n]) => !only.length || only.includes(n));

if (!args.includes('--no-build')) {
  console.log('== сборка APK');
  const gw = path.join(root, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  const b = spawnSync(gw, ['assembleDebug', '-q', '--warning-mode', 'none'], { cwd: path.join(root, 'android'), stdio: 'inherit', shell: process.platform === 'win32' });
  if (b.status !== 0) { console.log('FAIL сборка APK'); process.exit(1); }
}

const results = [];
for (const [name, minutes, env = {}] of tests) {
  const label = name + (Object.keys(env).length ? ` (${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')})` : '');
  console.log(`\n== ${label}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, `${name}.mjs`)], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: minutes * 60000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  process.stdout.write(out.split('\n').filter((l) => /^(FAIL|SKIP|OK)/.test(l)).join('\n') + '\n');
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  const skips = out.split('\n').filter((l) => l.startsWith('SKIP'));
  const ok = r.status === 0 && !fails.length;
  if (r.error) fails.push(`FAIL ${r.error.code === 'ETIMEDOUT' ? `таймаут ${minutes} мин` : r.error.message}`);
  results.push({ label, ok: ok && !r.error, fails, skips, s: Math.round((Date.now() - t0) / 1000) });
}

// устройство — в обычное состояние (шрифт, поворот после layout)
spawnSync(process.execPath, ['-e', "import('./android/test/_device.mjs').then(async (d) => { await d.ensureDevice(); process.exit(0); })"],
  { cwd: root, env: { ...process.env, ANIX_FONT_SCALE: '', ANIX_LANDSCAPE: '' }, stdio: 'ignore', timeout: 60000 });

console.log('\n== итог');
for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.label} — ${r.s} с${r.skips.length ? `, пропусков: ${r.skips.length}` : ''}`);
const skipped = results.flatMap((r) => r.skips);
if (skipped.length) { console.log('\nпропущено:'); for (const s of skipped) console.log(`  ${s}`); }
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\nFAIL: ${bad.map((r) => r.label).join(', ')}` : '\nALL OK');
process.exit(bad.length ? 1 : 0);
