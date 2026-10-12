'use strict';
// Сборка всех файлов релиза в release\:
//   AnixDesktop-Setup-<v>.exe, AnixDesktop-Portable-<v>.exe   — electron-builder (NSIS и portable)
//   AnixDesktop-<v>-win-x64.zip                               — портативная папка (release\win-unpacked)
//   AnixDesktop-Browser-<v>.zip                               — версия для браузера (server + public, нужен Node.js)
// Запуск: npm run build:release. Загрузка в GitHub Release — вручную (gh release create).
// config.local.json (ключи источников и соцвхода) попадает в сборку, если есть; --no-keys — собрать без него.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'release');
const { version } = require('../package.json');
const keysFile = path.join(root, 'config.local.json');
const noKeys = process.argv.includes('--no-keys');
const withKeys = !noKeys && fs.existsSync(keysFile);
const parked = `${keysFile}.parked`;

// electron-builder берёт config.local.json по списку files; для --no-keys файл на время убирается
if (noKeys && fs.existsSync(keysFile)) fs.renameSync(keysFile, parked);
try {
  // CLI electron-builder напрямую через Node — без npx и shell
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', 'portable', '--x64'], { cwd: root, stdio: 'inherit' });
} finally {
  if (fs.existsSync(parked)) fs.renameSync(parked, keysFile);
}

const pkg = path.join(out, 'pkg');
const app = path.join(pkg, 'AnixDesktop');
const browser = path.join(pkg, 'AnixDesktop-Browser');
fs.rmSync(pkg, { recursive: true, force: true });
fs.cpSync(path.join(out, 'win-unpacked'), app, { recursive: true });
fs.mkdirSync(browser, { recursive: true });
const items = ['public', 'server', 'README.md', 'LICENSE', 'NOTICE.md', 'package.json', 'config.example.json', 'start-browser.bat'];
if (withKeys) items.push('config.local.json');
const skipLocal = (src) => !src.split(path.sep).includes('.impeccable'); // локальные заметки, не в git
for (const item of items) fs.cpSync(path.join(root, item), path.join(browser, item), { recursive: true, filter: skipLocal });

// zip системным bsdtar Windows (tar.exe из System32 понимает -a по расширению .zip)
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
for (const [dir, name] of [['AnixDesktop', `AnixDesktop-${version}-win-x64.zip`], ['AnixDesktop-Browser', `AnixDesktop-Browser-${version}.zip`]]) {
  const file = path.join(out, name);
  fs.rmSync(file, { force: true });
  if (process.platform === 'win32') execFileSync(tar, ['-a', '-c', '-f', file, dir], { cwd: pkg, stdio: 'inherit' });
  else execFileSync('zip', ['-qr', file, dir], { cwd: pkg, stdio: 'inherit' });
}

console.log(`\nФайлы релиза (${withKeys ? 'с ключами из config.local.json' : 'без ключей'}):`);
for (const f of [`AnixDesktop-Setup-${version}.exe`, `AnixDesktop-Portable-${version}.exe`, `AnixDesktop-${version}-win-x64.zip`, `AnixDesktop-Browser-${version}.zip`]) {
  const p = path.join(out, f);
  console.log(`  ${f}  ${fs.existsSync(p) ? `${(fs.statSync(p).size / 1048576).toFixed(1)} МБ` : 'НЕТ'}`);
}
