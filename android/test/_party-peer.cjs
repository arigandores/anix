'use strict';
// Второй участник для android/test/party.mjs — приложение для ПК (скрытое окно Electron) в комнате телефона:
// входит по коду, печатает события строками JSON (вошёл, сколько участников, пришло сообщение), отвечает в чат.
// npx electron android/test/_party-peer.cjs <код>
const { app, BrowserWindow } = require('electron');
const { start } = require('../../server');

const code = process.argv.find((a) => /^[0-9A-Za-z-]{12,16}$/.test(a));
const say = (o) => console.log(`PEER ${JSON.stringify(o)}`);
setTimeout(() => { say({ timeout: true }); app.exit(0); }, 120000);

app.whenReady().then(async () => {
  const srv = await start(0);
  const w = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { partition: `party-peer-${process.pid}`, backgroundThrottling: false } });
  w.webContents.setAudioMuted(true);
  await w.loadURL(srv.url);
  const js = (s) => w.webContents.executeJavaScript(s, true);
  await new Promise((ok) => setTimeout(ok, 2500));
  await js(`import('/js/party/room.js').then(({ party }) => party.join(${JSON.stringify(code)})).then(() => true)`); // результат — простым значением: объект Electron не перешлёт
  say({ joined: true });
  await js(`import('/js/party/room.js').then(({ party }) => { party.on((type, m) => { if (type === 'chat') window.__chat = (window.__chat || []).concat(m.text); }); return true; })`);
  let replied = false; let lastCount = 0;
  for (;;) {
    const st = await js(`import('/js/party/room.js').then(({ party, present }) => ({ in: !!party.room, members: party.room ? present().length : 0, chat: window.__chat || [] }))`);
    if (st.members !== lastCount) { lastCount = st.members; say({ members: st.members }); }
    if (!st.in) { say({ left: true }); break; }
    const got = st.chat.find((t) => /phone-hello/.test(t));
    if (got && !replied) {
      replied = true; say({ chat: got });
      await js(`import('/js/party/room.js').then(({ sendChat }) => sendChat('pc-hello')).then(() => true)`);
    }
    if (st.chat.some((t) => /phone-bye/.test(t))) { say({ bye: true }); break; }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  await js(`import('/js/party/room.js').then(({ party }) => party.room ? party.leave().then(() => true) : true)`).catch(() => {});
  app.exit(0);
});
