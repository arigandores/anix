'use strict';
// Падение теста — сразу видно: необработанная ошибка (например, кнопки на странице нет и executeJavaScript упал)
// печатается как FAIL с текстом и завершает Electron, а не оставляет тест висеть до внешнего таймаута.
//   require('./_failfast');  — первой строкой теста
const { app } = require('electron');

function fail(kind, e) {
  const text = e && (e.stack || e.message) ? (e.stack || e.message) : (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
  console.log(`FAIL ${kind}: ${text}`);
  app.exit(1);
}
process.on('unhandledRejection', (e) => fail('ошибка в тесте', e));
process.on('uncaughtException', (e) => fail('исключение в тесте', e));
