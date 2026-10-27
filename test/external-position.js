'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Сторонний плеер (mpv) знает место в серии, как встроенный: серия из списка начинается с сохранённого места (спросить
// «Продолжить?» внутри mpv нечем), место по ходу просмотра сохраняется (server/index.js опрашивает mpv по каналу
// команд, player.js trackExternal забирает) — для «Продолжить» и синхронизации истории; досмотрели — «до конца»
// и событие закрытия плеера (страница аниме перерисует кнопку). mpv без окна и звука (свой MPV_HOME с vo=null).
// Запуск: npx electron test/external-position.js
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { start } = require('../server');
const settle = require('./_settle');

const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mpv = null;
try { mpv = execFileSync('where', ['mpv'], { encoding: 'utf8' }).split(/\r?\n/).find((p) => /\.exe$/i.test(p)) || null; } catch { /* нет */ }
if (!mpv && fs.existsSync('C:\\Program Files\\mpv\\mpv.exe')) mpv = 'C:\\Program Files\\mpv\\mpv.exe';

app.whenReady().then(async () => {
  if (!mpv) { console.log('SKIP [external-position] mpv не установлен'); app.exit(0); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anix-mpv-'));
  fs.writeFileSync(path.join(home, 'mpv.conf'), 'vo=null\nao=null\n');
  process.env.MPV_HOME = home; // mpv запускает локальный сервер этого процесса — окружение наследуется
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await settle(js, 5000);
  const clip = path.join(__dirname, 'fixtures', 'hls-video', 'index.m3u8'); // 20 с
  const ep = (pos) => js(`import('/js/store.js').then(({ db }) => db.getEpisode(21, 1, ${pos}))`);
  await js(`(async () => {
    const { prefs, db } = await import('/js/store.js');
    prefs.set('THIRD_PARTY_PLAYER_PATH', ${JSON.stringify(mpv)});
    db.putEpisode(21, 1, 3, { isWatched: true, playbackPosition: 8000, duration: 20000, savedAt: Date.now() - 60000 });
    window.__closed = 0; window.addEventListener('player-closed', (e) => { if (e.detail?.releaseId === 21) window.__closed++; });
    const { openThirdParty } = await import('/js/player.js');
    await openThirdParty({ releaseId: 21, sourceId: 1, position: 3, name: '3 серия' }, { id: 21, title_ru: 'Тест' }, { qualities: { '720p': ${JSON.stringify(clip)} } });
  })()`);
  // по ходу: место растёт от 0:08 (а не с начала)
  let mid = null;
  for (let i = 0; i < 30 && !mid; i++) { await sleep(500); const e = await ep(3); if (e.playbackPosition > 8000 && e.savedAt > Date.now() - 20000) mid = e; }
  check(!!mid && mid.playbackPosition >= 9000 && mid.playbackPosition < 19000, `mpv: место по ходу просмотра, с сохранённого 0:08 — ${mid ? mid.playbackPosition / 1000 : '—'} с`);
  // досмотрели (mpv закрылся в конце) — «до конца» и событие закрытия
  let end = null;
  for (let i = 0; i < 60 && !end; i++) { await sleep(500); if (await js('window.__closed') > 0) end = await ep(3); }
  check(!!end && end.playbackPosition === -1, `mpv досмотрен и закрылся — серия «до конца» (${end?.playbackPosition})`);
  srv.server.close();
  app.exit(fails.length ? 1 : 0);
});
