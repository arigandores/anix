'use strict';
require('./_failfast');
// Комната совместного просмотра: посмотрел серию ~2 минуты, вышел из плеера, открыл ТУ ЖЕ серию в ДРУГОЙ озвучке
// (из списка серий — без «откуда начать») — продолжается с той же секунды, а не с начала. Озвучка входит в ключ
// серии, поэтому раньше это считалось другой серией и начиналось с 0. Один участник, настоящие брокеры MQTT
// (как party.js), звук выключен. electron test/party-dub-resume.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RID = 21; // «Мастер Муси»: AniDUB (тип 1) → Kodik (источник 8); «Люб. Двухголосый» (тип 34) → Kodik (49)

app.whenReady().then(async () => {
  let bad = 0;
  const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };
  const srv = await start(0);
  const w = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: { partition: `party-dub-${process.pid}`, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  w.webContents.setAudioMuted(true);
  await w.loadURL(srv.url);
  const js = (c) => w.webContents.executeJavaScript(c, true);
  await js(`window.__anixPartyTiming = { hostGone: 3000, gone: 10000, hb: 2500, ref: 2000 }`);
  await sleep(2000);
  const vid = `document.querySelector('.player-overlay video')`;
  const pos = () => js(`(() => { const v = ${vid}; return v ? { t: v.currentTime, ready: v.readyState } : null; })()`);
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return false; };
  const open = (typeId, sourceId, dub, startAt) => js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/${RID}/${typeId}/${sourceId}?sort=1')).json();
    openBuiltinPlayer({ release: { id: ${RID}, title_ru: 'Мастер Муси' }, episodes: r.episodes, index: 4, sort: 1, typeId: ${typeId}, dub: '${dub}'${startAt === undefined ? '' : `, startAt: ${startAt}`} });
  })()`);

  // 5 серия AniDUB, комната — из плеера; досмотрели до ~2:00
  await open(1, 8, 'AniDUB', 0);
  check(await waitFor(async () => (await pos())?.ready >= 3, 30000), 'серия AniDUB открылась');
  await js(`import('/js/party/room.js').then(async ({ party }) => { await party.create(); return party.room.code; })`);
  await sleep(2500);
  await js(`(() => { const v = ${vid}; v.currentTime = 120; v.play().catch(() => {}); })()`);
  await waitFor(async () => (await pos())?.t > 121, 20000);
  await sleep(1500);
  const left = (await pos()).t;
  // вышли назад (плеер закрыт, из комнаты не вышли) и подождали, как если бы выбирали другую озвучку
  await js(`document.querySelector('.player-overlay .player-top button[title^="Закрыть"]')?.click(); 1`);
  await waitFor(async () => !(await pos()), 5000);
  await sleep(4000);

  // та же серия, другая озвучка — как из списка серий (startAt не задан)
  await open(34, 49, 'Люб. Двухголосый');
  if (process.env.TRACE) for (let i = 0; i < 24; i++) { console.log('trace', i * 500, await js(`import('/js/party/room.js').then(({ party }) => JSON.stringify({ room: party.room.state.content?.typeId, seq: party.room.state.seq, pos: Math.round(party.room.state.pos), chip: document.querySelector('.player-top .p-dub .lbl')?.textContent, t: Math.round(document.querySelector('.player-overlay video')?.currentTime || -1), n: document.querySelectorAll('.player-overlay').length }))`)); await sleep(500); }
  check(await waitFor(async () => (await pos())?.ready >= 1, 30000), 'серия в другой озвучке открылась');
  await waitFor(async () => (await pos())?.t > 5, 15000);
  const now = (await pos()).t;
  const room = await js(`import('/js/party/room.js').then(({ party }) => ({ pos: party.room.state.pos, typeId: party.room.state.content?.typeId }))`);
  check(room.typeId === 34, `в комнате — другая озвучка (тип ${room.typeId})`);
  check(Math.abs(now - left) < 6, `другая озвучка — с того же места: ушли на ${left.toFixed(1)} с, продолжилось с ${now.toFixed(1)} с`);
  // без комнаты — то же: другая озвучка той же серии из списка предлагает «Продолжить» с места прежней (было — с нуля)
  await js(`document.querySelector('.player-overlay .player-top button[title^="Закрыть"]')?.click(); 1`);
  await waitFor(async () => !(await pos()), 5000);
  await js(`import('/js/party/room.js').then(({ party }) => party.leave())`);
  await sleep(1500);
  const openIdx = (typeId, sourceId, dub, index) => js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/${RID}/' + ${typeId} + '/' + ${sourceId} + '?sort=1')).json();
    openBuiltinPlayer({ release: { id: ${RID}, title_ru: 'Мастер Муси' }, episodes: r.episodes, index: ${index}, sort: 1, typeId: ${typeId}, dub: '${dub}' });
  })()`);
  await openIdx(1, 8, 'AniDUB', 3);
  await waitFor(async () => (await pos())?.ready >= 1, 30000);
  // «Продолжить?» о прошлом просмотре этой серии (если был) — начать с начала
  await sleep(1500); await js(`[...document.querySelectorAll('.dialog .sheet-item')].find((b) => /начала/i.test(b.textContent))?.click(); 1`);
  await js(`(() => { const v = ${vid}; v.currentTime = 200; v.play().catch(() => {}); })()`);
  await waitFor(async () => (await pos())?.t > 201, 20000);
  const left2 = (await pos()).t;
  await js(`document.querySelector('.player-overlay .player-top button[title^="Закрыть"]')?.click(); 1`);
  await waitFor(async () => !(await pos()), 5000);
  await openIdx(34, 49, 'Люб. Двухголосый', 3);
  const asked = await waitFor(() => js(`[...document.querySelectorAll('.dialog .sheet-item')].some((b) => /Продолжить/i.test(b.textContent))`), 20000);
  check(asked, 'без комнаты: другая озвучка той же серии — «Продолжить?»');
  if (asked) {
    await js(`[...document.querySelectorAll('.dialog .sheet-item')].find((b) => /Продолжить/i.test(b.textContent)).click(); 1`);
    await sleep(1500);
    const t2 = (await pos())?.t || 0;
    check(Math.abs(t2 - left2) < 6, `без комнаты: «Продолжить» — с того же места (ушли на ${left2.toFixed(1)} с, продолжилось с ${t2.toFixed(1)} с)`);
  }
  console.log(bad ? `FAIL: ${bad}` : 'ALL OK');
  app.exit(bad ? 1 : 0);
});
