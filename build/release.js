'use strict';
// Сборка файла релиза в release\: AnixDesktop-Setup-<v>.exe (electron-builder, NSIS). Portable не выпускается:
// он при каждом запуске распаковывал бы ~200 МБ во временную папку, а установщику права администратора не нужны.
// Версия для браузера отдельно не собирается — это архив «Source code» релиза на GitHub.
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
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', 'nsis', '--x64'], { cwd: root, stdio: 'inherit' });
} finally {
  if (fs.existsSync(parked)) fs.renameSync(parked, keysFile);
}

console.log(`\nФайл релиза (${withKeys ? 'с ключами из config.local.json' : 'без ключей'}):`);
for (const f of [`AnixDesktop-Setup-${version}.exe`]) {
  const p = path.join(out, f);
  console.log(`  ${f}  ${fs.existsSync(p) ? `${(fs.statSync(p).size / 1048576).toFixed(1)} МБ` : 'НЕТ'}`);
}
