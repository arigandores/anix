'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Синхронизация истории просмотра (public/js/sync.js ↔ cloud/sync): два «устройства» — окна с отдельными
// хранилищами — и настоящий сервер синхронизации локально (wrangler dev, вход «test:<pid>» без Anixart).
//  1. без входа — ни одного запроса к серверу, изменения копятся
//  2. первый вход — накопленное уходит в аккаунт
//  3. другое устройство: страница аниме — «Продолжить · 5 серия», озвучка и «ещё N мин»
//  4. настоящий плеер: ушли из приложения посреди воспроизведения (как закрытие окна / сворачивание телефона) —
//     место доходит до другого устройства без паузы и закрытия плеера
//  5. обе стороны изменили одну серию — у обеих побеждает более свежая
//  6. сервер недоступен и сервер «завис» (принял соединение и молчит) — ни ошибок на экране, ни зависаний;
//     потом догоняет
//  7. чужой токен — сервер не пускает, приложение больше не стучится
//  8. вход в другой аккаунт — чужая история ему не уходит
//  9. «не просмотрено» с сервера Anixart не стирает запущенную серию
// Запуск: npx electron test/sync.js (нужен cloud/sync/node_modules: cd cloud/sync && npm install)
const { app, BrowserWindow } = require('electron');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { start } = require('../server');
const settle = require('./_settle');

const RID = 21; // «Мастер Муси»: 26 серий
const PID = 777;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function waitFor(fn, ms, step = 200) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; }

const WRANGLER = path.join(__dirname, '..', 'cloud', 'sync', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

app.whenReady().then(async () => {
  if (!fs.existsSync(WRANGLER)) { console.log('SKIP [sync] нет cloud/sync/node_modules — cd cloud/sync && npm install'); app.exit(0); return; }
  // --- сервер синхронизации: локальный, своя пустая база ---
  const port = await freePort();
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'anix-sync-'));
  const wr = spawn(process.execPath.includes('electron') ? 'node' : process.execPath, [WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--var', 'TEST_AUTH:1', '--persist-to', persist, '--show-interactive-dev-session=false', '--log-level', 'info'],
  { cwd: path.join(__dirname, '..', 'cloud', 'sync'), shell: process.platform === 'win32', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  let log = '';
  wr.stdout.on('data', (d) => { log += d; }); wr.stderr.on('data', (d) => { log += d; });
  const killAll = () => { try { if (process.platform === 'win32') execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' }); else wr.kill('SIGKILL'); } catch { /* уже */ } };
  process.on('exit', killAll);
  const SYNC = `http://127.0.0.1:${port}`;
  const up = await waitFor(async () => { try { return (await fetch(`${SYNC}/v1/pull`)).status === 400; } catch { return false; } }, 90000, 500);
  if (!up) { console.log(log.slice(-2000)); check(false, 'сервер синхронизации запустился'); killAll(); app.exit(1); return; }
  const requests = () => (log.match(/(GET|POST) \/v1\//g) || []).length;
  const serverItems = async (pid) => { const r = await fetch(`${SYNC}/v1/pull?pid=${pid}&cursor=0:0:`, { headers: { 'X-Anix-Token': `test:${pid}` } }); return (await r.json()).releases || {}; };

  // «зависший» сервер: принимает соединение и молчит (как замёрзшее соединение у провайдера)
  const hung = net.createServer(() => { /* молчим */ }).listen(0, '127.0.0.1');
  await new Promise((ok) => hung.once('listening', ok));
  const HUNG = `http://127.0.0.1:${hung.address().port}`;
  const DEAD = `http://127.0.0.1:${await freePort()}`;

  const srv = await start(0);
  // --- два устройства ---
  const device = async (name) => {
    const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { partition: `sync-${name}-${Date.now()}`, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    win.webContents.on('dom-ready', () => win.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }'));
    await win.loadURL(srv.url);
    const js = (c) => win.webContents.executeJavaScript(c, true);
    await js(`localStorage.setItem('anixart.theme','dark'); localStorage.setItem('anixart.sync.url', ${JSON.stringify(SYNC)}); 1`);
    await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
    await settle(js, 6000);
    await js(`window.__anixSyncTiming = { quick: 200, push: 800, pullGap: 0, retry: 400, retryMax: 1500, timeout: 1500, leave: 2500 }; 1`);
    return { win, js };
  };
  const A = await device('a');
  const B = await device('b');
  const login = (d, pid) => d.js(`import('/js/api.js').then(({ auth }) => { auth.save('test:${pid}', { id: ${pid}, login: 'test${pid}' }); return 1; })`);
  const pullNow = (d) => d.js(`import('/js/sync.js').then((m) => m.syncPull({ force: true })).then(() => 1)`);
  const flushNow = (d) => d.js(`import('/js/sync.js').then((m) => m.flush()).then(() => 1)`);
  const ep = (d, pos) => d.js(`import('/js/store.js').then(({ db }) => db.getEpisode(${RID}, window.__src, ${pos}))`);

  // озвучка с Kodik и её серии — настоящие (как у resume-marks)
  const pick = await A.js(`(async () => {
    const { A } = await import('/js/api.js');
    for (const ty of (await A.types(${RID})).types) {
      const so = (await A.sources(${RID}, ty.id)).sources.find((s) => /kodik/i.test(s.name));
      if (so) return { typeId: ty.id, typeName: ty.name, sourceId: so.id, sourceName: so.name };
    }
    return null;
  })()`);
  if (!pick) { check(false, 'нашлась озвучка с Kodik'); killAll(); app.exit(1); return; }
  for (const d of [A, B]) await d.js(`window.__src = ${pick.sourceId}; 1`);

  // 1. без входа: смотрели 5-ю до 12:30 из 24:10 — ни одного запроса, изменения в очереди
  const before = requests();
  await A.js(`(async () => {
    const { db } = await import('/js/store.js');
    db.addLastWatched(${RID}, ${pick.typeId}, ${pick.sourceId}, 5, { typeName: ${JSON.stringify(pick.typeName)}, sourceName: ${JSON.stringify(pick.sourceName)} });
    db.putEpisode(${RID}, ${pick.sourceId}, 5, { isWatched: true, startedAt: Date.now() });
    db.putEpisode(${RID}, ${pick.sourceId}, 5, { isWatched: true, playbackPosition: 750000, duration: 1450000, savedAt: Date.now() });
    await window.__anixLeave();
  })()`);
  await sleep(1500);
  check(requests() === before, `без входа — ни одного запроса к серверу синхронизации (было ${before}, стало ${requests()})`);
  check(await A.js(`!!JSON.parse(localStorage.getItem('anixart.sync.dirty') || '{}')[${RID}]`), 'без входа — изменения ждут в очереди');

  // 2. вошли — накопленное ушло в аккаунт
  await login(A, PID);
  const got = await waitFor(async () => { const r = (await serverItems(PID))[RID]; return r?.last?.position === 5 && r.eps[`${pick.sourceId}:5`]?.playbackPosition === 750000 ? r : null; }, 10000);
  check(!!got, 'первый вход — история с устройства ушла в аккаунт (последняя серия и место)');
  check(await waitFor(() => A.js(`!JSON.parse(localStorage.getItem('anixart.sync.dirty') || '{}')[${RID}]`), 5000), 'отправленное снято с очереди');

  // 3. другое устройство со своей давней историей того же аниме (3-я серия неделю назад) входит после A: уходит только
  // 3-я (её на сервере нет); его старая последняя серия и полученное с A обратно не уходят. Страница аниме —
  // «Продолжить · 5 серия» с A, озвучка, «ещё 12 мин»
  await B.js(`(async () => {
    const { db } = await import('/js/store.js');
    db.addLastWatched(${RID}, ${pick.typeId}, ${pick.sourceId}, 3, { typeName: ${JSON.stringify(pick.typeName)}, sourceName: ${JSON.stringify(pick.sourceName)} });
    db.putEpisode(${RID}, ${pick.sourceId}, 3, { isWatched: true, playbackPosition: 600000, duration: 1450000, savedAt: Date.now() - 7 * 864e5 });
    const week = Date.now() - 7 * 864e5;
    const lw = JSON.parse(localStorage.getItem('anixart.db.lastWatched')); Object.assign(lw[${RID}], { at: week, timestamp: Math.floor(week / 1000) }); localStorage.setItem('anixart.db.lastWatched', JSON.stringify(lw));
    const eps = JSON.parse(localStorage.getItem('anixart.db.episodes')); eps['${RID}:${pick.sourceId}:3'].at = week; localStorage.setItem('anixart.db.episodes', JSON.stringify(eps));
    // что уходит на сервер — записываем
    window.__pushed = []; const of = window.fetch;
    window.fetch = function (u, o) { if (String(u).includes('/v1/push')) window.__pushed.push(JSON.parse(o.body).releases); return of.apply(this, arguments); };
  })()`);
  await login(B, PID); await settle(B.js, 5000); // вход сбрасывает вкладки — после этого открываем страницу
  await waitFor(() => B.js(`!JSON.parse(localStorage.getItem('anixart.sync.dirty') || '{}')[${RID}]`), 8000);
  const pushedB = await B.js(`window.__pushed`);
  const sentKeys = pushedB.flatMap((rels) => Object.values(rels).flatMap((r) => [...(r.last ? ['last'] : []), ...Object.keys(r.eps)]));
  check(sentKeys.length === 1 && sentKeys[0] === `${pick.sourceId}:3`, `вход после другого устройства — ушла только своя 3-я серия: [${sentKeys.join(', ')}]`);
  await B.js(`import('/js/router.js').then((m) => m.navigate('release', { id: ${RID} })); 1`);
  const scr = `document.querySelector('#viewport > .screen:last-child')`;
  const watchB = () => B.js(`(${scr}?.querySelector('.watch')?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const w3 = await waitFor(async () => { const w = await watchB(); return /Продолжить · 5 серия/.test(w) && w.includes(pick.typeName) ? w : null; }, 15000);
  check(!!w3 && /ещё 12 мин/.test(w3), `другое устройство: ${w3 || await watchB()}`);

  // 4. настоящий плеер на B: 6-я серия с 3:00, играет — уходим из приложения без паузы (закрытие окна на ПК вызывает
  // то же — __anixLeave; на телефоне — onStop). Место доходит до A
  await B.js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/${RID}/${pick.typeId}/${pick.sourceId}?sort=1')).json();
    window.__p = openBuiltinPlayer({ release: { id: ${RID}, title_ru: 'Мастер Муси' }, episodes: r.episodes, index: r.episodes.findIndex((e) => e.position === 6), sort: 1, typeId: ${pick.typeId}, dub: ${JSON.stringify(pick.typeName)}, startAt: 180000 });
  })()`);
  const playing = await waitFor(() => B.js(`(() => { const v = document.querySelector('.player-overlay video'); if (v && v.paused && v.readyState >= 2) v.play().catch(() => {}); return !!v && !v.paused && v.currentTime > 182; })()`), 40000, 500);
  check(!!playing, 'плеер: 6-я серия играет с 3:00');
  const tB = await B.js(`document.querySelector('.player-overlay video').currentTime`);
  await B.js(`window.__anixLeave().then(() => 1)`);
  await pullNow(A);
  const e6 = await waitFor(async () => { await pullNow(A); const e = await ep(A, 6); return e?.playbackPosition > 0 ? e : null; }, 8000, 400);
  check(!!e6 && Math.abs(e6.playbackPosition / 1000 - tB) < 3, `ушли из приложения посреди серии — место на другом устройстве: ${e6 ? (e6.playbackPosition / 1000).toFixed(1) : '—'} с (было ${tB.toFixed(1)} с)`);
  check(await A.js(`import('/js/store.js').then(({ db }) => db.lastWatched(${RID})?.position)`) === 6, 'последняя серия на другом устройстве — 6-я');
  await B.js(`window.__p?.close(); 1`);

  // 5. одна серия на обоих: A раньше, B позже — у обоих B
  await A.js(`import('/js/store.js').then(({ db }) => { db.putEpisode(${RID}, ${pick.sourceId}, 7, { isWatched: true, playbackPosition: 100000, duration: 1450000, savedAt: Date.now() }); return 1; })`);
  await sleep(50);
  await B.js(`import('/js/store.js').then(({ db }) => { db.putEpisode(${RID}, ${pick.sourceId}, 7, { isWatched: true, playbackPosition: 900000, duration: 1450000, savedAt: Date.now() }); return 1; })`);
  await flushNow(B); await flushNow(A); await pullNow(A); await pullNow(B);
  const [a7, b7] = [await ep(A, 7), await ep(B, 7)];
  check(a7?.playbackPosition === 900000 && b7?.playbackPosition === 900000, `конфликт: у обоих более свежее (A ${a7?.playbackPosition}, B ${b7?.playbackPosition})`);

  // 6. сервер недоступен / «завис»: ничего не висит и не показывается; потом догоняет
  const errsBefore = await B.js(`window.__errs = window.__errs || []; window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason))); window.__errs.length`);
  for (const [what, url] of [['недоступен', DEAD], ['завис', HUNG]]) {
    await B.js(`localStorage.setItem('anixart.sync.url', ${JSON.stringify(url)}); 1`);
    await B.js(`import('/js/store.js').then(({ db }) => { db.putEpisode(${RID}, ${pick.sourceId}, 8, { isWatched: true, playbackPosition: ${what === 'завис' ? 400000 : 300000}, duration: 1450000, savedAt: Date.now() }); return 1; })`);
    const t0 = Date.now();
    await B.js(`Promise.all([import('/js/sync.js').then((m) => Promise.all([m.flush(), m.syncPull({ force: true })])), window.__anixLeave()]).then(() => 1)`);
    const took = Date.now() - t0;
    check(took < 4000, `сервер ${what}: отправка, получение и уход не висят (${took} мс)`);
    check(await B.js(`!!JSON.parse(localStorage.getItem('anixart.sync.dirty') || '{}')[${RID}]`), `сервер ${what}: изменения остались в очереди`);
    check(await B.js(`!(document.getElementById('toast')?.textContent || '').trim() && !document.querySelector('.backdrop')`), `сервер ${what}: на экране ни уведомлений, ни окон`);
  }
  check(await B.js(`window.__errs.length`) === errsBefore, 'сбои сервера — без необработанных ошибок');
  // сервер снова доступен — догоняет сам (повтор по таймеру)
  await B.js(`localStorage.setItem('anixart.sync.url', ${JSON.stringify(SYNC)}); window.dispatchEvent(new Event('online')); 1`);
  const e8 = await waitFor(async () => { const r = (await serverItems(PID))[RID]; return r?.eps[`${pick.sourceId}:8`]?.playbackPosition === 400000; }, 10000);
  check(!!e8, 'сервер снова доступен — очередь ушла сама');

  // 7. чужой токен (профиль не его): сервер не пускает, приложение больше не стучится
  await B.js(`import('/js/api.js').then(({ auth }) => { auth.save('test:999', { id: ${PID}, login: 'чужой' }); return 1; })`);
  await sleep(1500);
  const r7 = requests();
  await B.js(`import('/js/store.js').then(({ db }) => { db.putEpisode(${RID}, ${pick.sourceId}, 9, { isWatched: true, startedAt: Date.now() }); return 1; })`);
  await pullNow(B); await flushNow(B); await sleep(1000);
  check(requests() === r7, `чужой токен — после отказа ни одного запроса (было ${r7}, стало ${requests()})`);

  // 8. A входит в другой аккаунт: история прежнего ему не уходит
  await login(A, 888);
  await sleep(2000);
  check(!(await serverItems(888))[RID], 'другой аккаунт — чужая история ему не ушла');

  // 9. «не просмотрено» с сервера Anixart не стирает запущенную серию (смотрели без входа / запрос не дошёл)
  const kept = await A.js(`(async () => {
    const { db } = await import('/js/store.js');
    const { mergeServerMarks } = await import('/js/screens/episodes.js');
    db.putEpisode(${RID}, ${pick.sourceId}, 10, { isWatched: true, startedAt: Date.now(), playbackPosition: 500000 });
    db.putEpisode(${RID}, ${pick.sourceId}, 11, { isWatched: true, markedAt: 1 });
    mergeServerMarks(${RID}, ${pick.sourceId}, [{ position: 10, is_watched: false }, { position: 11, is_watched: false }]);
    return { e10: db.getEpisode(${RID}, ${pick.sourceId}, 10), e11: db.getEpisode(${RID}, ${pick.sourceId}, 11) };
  })()`);
  check(kept.e10.isWatched && kept.e10.playbackPosition === 500000 && !kept.e11.isWatched, `«не просмотрено» с Anixart: запущенная осталась, просто отметка снята (${JSON.stringify({ e10: kept.e10.isWatched, e11: kept.e11.isWatched })})`);

  // 10. обновление приложения: вход уже был, история — в старом виде (без времени изменения at), синхронизации ещё не
  // было. Первый запуск новой версии сам отправляет историю; другое устройство видит «Продолжить · 4 серия»
  const C = await device('c');
  const day = Date.now() - 864e5;
  await C.js(`(() => {
    localStorage.setItem('anixart.token', 'test:555'); localStorage.setItem('anixart.profile', JSON.stringify({ id: 555, login: 'old' }));
    localStorage.setItem('anixart.db.lastWatched', JSON.stringify({ ${RID}: { releaseId: ${RID}, typeId: ${pick.typeId}, sourceId: ${pick.sourceId}, position: 4, typeName: ${JSON.stringify(pick.typeName)}, sourceName: ${JSON.stringify(pick.sourceName)}, timestamp: ${Math.floor(day / 1000)} } }));
    localStorage.setItem('anixart.db.episodes', JSON.stringify({ '${RID}:${pick.sourceId}:4': { releaseId: ${RID}, sourceId: ${pick.sourceId}, position: 4, playbackPosition: 300000, duration: 1450000, isWatched: true, savedAt: ${day}, startedAt: ${day - 60000} } }));
    localStorage.removeItem('anixart.sync.state'); localStorage.removeItem('anixart.sync.dirty');
  })()`);
  await new Promise((ok) => { C.win.webContents.once('did-finish-load', ok); C.win.webContents.reload(); });
  const up10 = await waitFor(async () => { const r = (await serverItems(555))[RID]; return r?.last?.position === 4 && r.eps[`${pick.sourceId}:4`]?.playbackPosition === 300000; }, 10000);
  check(!!up10, 'после обновления (вход уже был) — история в старом виде сама ушла в аккаунт');
  const D = await device('d');
  await login(D, 555); await settle(D.js, 5000); // вход сбрасывает вкладки (auth-changed → resetAllTabs) — после этого открываем страницу
  await D.js(`import('/js/router.js').then((m) => m.navigate('release', { id: ${RID} })); 1`);
  const w10 = await waitFor(async () => { const w = await D.js(`(${scr}?.querySelector('.watch')?.innerText || '').replace(/\\s+/g, ' ').trim()`); return /Продолжить · 4 серия/.test(w) ? w : null; }, 15000);
  check(!!w10 && /ещё 19 мин/.test(w10), `после обновления — другое устройство: ${w10 || await D.js(`JSON.stringify({ watch: (${scr}?.querySelector('.watch')?.innerText || '').replace(/\\s+/g, ' '), screen: (${scr}?.dataset.screen || '') + ': ' + (${scr}?.innerText || '').replace(/\\s+/g, ' ').slice(0, 300), last: localStorage.getItem('anixart.db.lastWatched'), state: localStorage.getItem('anixart.sync.state') })`)}`);

  hung.close(); srv.server.close(); killAll();
  app.exit(fails.length ? 1 : 0);
});
