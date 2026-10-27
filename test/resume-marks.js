'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// «Продолжить» и отметки с другого устройства: 17 серий посмотрели здесь (17-ю только начали), досмотрели до 24 на
// телефоне в официальном приложении — отметки 18–24 приходят с сервера, а последнюю серию оно не обновляет.
// Страница аниме и экран серий предлагают 25-ю, а не начатую 17-ю. Пересмотр: последняя серия здесь новее отметок —
// «Продолжить» её, а не прыжок вперёд. Отметка вручную после последней серии — тоже вперёд.
// Отметки сервера подставляются в настоящий список серий (без входа в аккаунт сервер их не отдаёт).
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const settle = require('./_settle');
const RID = 21; // «Мастер Муси»: 26 серий
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const srv = await start(0);
  const fails = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} ${what}`); if (!ok) fails.push(what); };
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`localStorage.clear(); localStorage.setItem('anixart.theme','dark'); 1`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await settle(js, 6000);
  const scr = `document.querySelector('#viewport > .screen:last-child')`;
  const watchText = () => js(`(${scr}.querySelector('.watch')?.innerText || '').replace(/\\s+/g, ' ').trim()`);

  // озвучка с Kodik и её серии — настоящие
  const pick = await js(`(async () => {
    const { A } = await import('/js/api.js');
    for (const ty of (await A.types(${RID})).types) {
      const so = (await A.sources(${RID}, ty.id)).sources.find((s) => /kodik/i.test(s.name));
      if (!so) continue;
      const eps = (await A.episodes(${RID}, ty.id, so.id, 1)).episodes || [];
      if (eps.length >= 25) return { typeId: ty.id, typeName: ty.name, sourceId: so.id, sourceName: so.name, eps: eps.map((e) => ({ position: e.position })) };
    }
    return null;
  })()`);
  if (!pick) { check(false, 'нашлась озвучка с Kodik и 25+ сериями'); srv.server.close(); app.exit(1); return; }
  // здесь: 1–16 досмотрены, 17-ю начали (0:28 из 24:10) — час назад
  const setup = (lastPos, lastAgo) => js(`(async () => {
    const { db } = await import('/js/store.js');
    localStorage.removeItem('anixart.db.episodes'); localStorage.removeItem('anixart.db.lastWatched');
    const hour = Date.now() - ${lastAgo} * 1000;
    for (let p = 1; p <= 16; p++) db.putEpisode(${RID}, ${pick.sourceId}, p, { isWatched: true, playbackPosition: 1360000, duration: 1450000, endingStart: 1340000, savedAt: hour - (17 - p) * 86400000 });
    db.putEpisode(${RID}, ${pick.sourceId}, 17, { isWatched: true, playbackPosition: 28000, duration: 1450000, savedAt: hour });
    db.addLastWatched(${RID}, ${pick.typeId}, ${pick.sourceId}, ${lastPos}, { typeName: ${JSON.stringify(pick.typeName)}, sourceName: ${JSON.stringify(pick.sourceName)} });
    const all = JSON.parse(localStorage.getItem('anixart.db.lastWatched')); all[${RID}].timestamp = Math.floor(hour / 1000); localStorage.setItem('anixart.db.lastWatched', JSON.stringify(all));
  })()`);
  // отметки сервера 1–24 (как после телефона) — через то же слияние, что у страницы аниме и экрана серий
  const serverMarks = (upTo) => js(`(async () => {
    const { mergeServerMarks } = await import('/js/screens/episodes.js');
    const eps = ${JSON.stringify(pick.eps)}.map((e) => ({ ...e, is_watched: e.position <= ${upTo} }));
    localStorage.setItem('anixart.token', 'test'); // слияние — только со входом; без запросов, сразу снимаем
    try { mergeServerMarks(${RID}, ${pick.sourceId}, eps); } finally { localStorage.removeItem('anixart.token'); }
  })()`);
  const openRelease = async () => {
    await js(`import('/js/router.js').then((m) => m.navigate('release', { id: ${RID} })); 1`);
    for (let i = 0; i < 40 && !/серию|серия/.test(await watchText()); i++) await sleep(250);
    await sleep(600);
    return watchText();
  };

  // 1. без отметок с телефона — как раньше: «Продолжить · 17 серия»
  await setup(17, 3600);
  let w = await openRelease();
  check(/Продолжить · 17 серия/.test(w), `без отметок с другого устройства — «Продолжить · 17 серия»: ${w}`);
  await js(`history.back(); 1`); await sleep(500);

  // 2. отметки 18–24 пришли с сервера после — «Смотреть 25 серию», «24 серия просмотрена»
  await serverMarks(24);
  w = await openRelease();
  check(/Смотреть 25 серию/.test(w) && /24 серия просмотрена/.test(w) && !/Продолжить · 17/.test(w), `досмотрели до 24 на телефоне — страница аниме: ${w}`);
  // экран серий — текущая 25-я, 18–24 просмотрены
  await js(`${scr}.querySelector('.watch .btn-tonal:not(.btn-next):not(.btn-party)')?.click(); 1`);
  for (let i = 0; i < 40 && !(await js(`!!${scr}.querySelector('.ep-row.current') && !${scr}.querySelector('.sk-root')`)); i++) await sleep(250);
  const rows = await js(`(() => { const r = [...${scr}.querySelectorAll('.ep-row')]; const cur = r.find((x) => x.classList.contains('current')); return { cur: cur && Number(cur.dataset.pos), w: r.filter((x) => x.classList.contains('watched')).map((x) => Number(x.dataset.pos)) }; })()`);
  check(rows.cur === 25 && [18, 20, 24].every((p) => rows.w.includes(p)), `экран серий: текущая ${rows.cur}, просмотрены ${rows.w.length} (18–24 среди них)`);
  await js(`history.back(); 1`); await sleep(500); await js(`history.back(); 1`); await sleep(500);

  // 3. пересмотр: отметки старые, а 3-ю начали здесь позже — «Продолжить · 3 серия», не прыжок вперёд
  await js(`(async () => {
    const { db } = await import('/js/store.js');
    const all = db.episodes(); for (const e of Object.values(all)) if (e.markedAt) e.markedAt -= 7200; localStorage.setItem('anixart.db.episodes', JSON.stringify(all));
    db.putEpisode(${RID}, ${pick.sourceId}, 3, { playbackPosition: 300000, duration: 1450000, finished: false, savedAt: Date.now() });
    db.addLastWatched(${RID}, ${pick.typeId}, ${pick.sourceId}, 3, {});
  })()`);
  w = await openRelease();
  check(/Продолжить · 3 серия/.test(w), `пересмотр 3-й после давних отметок — «Продолжить · 3 серия»: ${w}`);
  await js(`history.back(); 1`); await sleep(500);

  // 4. вручную отметили 25-ю после последней серии — «Смотреть 26 серию»
  await js(`(async () => {
    const { db } = await import('/js/store.js');
    db.putEpisode(${RID}, ${pick.sourceId}, 25, { isWatched: true, markedAt: Math.floor(Date.now() / 1000) + 5 });
  })()`);
  w = await openRelease();
  check(/Смотреть 26 серию/.test(w), `отметили 25-ю вручную после пересмотра — «Смотреть 26 серию»: ${w}`);
  await js(`history.back(); 1`); await sleep(500);

  // 5. здесь ни одной серии не запускали, а сервер последнюю серию не знает (смотрели в официальном приложении):
  // только выбор озвучки (экран серий) и отметки 1–17 с сервера — «Смотреть 18 серию», а не «Смотреть»
  await js(`(async () => {
    const { db } = await import('/js/store.js');
    localStorage.removeItem('anixart.db.episodes'); localStorage.removeItem('anixart.db.lastWatched');
    db.setChoice(${RID}, { typeId: ${pick.typeId}, sourceId: ${pick.sourceId}, typeName: ${JSON.stringify(pick.typeName)}, sourceName: ${JSON.stringify(pick.sourceName)} });
  })()`);
  await serverMarks(17);
  w = await openRelease();
  check(/Смотреть 18 серию/.test(w) && /17 серия просмотрена/.test(w), `только отметки 1–17 с сервера — «Смотреть 18 серию»: ${w}`);

  srv.server.close();
  app.exit(fails.length ? 1 : 0);
});
