'use strict';
// Запуск теста в своём профиле Electron (для run-all.js): параллельные тесты не делят кэш и хранилище.
//   electron test/_isolated.js <профиль> <тест.js> [аргументы теста]
const { app } = require('electron');
const path = require('path');
const [dir, test, ...rest] = process.argv.slice(2);
app.setPath('userData', dir);
process.argv.splice(2, process.argv.length, ...rest); // тест видит только свои аргументы
// тест не загрузился (синтаксическая ошибка) — сразу FAIL, а не окно Electron, висящее до таймаута
try { require(path.resolve(test)); } catch (e) { console.log(`FAIL тест не загрузился: ${e && (e.stack || e.message) || e}`); app.exit(1); }
