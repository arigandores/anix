'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Совместный просмотр (public/js/party): два окна со своими профилями в одной комнате через настоящие публичные
// MQTT-брокеры. Второй участник входит по коду и сам открывает ту же серию; пауза, перемотка, пуск, скорость,
// следующая серия (с ожиданием всех) и чат доходят друг до друга, позиции совпадают; выход виден остальным.
// Звук окон выключен. Аккаунт Anixart не затрагивается. electron test/party.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let bad = 0;
  const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };
  const srv = await start(0);
  const mk = async (name) => {
    const w = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: { partition: `party-test-${name}-${process.pid}`, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    w.webContents.setAudioMuted(true);
    w.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource|favicon/.test(e.message)) console.log(`[${name}] console error:`, e.message); });
    await w.loadURL(srv.url);
    // тайминги протокола короче обычных (party/room.js, net.js): передача хоста и т. п. — за секунды
    await w.webContents.executeJavaScript(`window.__anixPartyTiming = { hostGone: 3000, gone: 10000, hb: 2500, ref: 2000 }`);
    return { w, js: (code) => w.webContents.executeJavaScript(code, true) };
  };
  const A = await mk('a'); const B = await mk('b');
  await sleep(2500);
  const vid = `document.querySelector('.player-overlay video')`;
  const pos = (X) => X.js(`(() => { const v = ${vid}; return v ? { t: v.currentTime, paused: v.paused, rate: v.playbackRate, ready: v.readyState, src: !!v.currentSrc } : null; })()`);
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return false; };
  const title = (X) => X.js(`document.querySelector('.player-top .ttl span')?.textContent || ''`);

  // A: открывает серию во встроенном плеере и создаёт комнату прямо из плеера
  await A.js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/1/1/8?sort=1')).json();
    window.__p = openBuiltinPlayer({ release: { id: 1, title_ru: 'Котёнок Ти' }, episodes: r.episodes, index: 0, sort: 1, typeId: 1, dub: 'Тест' });
  })()`);
  await waitFor(async () => (await pos(A))?.ready >= 3);
  await A.js(`document.querySelector('.backdrop .sheet-item')?.click()`); // «Продолжить?» — с начала
  await sleep(1000);
  const code = await A.js(`import('/js/party/room.js').then(async ({ party }) => { await party.create(); return party.room.code; })`);
  check(/^[0-9A-Z]{12}$/.test(code), `комната создана, код ${code}`);
  await sleep(2500);
  const aState = await A.js(`import('/js/party/room.js').then(({ party }) => party.room.state)`);
  check(aState?.content?.position === 1 && aState.content.sourceId === 8, 'серия A стала серией комнаты');

  // B: входит по коду (с дефисами, строчными) — серия комнаты открывается сама
  const t0 = Date.now();
  await B.js(`import('/js/party/room.js').then(({ party }) => party.join(${JSON.stringify(code.toLowerCase().replace(/(.{4})(?=.)/g, '$1-'))}).then(() => true))`);
  const joined = await waitFor(async () => (await pos(B))?.ready >= 3, 25000);
  check(joined, `B открыл серию комнаты сам (${((Date.now() - t0) / 1000).toFixed(1)} с)`);
  if (!joined) { // что со связью у каждого: брокеры, участники, состояние
    for (const [n, X] of [['A', A], ['B', B]]) console.log(n, await X.js(`import('/js/party/room.js').then(({ party, present }) => JSON.stringify({ links: party.room?.net?.links.map((l) => l.url.split('/')[2] + ':' + (l.up ? 'up' : 'down') + ':rx' + Math.round((Date.now() - l.lastRx) / 1000) + 's'), members: party.room && present().length, state: party.room?.state && { seq: party.room.state.seq, content: !!party.room.state.content } }))`));
  }
  check(/1 серия|^1/.test(await title(B)), `у B та же серия: «${await title(B)}»`);
  const people = async (X) => X.js(`import('/js/party/room.js').then(({ present }) => present().length)`);
  check(await waitFor(async () => (await people(A)) === 2 && (await people(B)) === 2, 15000), 'оба видят двух участников');

  const diff = async () => { const [a, b] = [await pos(A), await pos(B)]; return { d: Math.abs(a.t - b.t), a, b }; };
  // играют вместе
  await A.js(`${vid}.play().catch(() => {})`); await sleep(6000);
  let r = await diff(); console.log('вместе:', JSON.stringify(r));
  check(!r.a.paused && !r.b.paused && r.d < 0.3, `играют вместе, расхождение ${r.d.toFixed(2)} с`);

  // пауза у A → пауза у B на той же позиции
  await A.js(`${vid}.pause()`);
  check(await waitFor(async () => (await pos(B)).paused, 6000), 'пауза A дошла до B');
  const cards = (X) => X.js(`[...document.querySelectorAll('.party-bubble')].map((x) => x.textContent).join(' | ')`);
  check(await waitFor(async () => /Пауза/.test(await cards(B)), 4000), `у B карточка о паузе A: «${await cards(B)}»`);
  await sleep(800); r = await diff();
  check(r.d < 0.4, `на паузе позиции совпадают (${r.d.toFixed(2)} с)`);

  // перемотка у B → A там же
  await B.js(`${vid}.currentTime = 60`);
  check(await waitFor(async () => Math.abs((await pos(A)).t - 60) < 0.5, 8000), 'перемотка B на 1:00 дошла до A');
  check(await waitFor(async () => /Перемотка вперёд на \d+ с · 1:00/.test(await cards(A)), 4000), `у A карточка о перемотке B: «${await cards(A)}»`);

  // пуск у B, скорость ×1,5 у A
  await B.js(`${vid}.play().catch(() => {})`);
  check(await waitFor(async () => !(await pos(A)).paused, 6000), 'пуск B дошёл до A');
  await A.js(`${vid}.playbackRate = 1.5`);
  check(await waitFor(async () => Math.abs((await pos(B)).rate - 1.5) < 0.16, 8000), 'скорость ×1,5 у A дошла до B');
  await sleep(5000); r = await diff(); console.log('×1,5:', JSON.stringify(r));
  check(r.d < 0.5, `на ×1,5 расхождение ${r.d.toFixed(2)} с`);
  await A.js(`${vid}.playbackRate = 1`); await sleep(1500);

  // следующая серия у A → у B тоже, стартуют вместе после ожидания всех
  await A.js(`document.querySelector('.player-controls button[title^="Следующая серия"]').click()`);
  check(await waitFor(async () => /^2|2 серия/.test(await title(B)), 20000), `B переключился на следующую серию: «${await title(B)}»`);
  check(await waitFor(async () => { const [a, b] = [await pos(A), await pos(B)]; return a && b && !a.paused && !b.paused; }, 20000), 'после ожидания всех оба играют');
  await sleep(4000); r = await diff(); console.log('2 серия:', JSON.stringify(r));
  check(r.d < 0.5, `во 2 серии расхождение ${r.d.toFixed(2)} с`);

  // «Управлять могут все» несколько раз подряд во время серии — серия ни у кого не откатывается назад
  const t1 = (await pos(A)).t; const w0 = Date.now();
  for (let i = 0; i < 4; i++) { await A.js(`import('/js/party/room.js').then((m) => m.setControl(${i % 2 ? "'all'" : "'host'"}))`); await sleep(300); }
  await sleep(2500);
  { const el = (Date.now() - w0) / 1000; const [a2, b2] = [await pos(A), await pos(B)];
    check(a2.t >= t1 + el - 0.8 && b2.t >= t1 + el - 0.8, `переключатель управления 4 раза — без отката (A ${t1.toFixed(1)} → ${a2.t.toFixed(1)} с за ${el.toFixed(1)} с, B ${b2.t.toFixed(1)} с)`); }

  // несколько предложений в очередь подряд — тоже без отката
  const t2 = (await pos(A)).t; const w1 = Date.now();
  for (let i = 0; i < 4; i++) { await B.js(`import('/js/party/room.js').then((m) => { m.queueAdd({ releaseId: 1, typeId: 1, sourceId: 8, position: ${10 + i}, sort: 1, title: 'Котёнок Ти', image: '', dub: 'Тест', epName: '${10 + i} серия' }); })`); await sleep(250); }
  await sleep(2500);
  { const el = (Date.now() - w1) / 1000; const [a2, b2] = [await pos(A), await pos(B)];
    check(a2.t >= t2 + el - 0.8 && b2.t >= t2 + el - 0.8, `4 предложения подряд — без отката (A ${t2.toFixed(1)} → ${a2.t.toFixed(1)} с за ${el.toFixed(1)} с, B ${b2.t.toFixed(1)} с)`); }
  await A.js(`import('/js/party/room.js').then((m) => { for (const it of m.party.room.state.queue) m.queueRemove(it.id); })`);
  await sleep(1500);

  // чат
  await B.js(`import('/js/party/room.js').then(({ sendChat }) => sendChat('привет из B'))`);
  check(await waitFor(() => A.js(`import('/js/party/room.js').then(({ party }) => party.room.chat.some((m) => m.text === 'привет из B'))`), 6000), 'сообщение B дошло до A');

  // панель комнаты в плеере открывается и показывает код и участников
  // панель комнаты в плеере открыта сама — и у хоста, и у участника
  check(await A.js(`!!document.querySelector('.party-panel')`) && await B.js(`!!document.querySelector('.party-panel')`), 'панель комнаты в плеере открылась сама у обоих');
  check(!/null/.test(await B.js(`document.querySelector('.party-panel').textContent`)), 'в панели нет «null» (пустая очередь, не хост)');
  const panel = await A.js(`document.querySelector('.party-panel')?.textContent || ''`);
  check(panel.includes(code.match(/.{4}/g).join('-')) && /Участники · 2/.test(panel), 'панель в плеере: код и двое участников');

  await A.js(`document.querySelector('.party-panel .party-head .icon-btn').click()`);

  // панель у A закрыта — новое сообщение B всплывает: кто и что; клик открывает панель
  await sleep(400);
  await B.js(`import('/js/party/room.js').then(({ sendChat }) => sendChat('всплывашка от B'))`);
  check(await waitFor(() => A.js(`[...document.querySelectorAll('.party-bubble')].some((x) => x.textContent.includes('всплывашка от B') && x.textContent.includes('Гость'))`), 6000), 'сообщение в чат всплыло у A: имя и текст');
  await A.js(`document.querySelector('.party-bubble').click()`); await sleep(400);
  check(await A.js(`!!document.querySelector('.party-panel')`), 'клик по всплывашке открыл панель комнаты');

  // клик по аниме в «Сейчас» — страница аниме, а серия идёт дальше в мини-плеере
  await A.js(`document.querySelector('.party-panel .party-item.now').click()`); await sleep(2500);
  let nav = await A.js(`({ mini: document.querySelector('.player-overlay')?.classList.contains('mini'), playing: !document.querySelector('.player-overlay video').paused, release: !!document.querySelector('.btn-watch') })`);
  check(nav.mini && nav.playing && nav.release, `«Сейчас» → страница аниме, серия идёт в мини-плеере: ${JSON.stringify(nav)}`);
  // «Предложить следующее аниме» — вкладка «Главная» (не поиск), мини-плеер, плашка-подсказка
  await A.js(`document.querySelector('.player-overlay').mini(false)`); await sleep(300);
  await A.js(`document.querySelector('.party-panel') || document.querySelector('.player-top .party-btn').click()`); await sleep(400);
  await A.js(`document.querySelector('.party-panel .party-suggest').click()`); await sleep(2000);
  nav = await A.js(`import('/js/router.js').then((r) => ({ tab: r.currentTab(), search: !!document.querySelector('.search-screen, input[type=search]'), mini: document.querySelector('.player-overlay').classList.contains('mini'), playing: !document.querySelector('.player-overlay video').paused, banner: !!document.querySelector('.party-pick-banner') }))`);
  check(nav.tab === 'home' && nav.mini && nav.playing && nav.banner, `«Предложить следующее» → «Главная», мини-плеер, плашка: ${JSON.stringify(nav)}`);
  await A.js(`document.querySelector('.party-pick-banner .btn').click()`); await sleep(300);
  nav = await A.js(`({ banner: !!document.querySelector('.party-pick-banner'), mini: document.querySelector('.player-overlay').classList.contains('mini'), intent: null })`);
  check(!nav.banner && !nav.mini, `«Вернуться к просмотру»: плашка убрана, плеер развёрнут: ${JSON.stringify(nav)}`);
  if (await A.js(`!!document.querySelector('.party-panel')`)) await A.js(`document.querySelector('.party-panel .party-head .icon-btn').click()`);

  // Очередь «Дальше»: предлагают оба; порядок и чужое удаляет только хост (A), своё — автор
  const R = (X, code) => X.js(`import('/js/party/room.js').then((m) => { ${code} })`);
  const item = (pos) => `({ releaseId: 1, typeId: 1, sourceId: 8, position: ${pos}, sort: 1, title: 'Котёнок Ти', image: '', dub: 'Тест', epName: '${pos} серия' })`;
  const queueOf = (X) => R(X, `return (m.party.room.state.queue || []).map((x) => x.content.position + ':' + x.byName);`);
  await R(B, `m.queueAdd(${item(3)});`); await sleep(400);
  await R(A, `m.queueAdd(${item(4)});`);
  check(await waitFor(async () => (await queueOf(A)).length === 2 && (await queueOf(B)).length === 2, 8000), `очередь у обоих: ${JSON.stringify(await queueOf(B))}`);
  const qid = async (X, pos) => (await R(X, `return m.party.room.state.queue.find((x) => x.content.position === ${pos}).id;`));
  await R(A, `m.queueMove(${JSON.stringify(await qid(A, 4))}, 0);`);
  check(await waitFor(async () => (await queueOf(B))[0]?.startsWith('4:'), 8000), 'хост поменял порядок — у B тоже');
  await R(B, `m.queueMove(${JSON.stringify(await qid(B, 3))}, 0); m.queueRemove(${JSON.stringify(await qid(B, 4))});`);
  await sleep(1500);
  check((await queueOf(A)).join() === (await queueOf(B)).join() && (await queueOf(A))[0]?.startsWith('4:') && (await queueOf(A)).length === 2, 'не хост не меняет порядок и не удаляет чужое');
  await R(B, `m.queueRemove(${JSON.stringify(await qid(B, 3))});`);
  check(await waitFor(async () => (await queueOf(A)).length === 1, 8000), 'своё предложение B убрал сам');
  await R(A, `m.queuePlay(${JSON.stringify(await qid(A, 4))});`);
  check(await waitFor(async () => /4 серия/.test(await title(A)) && /4 серия/.test(await title(B)), 25000), `«Включить» из очереди — у обоих 4 серия (A «${await title(A)}», B «${await title(B)}»)`);
  check(await waitFor(async () => { const [a, b] = [await pos(A), await pos(B)]; return a && b && !a.paused && !b.paused; }, 20000), 'после ожидания всех оба играют 4 серию');
  check((await queueOf(A)).length === 0, 'включённое ушло из очереди');

  // Другая озвучка (как и другое аниме) из очереди — в том же окне плеера, без закрытия и открытия нового
  // `; 0` — не возвращать DOM-элемент: Electron 45 не клонирует его в ответ executeJavaScript (раньше отдавал {})
  await A.js(`window.__ov = document.querySelector('.player-overlay'); 0`); await B.js(`window.__ov = document.querySelector('.player-overlay'); 0`);
  await R(B, `m.queueAdd({ releaseId: 1, typeId: 17, sourceId: 17, position: 2, sort: 1, title: 'Котёнок Ти', image: '', dub: 'SHIZA Project', epName: '2 серия' });`);
  await waitFor(async () => (await queueOf(A)).length === 1, 8000);
  await R(A, `m.queuePlay(m.party.room.state.queue[0].id);`);
  check(await waitFor(async () => { const [a, b] = [await pos(A), await pos(B)]; return /2 серия/.test(await title(A)) && /2 серия/.test(await title(B)) && a && b && !a.paused && !b.paused; }, 30000),
    'другая озвучка из очереди играет у обоих');
  const same = await Promise.all([A, B].map((X) => X.js(`document.querySelectorAll('.player-overlay').length === 1 && document.querySelector('.player-overlay') === window.__ov`)));
  check(same.every(Boolean), 'плеер тот же — не закрывался и не открывался заново');
  check(await R(A, `return m.party.room.player.ctl.content().typeId === 17;`), 'в плеере теперь озвучка SHIZA Project');

  // Мини-плеер: свернули — серия идёт и синхронизируется; панель плеера спрятана
  await A.js(`document.querySelector('.player-overlay').mini(true)`);
  await sleep(500);
  const mini = await A.js(`(() => { const ov = document.querySelector('.player-overlay'); const r = ov.getBoundingClientRect(); return { mini: ov.classList.contains('mini'), w: r.width, h: r.height, controls: getComputedStyle(ov.querySelector('.player-controls')).display }; })()`);
  check(mini.mini && mini.w <= 420 && mini.h < 260 && mini.controls === 'none', `мини-плеер в углу: ${JSON.stringify(mini)}`);
  await B.js(`${vid}.pause()`);
  check(await waitFor(async () => (await pos(A)).paused, 6000), 'пауза B дошла до свёрнутого плеера A');
  await B.js(`${vid}.play().catch(() => {})`); await sleep(3000);
  r = await diff(); check(!r.a.paused && r.d < 0.5, `в мини-плеере синхронно (${r.d.toFixed(2)} с)`);
  await A.js(`document.querySelector('.player-overlay').mini(false)`);

  // Хост уходит → хостом становится B (самый давний из оставшихся)
  // Качество у каждого своё: B меняет его у себя — комнате это не команда (никакой паузы и отката у A)
  await A.js(`document.querySelector('.party-panel') && document.querySelector('.party-panel .party-head .icon-btn').click()`);
  await B.js(`document.querySelector('.party-panel') && document.querySelector('.party-panel .party-head .icon-btn').click()`);
  await A.js(`${vid}.play().catch(() => {})`); await sleep(2500);
  const seqQ = await A.js(`import('/js/party/room.js').then((m) => m.party.room.state.seq)`);
  const qch = await B.js(`(() => { document.querySelector('.player-controls .gear').click(); const row = [...document.querySelectorAll('.player-menu .pm-row')].find((x) => x.textContent.startsWith('Качество')); row.click();
    const other = [...document.querySelectorAll('.player-menu .pm-opt')].find((o) => !o.classList.contains('on')); if (!other) return null; const t = other.textContent; other.click(); return t; })()`);
  let aStopped = false; for (let i = 0; i < 10; i++) { await sleep(400); if ((await pos(A)).paused) aStopped = true; }
  await sleep(2000);
  { const [a2, b2] = [await pos(A), await pos(B)]; const sent = (await A.js(`import('/js/party/room.js').then((m) => m.party.room.state.seq)`)) - seqQ;
    check(qch == null || (!aStopped && sent === 0 && !a2.paused && !b2.paused && Math.abs(a2.t - b2.t) < 0.6), `B сменил качество на ${qch} — у A без паузы и отката, команд комнате: ${sent}, расхождение ${Math.abs(a2.t - b2.t).toFixed(2)} с`); }

  // «Сделать хостом»: A отдаёт права B — у B всплывает «Вы теперь хост», у A кнопки хоста пропадают; и обратно
  const isHostOf = (X) => X.js(`import('/js/party/room.js').then(({ isHost }) => isHost())`);
  const popup = (X) => X.js(`[...document.querySelectorAll('.party-bubble')].some((x) => x.textContent.includes('Вы теперь хост'))`);
  await A.js(`document.querySelector('.party-panel') || document.querySelector('.player-top .party-btn').click()`); await sleep(400);
  const gh = await A.js(`(() => { const b = document.querySelector('.party-panel .give-host').getBoundingClientRect(); const v = document.querySelector('.party-panel .party-view');
    return { w: Math.round(b.width), inside: b.right <= v.getBoundingClientRect().right + 1, hscroll: v.scrollWidth > v.clientWidth, names: [...document.querySelectorAll('.party-panel .party-member .grow')].map((x) => x.textContent) }; })()`);
  check(gh.w < 160 && gh.inside && !gh.hscroll, `«Сделать хостом» — компактная, в пределах панели: ${JSON.stringify(gh)}`);
  check(!gh.names.some((n) => /^Участник/.test(n)), `у участников настоящие имена: ${gh.names.join(', ')}`);
  await A.js(`document.querySelector('.party-panel .give-host').click()`);
  check(await waitFor(async () => (await isHostOf(B)) && !(await isHostOf(A)), 6000), 'кнопка «Сделать хостом» — права у B');
  check(await waitFor(() => popup(B), 4000), 'у B всплыло «Вы теперь хост комнаты»');
  check(!(await A.js(`!!document.querySelector('.party-panel .give-host')`)), 'у A больше нет кнопок хоста');
  await B.js(`import('/js/party/room.js').then(({ giveHost, present }) => giveHost(present().find((p) => !p.me).id))`);
  check(await waitFor(async () => (await isHostOf(A)) && (await popup(A)), 6000), 'B вернул права — у A «Вы теперь хост»');

  // Хост закрыл приложение, не выходя из комнаты → права у B за пару секунд
  const th = Date.now();
  A.w.close();
  check(await waitFor(async () => (await people(B)) === 1, 15000), 'выход A виден B');
  check(await waitFor(() => isHostOf(B), 15000) && Date.now() - th < 8000, `хост закрыл приложение — хостом стал B за ${((Date.now() - th) / 1000).toFixed(1)} с`);

  await B.js(`import('/js/party/room.js').then(({ party }) => party.leave())`);
  await sleep(500);
  srv.server.close();
  console.log(bad ? `PARTY FAIL: ${bad}` : 'PARTY OK');
  app.exit(bad ? 1 : 0);
});
