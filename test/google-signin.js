'use strict';
// Пускает ли Google окно соцвхода: вводим несуществующий адрес и смотрим ответ.
// «This browser or app may not be secure» — окно распознано как встроенный браузер (ошибка);
// «Couldn't find your Google Account» / поле пароля — браузер принят. Нужны ключи social.google в конфиге.
const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// свой профиль: не конфликтует с запущенным приложением (один экземпляр на профиль)
app.setPath('userData', path.join(os.tmpdir(), `anix-test-${Date.now()}`));
require('../electron/main.js');

app.whenReady().then(async () => {
  let main;
  for (let i = 0; i < 60 && !main; i++) { await sleep(400); main = BrowserWindow.getAllWindows()[0]; }
  await sleep(3000);
  const req = await main.webContents.executeJavaScript(`fetch('/social/request?provider=google').then(r=>r.json())`, true);
  if (req.error) { console.log('FAIL', req.error); app.exit(1); return; }
  main.webContents.executeJavaScript(`window.anixartNative.socialAuth(${JSON.stringify({ ...req, provider: 'google' })}); 1`, true);
  let g;
  for (let i = 0; i < 40 && !g; i++) { await sleep(300); g = BrowserWindow.getAllWindows().find((w) => w !== main && !w.isDestroyed()); }
  const text = () => g.webContents.executeJavaScript('document.body ? document.body.innerText : ""').catch(() => '');
  for (let i = 0; i < 40 && !(await g.webContents.executeJavaScript('!!document.querySelector("input[type=email]")').catch(() => false)); i++) await sleep(500);
  const hints = await g.webContents.executeJavaScript('JSON.stringify({ ua: navigator.userAgent, uaData: !!navigator.userAgentData })');
  console.log('page:', hints);
  await g.webContents.executeJavaScript(`(() => { const i = document.querySelector('input[type=email]'); i.focus(); return 1; })()`);
  g.webContents.insertText(`anixdesktop.signin.check.${Date.now()}@gmail.com`);
  await sleep(500);
  g.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  g.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  let verdict = 'TIMEOUT';
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const t = await text();
    if (/may not be secure|Couldn.t sign you in|небезопасн|Не удалось войти/i.test(t)) { verdict = 'BLOCKED'; break; }
    if (/Couldn.t find your Google Account|Не удалось найти аккаунт|password|парол/i.test(t)) { verdict = 'ACCEPTED'; break; }
  }
  console.log(verdict, '::', (await text()).replace(/\s+/g, ' ').slice(0, 160));
  app.exit(verdict === 'ACCEPTED' ? 0 : 1);
});
