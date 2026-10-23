'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Совместный просмотр — граничные случаи (через настоящие публичные MQTT-брокеры, звук окон выключен):
//   неверный код; ни одного доступного брокера; один брокер недоступен; «замёрзшее» соединение (сторож переподключает);
//   часы участника врут на 90 с; третий входит посреди серии; одновременные команды сходятся; режим «только хост»;
//   у участника серия не открывается (остальные стартуют через ≤10 с); HTML в чате — текстом; участник закрыл
//   приложение не выходя; вход в «мёртвую» комнату не перематывает вперёд. electron test/party-edge.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEAD = 'wss://127.0.0.1:9/mqtt'; // никто не слушает

app.whenReady().then(async () => {
  let bad = 0;
  const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };
  const srv = await start(0);
  const mk = async (name, { skew = 0, brokers = null } = {}) => {
    const w = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: { partition: `party-edge-${name}-${process.pid}`, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    w.webContents.setAudioMuted(true);
    w.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource|favicon|blocked/.test(e.message)) console.log(`[${name}] console error:`, e.message); });
    await w.loadURL(srv.url);
    const X = { w, name, js: (code) => w.webContents.executeJavaScript(code, true) };
    // тайминги протокола короче обычных (party/room.js, net.js): логика та же, ждать меньше
    await X.js(`window.__anixPartyTiming = { watchdog: 6000, connect: 5000, stale: 4000, hostGone: 3000, gone: 10000, hb: 2500, ref: 2000, confirmGone: 3000 }`);
    // часы этого участника врут на skew мс (Date.now — на него опирается синхронизация)
    if (skew) await X.js(`(() => { const real = Date.now.bind(Date); Date.now = () => real() + ${skew}; })()`);
    if (brokers) await X.js(`window.__anixPartyBrokers = ${JSON.stringify(brokers)}`);
    return X;
  };
  const R = (X, code) => X.js(`import('/js/party/room.js').then(async (m) => { ${code} })`);
  const vid = `document.querySelector('.player-overlay video')`;
  const pos = (X) => X.js(`(() => { const v = ${vid}; return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState } : null; })()`);
  const title = (X) => X.js(`document.querySelector('.player-top .ttl span')?.textContent || ''`);
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch { /* окно ещё не готово */ } await sleep(250); } return false; };
  const people = (X) => R(X, `return m.party.room ? m.present().length : 0;`);
  const join = (X, code) => R(X, `try { await m.party.join(${JSON.stringify(code)}); return 'ok'; } catch (e) { return 'ERR ' + e.message; }`);

  const A = await mk('a');
  await sleep(2000);

  // 1) неверный код
  check(/^ERR Неверный код/.test(await join(A, 'abc')), 'неверный код — понятная ошибка');
  // любой код в любом виде (с дефисами, строчными, ссылкой) читается как тот же — в том числе с буквой Q
  const codes = await A.js(`import('/js/party/net.js').then(({ newCode, normCode, fmtCode }) => { let bad = 0; for (let i = 0; i < 500; i++) { const c = newCode();
    for (const v of [c, fmtCode(c).toLowerCase(), 'https://arigandores.github.io/anix/watch/#' + c, 'https://arigandores.github.io/anix-desktop/watch/#' + c, 'anixdesktop://watch/' + c]) if (normCode(v) !== c) bad++; } return bad; })`);
  check(codes === 0, `500 случайных кодов во всех видах читаются без ошибок (несовпадений: ${codes})`);

  // 2) ни один брокер не доступен → ошибка, комнаты нет
  const N = await mk('n', { brokers: [DEAD, DEAD] });
  await sleep(1500);
  const t0 = Date.now();
  const nr = await R(N, `try { await m.party.create(); return 'ok'; } catch (e) { return 'ERR ' + e.message; }`);
  check(/^ERR Нет связи/.test(nr) && Date.now() - t0 < 9000 && !(await R(N, `return !!m.party.room;`)), `нет связи — ошибка за ${((Date.now() - t0) / 1000).toFixed(1)} с, комнаты нет`);
  N.w.destroy();

  // A создаёт комнату из плеера (1 серия)
  await A.js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/1/1/8?sort=1')).json();
    window.__p = openBuiltinPlayer({ release: { id: 1, title_ru: 'Котёнок Ти' }, episodes: r.episodes, index: 0, sort: 1, typeId: 1, dub: 'Тест' });
  })()`);
  await waitFor(async () => (await pos(A))?.ready >= 3);
  await A.js(`document.querySelector('.backdrop .sheet-item')?.click()`);
  const code = await R(A, `await m.party.create(); return m.party.room.code;`);
  await A.js(`${vid}.play().catch(() => {})`);

  // 3) B: один брокер из трёх недоступен, часы на 90 с впереди — всё равно синхронно
  const B = await mk('b', { skew: 90000, brokers: [DEAD, 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'] });
  await sleep(1500);
  check((await join(B, code)) === 'ok', 'один брокер недоступен — вход работает');
  check(await waitFor(async () => (await pos(B))?.ready >= 3 && !(await pos(B)).paused, 25000), 'B (часы +90 с) открыл серию и играет');
  await sleep(7000);
  let a = await pos(A); let b = await pos(B);
  check(Math.abs(a.t - b.t) < 0.4, `часы врут на 90 с — расхождение ${Math.abs(a.t - b.t).toFixed(2)} с`);

  // 4) C входит посреди серии
  const C = await mk('c');
  await sleep(1500);
  await join(C, code);
  check(await waitFor(async () => (await pos(C))?.ready >= 3 && !(await pos(C)).paused, 25000), 'C вошёл посреди серии и играет');
  await sleep(6000);
  a = await pos(A); const c = await pos(C);
  check(Math.abs(a.t - c.t) < 0.4 && a.t > 10, `C попал в нужное место: A ${a.t.toFixed(1)} с, C ${c.t.toFixed(1)} с`);
  check(await waitFor(async () => (await people(A)) === 3 && (await people(B)) === 3 && (await people(C)) === 3, 15000), 'все видят троих');

  // 5) одновременно: A пауза, B перемотка — у всех одинаковый итог
  await Promise.all([A.js(`${vid}.pause()`), B.js(`${vid}.currentTime = 100`)]);
  await sleep(4000);
  const st = await Promise.all([A, B, C].map((X) => R(X, `const s = m.party.room.state; return s.seq + ':' + s.cmd;`)));
  const ps = await Promise.all([A, B, C].map(pos));
  check(new Set(st).size === 1 && Math.max(...ps.map((p) => p.t)) - Math.min(...ps.map((p) => p.t)) < 0.5 && new Set(ps.map((p) => p.paused)).size === 1,
    `одновременные команды сошлись: ${st[0]}, ${ps.map((p) => `${p.t.toFixed(1)}${p.paused ? '⏸' : '▶'}`).join(' ')}`);

  // 6) режим «только хост»: B не может ни пустить, ни перемотать, ни включить из очереди
  await R(A, `m.setControl('host');`);
  await waitFor(() => R(B, `return m.party.room.state.ctrl === 'host';`), 6000);
  await B.js(`document.querySelectorAll('.party-bubble').forEach((x) => x.remove())`);
  await A.js(`${vid}.pause()`); await sleep(1500);
  check(!(await B.js(`[...document.querySelectorAll('.party-bubble')].some((x) => x.textContent.includes('Управляет только хост'))`)), 'только хост: пауза хоста не показывает гостю «Управляет только хост»');
  const before = (await pos(A)).t;
  await B.js(`${vid}.currentTime = ${before + 200}`); await sleep(500); await B.js(`${vid}.play().catch(() => {})`);
  await sleep(3000);
  a = await pos(A); b = await pos(B);
  check(a.paused && Math.abs(a.t - before) < 1 && b.paused && Math.abs(b.t - before) < 1, 'только хост: перемотку и пуск B откатило, у A ничего не изменилось');
  await R(B, `m.queueAdd({ releaseId: 1, typeId: 1, sourceId: 8, position: 5, sort: 1, title: 'Котёнок Ти', image: '', dub: 'Тест', epName: '5 серия' });`);
  await waitFor(() => R(A, `return (m.party.room.state.queue || []).length === 1;`), 6000);
  await R(B, `m.queuePlay(m.party.room.state.queue[0].id);`); await sleep(2000);
  check(!/5 серия/.test(await title(A)) && (await R(A, `return m.party.room.state.queue.length;`)) === 1, 'только хост: предложить можно, включить из очереди — нет');
  await R(A, `m.setControl('all');`);

  // 6б) пропуск опенинга — настройка комнаты: включает хост, сам пропускает только его плеер, гостям — уведомление
  await R(A, `m.setRoomSkip('opening', true);`);
  check(await waitFor(() => R(B, `return m.roomSkip('opening');`), 6000), 'хост включил «Пропускать опенинг» — настройка дошла до гостей');
  check(await R(A, `return m.partySkipAuto('opening');`) && !(await R(B, `return m.partySkipAuto('opening');`)) && !(await R(C, `return m.partySkipAuto('opening');`)),
    'опенинг сам пропускает только плеер хоста (не у каждого по своей настройке)');
  check(await waitFor(() => B.js(`[...document.querySelectorAll('.party-bubble')].some((x) => x.textContent.includes('Опенинг теперь пропускается сам'))`), 4000), 'гостю пришло уведомление о настройке');
  await R(B, `m.setRoomSkip('opening', false);`); await sleep(1500);
  check(await R(A, `return m.roomSkip('opening');`), 'гость не может выключить пропуск — решает хост');
  await R(A, `m.setRoomSkip('opening', false);`);

  // 7) у C серия не открывается (парсер недоступен) → A и B стартуют следующую не позже ~10 с, у C — ошибка
  await C.js(`(() => { const f = window.fetch; window.fetch = (u, o) => (String(u).includes('/parse') ? Promise.reject(new Error('blocked')) : f(u, o)); })()`);
  const tn = Date.now();
  await A.js(`document.querySelector('.player-controls button[title^="Следующая серия"]').click()`);
  check(await waitFor(async () => /2 серия/.test(await title(A)) && /2 серия/.test(await title(B)) && !(await pos(A)).paused && !(await pos(B)).paused, 25000),
    `C не может открыть серию — A и B всё равно стартовали (${((Date.now() - tn) / 1000).toFixed(1)} с)`);
  check(/не удалось|ошибк|не получилось|cannot|невозможно/i.test(await C.js(`document.querySelector('.player-msg')?.textContent || ''`)), 'у C видно сообщение об ошибке');

  // 8) HTML в чате — просто текст
  await R(B, `m.sendChat('<img src=x onerror="window.__xss=1"><b>жирный</b>');`);
  await waitFor(() => R(A, `return m.party.room.chat.some((x) => x.text.includes('onerror'));`), 6000);
  await A.js(`document.querySelector('.party-panel') || document.querySelector('.player-top .party-btn').click()`); await sleep(500);
  check(await A.js(`[...document.querySelectorAll('.party-chat .msg')].some((x) => x.textContent.includes('onerror'))`), 'сообщение с HTML видно в чате');
  check(!(await A.js(`!!document.querySelector('.party-chat img, .party-chat b:not(:first-child)') || !!window.__xss`)), 'HTML в чате показан текстом');

  // 9) «замёрзшее» соединение: перестаём читать сокет одного брокера у A — сторож переподключает его
  const frozen = await A.js(`import('/js/party/room.js').then(({ party }) => { const l = party.room.net.links.find((x) => x.up); l.c.stream.pause(); window.__frozen = l; return l.url; })`);
  check(await waitFor(() => A.js(`window.__frozen.up && !window.__frozen.c.stream.isPaused?.()`), 20000), `замёрзший брокер (${frozen}) переподключён сторожем`);
  await B.js(`${vid}.pause()`);
  check(await waitFor(async () => (await pos(A)).paused, 8000), 'после переподключения команды доходят');

  // 9б) у живого хоста (A) оборвалось соединение с одним брокером — брокер шлёт его «последнюю волю», но A отзывается
  //     через остальные: из комнаты он не выпадает и права хоста не теряет
  const wasHost = await R(A, `return m.isHost();`);
  await A.js(`import('/js/party/room.js').then(({ party }) => { const l = party.room.net.links.find((x) => x.up); l.c.stream.destroy(); })`);
  await sleep(7000);
  check(wasHost && await R(A, `return m.isHost();`) && (await people(B)) === 3 && (await people(C)) === 3,
    'обрыв одного из трёх соединений у хоста — он остаётся в комнате и хостом');

  // 10) C закрыл приложение, не выходя из комнаты → остальные видят это за секунды (обрыв → «последняя воля» брокера)
  const tc = Date.now();
  C.w.close();
  check(await waitFor(async () => (await people(A)) === 2 && (await people(B)) === 2, 45000) && Date.now() - tc < 10000,
    `C закрыл приложение не выходя — остальные увидели уход за ${((Date.now() - tc) / 1000).toFixed(1)} с`);

  // 11) все ушли, D входит в «мёртвую» комнату спустя 20 с: серия на паузе на последнем месте, а не «досчитана» вперёд
  await A.js(`${vid}.play().catch(() => {})`); await sleep(3000);
  const last = (await pos(A)).t;
  // хост (A) выходит сам — сразу отдаёт права оставшемуся (B), не дожидаясь, пока его сочтут пропавшим
  const tl = Date.now();
  await R(A, `m.party.leave();`);
  check(await waitFor(() => R(B, `return m.isHost();`), 6000) && Date.now() - tl < 3000, `хост вышел — права у B за ${((Date.now() - tl) / 1000).toFixed(1)} с`);
  await R(B, `m.party.leave();`);
  await A.js(`window.__p.close()`); await B.js(`document.querySelector('.player-overlay')?.remove()`);
  await sleep(6000); // дольше «мёртвого» порога (stale)
  const D = await mk('d');
  await sleep(1500);
  await join(D, code);
  await waitFor(async () => (await pos(D))?.ready >= 3, 25000);
  await sleep(4000);
  const d = await pos(D);
  check(d && d.paused && Math.abs(d.t - last) < 8, `мёртвая комната: у D пауза на ${d && d.t.toFixed(1)} с (последнее место ≈ ${last.toFixed(1)} с)`);
  await R(D, `m.party.leave();`);

  await sleep(500);
  srv.server.close();
  console.log(bad ? `PARTY-EDGE FAIL: ${bad}` : 'PARTY-EDGE OK');
  app.exit(bad ? 1 : 0);
});
