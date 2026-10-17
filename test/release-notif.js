require('./_failfast');
// «Уведомления о новых сериях» (колокольчик на странице релиза): в списке — озвучки этого релиза (как на экране
// серий), а не весь справочник type/all; включённая раньше озвучка, которой у релиза больше нет, — тоже в списке.
// Вход и настройки уведомлений подменены в странице: реальный аккаунт не нужен и не затрагивается.
// Запуск: npx electron test/release-notif.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');

const RID = 21;
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} ${what}`); if (!ok) failed++; };

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await settle(js, 4000);
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const until = async (fn, max = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { const v = fn(); if (v) return v; await sleep(50); } return null; };
    const { auth, A } = await import('/js/api.js');
    Object.defineProperty(auth, 'loggedIn', { get: () => true, configurable: true });
    const [own, all] = await Promise.all([A.types(${RID}).then((x) => x.types || []), A.types_all().then((x) => x.types || [])]);
    const gone = all.find((ty) => !own.some((o) => o.id === ty.id)); // включена раньше, у релиза её нет
    const of = window.fetch;
    window.fetch = async (...a) => {
      const u = String(a[0].url || a[0]);
      if (u.includes('profile/preference/notification/release/type/${RID}')) return new Response(JSON.stringify({ code: 0, types: [gone.id] }), { headers: { 'content-type': 'application/json' } });
      return of(...a);
    };
    (await import('/js/router.js')).navigate('release', { id: ${RID} });
    // колокольчик в шапке виден и во время загрузки, но работает, когда страница загрузилась
    await until(() => document.querySelector('.screen[data-screen="release"] .rel-title'));
    const bell = await until(() => document.querySelector('.screen[data-screen="release"] .appbar button[title="Уведомления о новых сериях"]'));
    if (!bell) return { err: 'нет колокольчика' };
    bell.click();
    const items = await until(() => { const d = document.querySelector('.dialog'); return d && d.textContent.includes('Уведомления о новых сериях') && d.querySelectorAll('.sheet-item').length ? [...d.querySelectorAll('.sheet-item')] : null; });
    if (!items) return { err: 'диалог не открылся' };
    const names = items.map((x) => x.textContent.trim());
    return { own: own.length, all: all.length, shown: names.length, ownShown: own.every((o) => names.includes(o.name)), goneShown: names.includes(gone.name), goneChecked: items[names.indexOf(gone.name)]?.querySelector('input').checked };
  })()`);
  if (r.err) check(false, r.err);
  else {
    check(r.own > 0 && r.all > r.own + 1, `у релиза ${r.own} озвучек из ${r.all} в справочнике`);
    check(r.shown === r.own + 1, `в диалоге ${r.shown} пунктов — озвучки релиза и одна включённая раньше (ожидалось ${r.own + 1})`);
    check(r.ownShown, 'все озвучки релиза в списке');
    check(r.goneShown && r.goneChecked, 'включённая раньше озвучка, которой у релиза нет, — в списке и отмечена');
  }
  console.log(failed ? `FAIL: ${failed}` : 'ALL OK');
  app.exit(failed ? 1 : 0);
});
