'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// «Картинка в картинке» в комнате совместного просмотра (два окна, настоящие брокеры, как party-watch.js):
//  • ✕ окна PiP (браузер ставит паузу, плеер снимает) — комнату не останавливает: ни у хоста, ни у гостя в режиме
//    «только хост», у гостя нет «Управляет только хост»;
//  • пауза кнопкой в окне PiP (окно остаётся открытым) — уходит всей комнате, как и раньше.
// ✕ имитируется: пауза и выход из PiP (так делает браузер). Звук окон выключен. electron test/party-pip.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RID = 21; // «Мастер Муси»: AniDUB (тип 1) → Kodik (источник 8)

app.whenReady().then(async () => {
  let bad = 0;
  const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };
  const srv = await start(0);
  const mk = async (name) => {
    const w = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: { partition: `party-pip-${name}-${process.pid}`, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    w.webContents.setAudioMuted(true);
    await w.loadURL(srv.url);
    await w.webContents.executeJavaScript(`window.__anixPartyTiming = { hostGone: 3000, gone: 10000, hb: 2500, ref: 2000 }`);
    return { w, js: (code) => w.webContents.executeJavaScript(code, true) }; // true — с жестом пользователя (PiP без него не открыть)
  };
  const A = await mk('a'); const B = await mk('b');
  await sleep(2500);
  const vid = `document.querySelector('.player-overlay video')`;
  const pos = (X) => X.js(`(() => { const v = ${vid}; return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState } : null; })()`);
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return false; };
  const roomPaused = () => A.js(`import('/js/party/room.js').then(({ party }) => !!party.room.state.paused)`);
  const notes = (X) => X.js(`[...document.querySelectorAll('.party-bubble')].map((x) => x.textContent).join(' | ')`);
  // ✕ окна PiP: браузер ставит паузу и закрывает окно
  const pipX = async (X) => {
    await X.js(`${vid}.requestPictureInPicture().then(() => 1)`);
    await waitFor(() => X.js(`document.pictureInPictureElement === ${vid}`), 3000);
    await sleep(500);
    await X.js(`${vid}.pause(); document.exitPictureInPicture(); 1`);
  };
  // пока идёт проверка — ни разу не пауза: ни в комнате, ни у второго окна
  const neverPaused = async (other, ms = 2500) => {
    const t0 = Date.now(); let seen = '';
    while (Date.now() - t0 < ms) {
      if (await roomPaused()) seen += ' комната';
      if ((await pos(other))?.paused) seen += ' второе окно';
      if (seen) return seen.trim();
      await sleep(100);
    }
    return '';
  };

  await A.js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/${RID}/1/8?sort=1')).json();
    window.__p = openBuiltinPlayer({ release: { id: ${RID}, title_ru: 'Мастер Муси' }, episodes: r.episodes, index: 4, sort: 1, typeId: 1, dub: 'AniDUB', startAt: 0 });
  })()`);
  await waitFor(async () => (await pos(A))?.ready >= 3, 25000);
  const code = await A.js(`import('/js/party/room.js').then(async ({ party }) => { await party.create(); return party.room.code; })`);
  await sleep(2500);
  await B.js(`import('/js/party/room.js').then(({ party }) => party.join(${JSON.stringify(code)}).then(() => true))`);
  check(await waitFor(async () => (await pos(B))?.ready >= 3, 30000), 'B открыл серию комнаты');
  await A.js(`import('/js/party/room.js').then(({ setControl }) => setControl('host'))`);
  await A.js(`${vid}.play().catch(() => {}); 1`);
  check(await waitFor(async () => { const [a, b] = [await pos(A), await pos(B)]; return a && b && !a.paused && !b.paused && !(await roomPaused()); }, 20000), 'серия идёт у обоих');
  await sleep(1500);

  // 1. ✕ в PiP у гостя (управляет только хост): комната не встаёт, подсказки нет, у гостя серия идёт
  const n0 = await notes(B);
  await pipX(B);
  const g = await neverPaused(A);
  check(!g, `✕ в PiP у гостя — комната не встала${g ? `: пауза — ${g}` : ''}`);
  check(await waitFor(async () => !(await pos(B))?.paused, 3000), 'у гостя после ✕ серия идёт');
  const n1 = await notes(B);
  check(!/Управляет только хост/.test(n1.slice(n0.length)), `у гостя нет «Управляет только хост»: «${n1.slice(n0.length)}»`);

  // 2. ✕ в PiP у хоста: комната и гость не встают
  await sleep(1000);
  await pipX(A);
  const hst = await neverPaused(B);
  check(!hst, `✕ в PiP у хоста — комната не встала${hst ? `: пауза — ${hst}` : ''}`);
  check(await waitFor(async () => !(await pos(A))?.paused, 3000), 'у хоста после ✕ серия идёт');

  // 3. Пауза кнопкой в окне PiP у хоста (окно открыто) — встаёт вся комната
  await A.js(`${vid}.requestPictureInPicture().then(() => 1)`);
  await waitFor(() => A.js(`document.pictureInPictureElement === ${vid}`), 3000);
  await sleep(500);
  await A.js(`${vid}.pause(); 1`);
  check(await waitFor(async () => (await roomPaused()) && (await pos(B))?.paused, 5000), 'пауза в окне PiP у хоста — пауза у всех');
  await A.js(`document.exitPictureInPicture(); 1`);

  console.log(bad ? `FAIL party-pip: ${bad}` : 'party-pip: all ok');
  srv.server.close();
  app.exit(bad ? 1 : 0);
});
