'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Переключатели плеера в комнате совместного просмотра (два окна, настоящие брокеры, как party.js):
//  • «управлять могут все»: гость меняет озвучку — она меняется у всех, с того же места; плеер в комнате — только встроенный;
//  • «только хост»: у гостя озвучка неактивна, серия из сетки уходит в очередь «Дальше», а не включается.
// Звук окон выключен. Аккаунт Anixart не затрагивается. electron test/party-watch.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RID = 21; // «Мастер Муси»: AniDUB (тип 1) → Kodik (источник 8); «Люб. Двухголосый» — тип 34

app.whenReady().then(async () => {
  let bad = 0;
  const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };
  const srv = await start(0);
  const mk = async (name) => {
    const w = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: { partition: `party-watch-${name}-${process.pid}`, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    w.webContents.setAudioMuted(true);
    w.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource|favicon/.test(e.message)) console.log(`[${name}] console error:`, e.message); });
    await w.loadURL(srv.url);
    await w.webContents.executeJavaScript(`window.__anixPartyTiming = { hostGone: 3000, gone: 10000, hb: 2500, ref: 2000 }`);
    return { w, js: (code) => w.webContents.executeJavaScript(code, true) };
  };
  const A = await mk('a'); const B = await mk('b');
  await sleep(2500);
  const vid = `document.querySelector('.player-overlay video')`;
  const pos = (X) => X.js(`(() => { const v = ${vid}; return v ? { t: v.currentTime, paused: v.paused, ready: v.readyState } : null; })()`);
  const waitFor = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return false; };
  const chips = (X) => X.js(`[...document.querySelectorAll('.player-top .p-chip')].map((b) => ({ lbl: b.querySelector('.lbl').textContent, off: b.disabled }))`);
  const title = (X) => X.js(`document.querySelector('.player-top .ttl span')?.textContent || ''`);

  // A: 5 серия AniDUB во встроенном плеере, комната — из плеера; B входит по коду
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
  check(/5 серия/.test(await title(B)), `у B 5 серия: «${await title(B)}»`);

  // экран серий у участника комнаты: чип плеера — «Встроенный плеер» со значком комнаты, в меню — пояснение,
  // сторонний и веб видны, но неактивны (личный выбор — веб-плеер — не меняется)
  await B.js(`localStorage.setItem('anixart.pref.SELECTED_PLAYER', '1'); import('/js/router.js').then((r) => r.navigate('episodes', { release: { id: ${RID}, title_ru: 'Мастер Муси' } }))`);
  const bscr = `document.querySelector('#viewport .screen:last-child')`;
  check(await waitFor(() => B.js(`!!${bscr}.querySelector('.ep-row') && !${bscr}.querySelector('.sk-root')`), 20000), 'у B экран серий с чипами');
  check(await B.js(`(() => { const c = ${bscr}.querySelector('.wchip-player'); return c.classList.contains('in-room') && /Встроенный плеер/.test(c.innerText); })()`), 'в комнате чип плеера — «Встроенный плеер» со значком комнаты');
  await B.js(`${bscr}.querySelector('.wchip-player').click()`); await sleep(400);
  const menuB = await B.js(`(() => { const p = document.querySelector('.popover'); return p && { note: p.querySelector('.pop-room')?.innerText || '', off: [...p.querySelectorAll('.pop-item')].map((b) => b.disabled) }; })()`);
  check(!!menuB && /только встроенный плеер/.test(menuB.note) && /Веб-плеер.*вернётся/.test(menuB.note) && menuB.off.join() === 'false,true,true', `в меню пояснение, сторонний и веб неактивны ${JSON.stringify(menuB)}`);
  await B.js(`[...document.querySelectorAll('.popover .pop-item')][2].click()`); await sleep(300);
  check(await B.js(`localStorage.getItem('anixart.pref.SELECTED_PLAYER') === '1'`), 'личный выбор не изменился');
  await B.js(`if (document.querySelector('.popover:not(.closing)')) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`); await sleep(300); // Esc — только меню (иначе закрыл бы плеер)

  // управлять могут все: озвучка и серия активны у обоих, плеер — нет (в комнате только встроенный)
  const cA = await chips(A); const cB = await chips(B);
  check(cA.length === 3 && !cA[0].off && !cA[1].off && cA[2].off, `A: озвучка и серия активны, плеер — нет ${JSON.stringify(cA)}`);
  check(cB.length === 3 && !cB[0].off && !cB[1].off && cB[2].off, `B: то же ${JSON.stringify(cB)}`);

  // B меняет озвучку посреди серии — у обоих «Люб. Двухголосый», та же серия, с того же места
  await A.js(`${vid}.play().catch(() => {})`); await sleep(8000);
  await A.js(`${vid}.pause()`);
  await waitFor(async () => (await pos(B))?.paused, 6000); await sleep(1000);
  const before = (await pos(B)).t;
  await B.js(`document.querySelector('.player-top .p-dub').click()`);
  check(await waitFor(() => B.js(`document.querySelectorAll('.popover .pop-item').length > 1`), 8000), 'у B меню озвучек');
  await B.js(`[...document.querySelectorAll('.popover .pop-item')].find((b) => b.textContent.includes('Люб. Двухголосый')).click()`);
  const sameDub = async (X) => (await chips(X))[0]?.lbl === 'Люб. Двухголосый';
  check(await waitFor(async () => (await sameDub(A)) && (await sameDub(B)), 30000), 'озвучка сменилась у обоих');
  const room = () => A.js(`import('/js/party/room.js').then(({ party }) => { const s = party.room.state; return { pos: s.pos, typeId: s.content?.typeId, wait: s.wait }; })`);
  check(await waitFor(async () => { const r = await room(); return r.typeId === 34 && !r.wait; }, 25000), 'комната дождалась обоих и пустила серию');
  const rs = await room();
  check(Math.abs(rs.pos - before) < 1.5, `комната продолжила с того же места: было ${before.toFixed(1)} с, стало ${rs.pos.toFixed(1)} с`);
  check(await waitFor(async () => { const [a, b] = [await pos(A), await pos(B)]; return a?.ready >= 3 && b?.ready >= 3 && Math.abs(a.t - b.t) < 0.6 && a.t >= before - 1; }, 15000),
    `у обоих одно место: A ${JSON.stringify(await pos(A))}, B ${JSON.stringify(await pos(B))}`);
  check(/5 серия/.test(await title(A)) && /5 серия/.test(await title(B)), 'у обоих та же серия');
  const st = await A.js(`import('/js/party/room.js').then(({ party }) => party.room.state.content)`);
  check(st?.typeId === 34 && st?.position === 5, `серия комнаты — в новой озвучке ${JSON.stringify({ typeId: st?.typeId, position: st?.position, dub: st?.dub })}`);

  // только хост (A): у B озвучка неактивна, серия из сетки — в очередь «Дальше»
  await A.js(`import('/js/party/room.js').then(({ setControl }) => setControl('host'))`);
  check(await waitFor(async () => (await chips(B))[0]?.off === true, 10000), `у B озвучка неактивна ${JSON.stringify(await chips(B))}`);
  check((await chips(A))[0]?.off === false, 'у хоста озвучка активна');
  await B.js(`document.querySelector('.player-top .p-eps').click()`); await sleep(500);
  check(await B.js(`/очередь «Дальше»/.test(document.querySelector('.popover .p-eps-legend')?.textContent || '')`), 'у B в сетке подсказка про очередь');
  await B.js(`[...document.querySelectorAll('.popover .p-ep')][7].click()`);
  const queue = () => A.js(`import('/js/party/room.js').then(({ party }) => (party.room.state.queue || []).map((q) => q.content.position))`);
  check(await waitFor(async () => (await queue()).includes(8), 10000), `8 серия в очереди «Дальше»: ${JSON.stringify(await queue())}`);
  await sleep(1500);
  check(/5 серия/.test(await title(A)) && /5 серия/.test(await title(B)), 'серия у обоих не сменилась');

  // филлеры в комнате: настройка комнаты (меняет хост), «следующая» у хоста перескакивает их у всех, остальным —
  // уведомление «пропущено N филлеров». «Наруто»: 101–106 — филлеры
  const NAR = 609;
  await A.js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    for (const ty of (await (await fetch('/api/episode/${NAR}')).json()).types) {
      const s = (await (await fetch('/api/episode/${NAR}/' + ty.id)).json()).sources.find((x) => x.episodes_count >= 200);
      if (!s) continue;
      const r = await (await fetch('/api/episode/${NAR}/' + ty.id + '/' + s.id + '?sort=1')).json();
      openBuiltinPlayer({ release: { id: ${NAR}, title_ru: 'Наруто' }, episodes: r.episodes, index: r.episodes.findIndex((e) => e.position === 100), sort: 1, typeId: ty.id, dub: ty.name, startAt: 0 });
      return;
    }
  })()`);
  const epOf = (X) => X.js(`document.querySelector('.player-top .p-eps .lbl')?.textContent || ''`);
  check(await waitFor(async () => /100 серия/.test(await epOf(A)) && /100 серия/.test(await epOf(B)), 40000), `оба на 100-й «Наруто»: A «${await epOf(A)}», B «${await epOf(B)}»`);
  await A.js(`import('/js/party/room.js').then(({ setRoomSkip }) => setRoomSkip('filler', true))`);
  check(await waitFor(() => B.js(`import('/js/party/room.js').then(({ roomSkip }) => roomSkip('filler'))`), 10000), 'у B пропуск филлеров включён (настройка комнаты)');
  const notes = (X) => X.js(`[...document.querySelectorAll('.party-bubble')].map((x) => x.textContent).join(' | ')`);
  check(await waitFor(async () => /Филлеры теперь пропускаются/.test(await notes(B)), 8000), `у B уведомление о настройке: «${await notes(B)}»`);
  await B.js(`document.querySelector('.player-controls .gear').click()`); await sleep(300);
  await B.js(`[...document.querySelectorAll('.player-menu .pm-row')].find((x) => x.innerText.includes('Пропуски')).click()`); await sleep(300);
  check(await B.js(`(() => { const l = [...document.querySelectorAll('.player-menu .pm-row')].find((x) => x.innerText.includes('Пропускать филлеры')); return !!l && l.querySelector('input').disabled && /решает хост/.test(l.innerText); })()`), 'у B переключатель неактивен: «В комнате решает хост»');
  await B.js(`document.querySelector('.player-controls .gear').click()`);
  await A.js(`document.querySelector('.player-controls [title^="Следующая серия"]').click()`);
  check(await waitFor(async () => /107 серия/.test(await epOf(A)) && /107 серия/.test(await epOf(B)), 40000), `оба на 107-й: A «${await epOf(A)}», B «${await epOf(B)}»`);
  check(await waitFor(async () => /пропущено 6 филлеров/.test(await notes(B)), 8000), `у B уведомление: «${await notes(B)}»`);

  console.log(bad ? `FAILED: ${bad}` : 'ALL OK');
  srv.server.close();
  app.exit(bad ? 1 : 0);
});
