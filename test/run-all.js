'use strict';
// Все основные тесты разом: параллельно, каждый Electron-тест в своём профиле (_isolated.js), логи — в test/logs.
// Тесты ждут загрузки экранов (_settle.js), а не фиксированные паузы. Плавность апскейла меряется рядом с другими:
// их скрытые окна рисуют раз в секунду и видеокарту почти не занимают.
//   node test/run-all.js            основной набор
//   node test/run-all.js e2e resume только перечисленные
//   -j N                            сколько тестов одновременно (по умолчанию 4)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron'); // в Node это путь к electron.exe

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(__dirname, 'logs');
// [имя, файл, движок, отдельно]; долгие — первыми, чтобы короткие заполняли места рядом с ними
const SUITE = [
  ['skeleton-match', 'skeleton-match.js', 'electron'],
  ['upscale', 'upscale.js', 'electron'],
  ['upscale-fallback', 'upscale-fallback.js', 'electron'], // без ускорения NVIDIA: старый драйвер, GTX, AMD (SwiftShader), зависшая проверка
  ['ui-audit', 'ui-audit.js', 'electron'],
  ['layout-audit', 'layout-audit.js', 'electron'],
  ['contrast', 'contrast.js', 'electron'],
  ['e2e', 'e2e.js', 'electron'],
  ['resume', 'resume.js', 'electron'],
  ['player-ind', 'player-ind.js', 'electron'],
  ['smoke', 'smoke.js', 'node'],
  // после остальных и один: два видеотеста одновременно делили бы видеокарту
  ['upscale-trt', 'upscale-trt.js', 'electron', true],
  ['upscale-trt-install', 'upscale-trt-install.js', 'electron', true], // установка кнопкой: скачивает 93 МБ
];
// провал — ненулевой код или явные признаки в выводе тестов
const FAILED = /\bFAIL\b|ERRORS: (?!none)|ISSUES: (?!none)|UnhandledPromiseRejection|^Error:/m;

const args = process.argv.slice(2);
const jIdx = args.indexOf('-j');
const jobs = jIdx >= 0 ? Number(args.splice(jIdx, 2)[1]) : 4;
const only = args.filter((a) => !a.startsWith('-'));
const tests = SUITE.filter(([name]) => !only.length || only.includes(name));
if (!tests.length) { console.log('нет таких тестов; есть:', SUITE.map((t) => t[0]).join(', ')); process.exit(2); }
fs.mkdirSync(LOGS, { recursive: true });

function run([name, file, engine]) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anix-test-${name}-`));
    const cmd = engine === 'node' ? process.execPath : electron;
    const argv = engine === 'node' ? [path.join(__dirname, file)] : [path.join(__dirname, '_isolated.js'), dir, path.join(__dirname, file)];
    const p = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' }, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += '\nFAIL: тайм-аут 10 мин'; p.kill(); }, 600000);
    p.on('close', (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(LOGS, `${name}.log`), out);
      fs.rm(dir, { recursive: true, force: true }, () => {});
      // шум Chromium в выводе не считаем провалом теста
      const clean = out.split('\n').filter((l) => !/^\[\d+:\d+\/|Electron Security Warning|Content-Security-Policy|this app to unnecessary|For more information|^https?:\/\//.test(l)).join('\n');
      const ok = code === 0 && !FAILED.test(clean);
      const sec = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(15)} ${sec.padStart(4)} с${ok ? '' : `  → test/logs/${name}.log`}`);
      resolve({ name, ok, sec, clean });
    });
  });
}

(async () => {
  const t0 = Date.now();
  const queue = tests.filter((t) => !t[3]);
  const results = [];
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
    while (queue.length) results.push(await run(queue.shift()));
  }));
  for (const t of tests.filter((x) => x[3])) results.push(await run(t));
  const bad = results.filter((r) => !r.ok);
  for (const r of bad) {
    console.log(`\n--- ${r.name} (последние строки) ---`);
    console.log(r.clean.trim().split('\n').slice(-15).join('\n'));
  }
  console.log(`\n${bad.length ? `ПРОВАЛЕНО: ${bad.map((r) => r.name).join(', ')}` : 'ВСЁ ПРОШЛО'} · ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  process.exit(bad.length ? 1 : 0);
})();
