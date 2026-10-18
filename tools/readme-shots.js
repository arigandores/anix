'use strict';
// Скриншоты для README (docs/screenshots/*.jpg): 1440×900 с масштабом 1,5 (кадр 2160×1350), тёмная тема, чистый профиль без
// входа в Anixart. «Продолжить · 5 серия» и отметки серий — из локальной истории, как после настоящего просмотра.
// Совместный просмотр — второе окно в той же комнате (настоящие брокеры).
// Запуск: npx electron tools/readme-shots.js [папка] [кадры через запятую]
//   кадры: release, episodes, player, mini, party (upscale.jpg, upscale-zoom.jpg и ai.jpg сняты вручную)
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const settle = require('../test/_settle');

app.commandLine.appendSwitch('force-device-scale-factor', '1.5');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'docs', 'screenshots'));
const steps = new Set((process.argv[3] || 'release,episodes,player,mini,party').split(','));
const RID = 21; // «Мастер Муси»: несколько озвучек, у AniDUB — Kodik
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  const srv = await start(0);
  // окно со своим чистым профилем; name — имя участника в комнате
  const mk = async (part, name) => {
    const w = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { partition: `readme-shots-${part}`, backgroundThrottling: false } });
    w.webContents.setAudioMuted(true);
    // без CSS-анимаций меню и диалоги сразу в конечном состоянии
    w.webContents.on('dom-ready', () => w.webContents.insertCSS('*, *::before, *::after { animation: none !important; transition: none !important; }'));
    await w.webContents.session.clearStorageData();
    await w.loadURL(srv.url);
    const js = (c) => w.webContents.executeJavaScript(c, true);
    // режим экономии — без анимаций интерфейса: в скрытом окне въезд экрана застывает на первом кадре
    await js(`localStorage.clear(); localStorage.setItem('anixart.theme', 'dark'); localStorage.setItem('anixart.pref.ECONOMY_MODE', 'true');
      localStorage.setItem('anixart.profile', ${JSON.stringify(JSON.stringify({ id: 0, login: name }))}); location.reload(); 1`);
    await sleep(2500); await js(settle.INSTALL); await settle(js, 6000);
    return { w, js };
  };
  const { w, js } = await mk('a', 'Саша');
  const scr = `document.querySelector('#viewport .screen:last-child')`;
  const until = async (cond, max = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { if (await js(cond)) return true; await sleep(150); } return false; };
  const shot = async (name, wait = 6000) => {
    await settle(js, wait); await sleep(300);
    // скрытое окно может отдать прошлый кадр: первый снимок — чтобы перерисовалось, в файл — второй
    w.webContents.invalidate(); await w.webContents.capturePage(); await sleep(500);
    fs.writeFileSync(path.join(outDir, `${name}.jpg`), (await w.webContents.capturePage()).toJPEG(88));
    console.log('saved', name);
  };
  const nav = (name, params = '{}') => js(`import('/js/router.js').then((r) => r.navigate('${name}', ${params}))`);
  const tab = (t) => js(`import('/js/router.js').then((r) => r.switchTab('${t}'))`);
  const click = (sel) => js(`(() => { const el = ${scr}.querySelector(${JSON.stringify(sel)}) || document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const esc = () => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);

  // Выбрали AniDUB, посмотрели 1–4 серии, 5-ю остановили на 12:40 из 24:10
  await nav('release', `{ id: ${RID} }`); await settle(js, 6000);
  await until(`!!${scr}.querySelector('.watch .btn-watch')`);
  await click('.watch .btn-watch');
  await until(`[...${scr}.querySelectorAll('.type-row')].some((r) => r.innerText.includes('AniDUB'))`);
  await js(`[...${scr}.querySelectorAll('.type-row')].find((r) => r.innerText.includes('AniDUB')).click(); 1`);
  await until(`!!${scr}.querySelector('.ep-row')`);
  await js(`(async () => {
    const kodik = await fetch('/api/episode/${RID}/1').then((r) => r.json()).then((j) => j.sources.find((s) => s.name === 'Kodik').id);
    const { db } = await import('/js/store.js');
    db.addLastWatched(${RID}, 1, kodik, 5, { typeName: 'AniDUB', sourceName: 'Kodik' });
    for (const p of [1, 2, 3, 4]) db.putEpisode(${RID}, kodik, p, { isWatched: true, playbackPosition: -1 });
    db.putEpisode(${RID}, kodik, 5, { isWatched: true, playbackPosition: 760000, duration: 1450000, endingStart: 1340000 });
  })()`);
  await js(`history.back(); 1`);
  await until(`/Продолжить/.test(${scr}.querySelector('.watch')?.innerText || '')`);

  if (steps.has('release')) await shot('release');
  if (steps.has('episodes')) {
    await click('.watch .btn-tonal:not(.btn-next):not(.btn-party)'); await settle(js, 6000);
    await click('.wchip-dub'); await sleep(400); await shot('episodes', 3000);
    await esc(); await sleep(300);
    await js(`history.back(); 1`); await settle(js, 5000);
  }
  if (!['player', 'mini', 'party'].some((s) => steps.has(s))) { srv.server.close(); app.exit(0); return; }

  // «Продолжить» — серия с 12:40
  const V = `document.querySelector('.player-overlay video')`;
  const OV = `document.querySelector('.player-overlay')`;
  await click('.watch .btn-watch');
  await until(`(() => { const v = ${V}; return !!v && v.readyState >= 3 && !v.paused; })()`, 40000);
  await sleep(4000);
  if (steps.has('player')) {
    await js(`${V}.pause(); 1`);
    await click('.player-controls .gear'); await sleep(400); await shot('player', 2000);
    await click('.player-controls .gear'); await sleep(200);
  }
  if (steps.has('mini')) {
    await js(`${OV}.mini(true); ${V}.play().catch(() => {}); 1`);
    await tab('home'); await sleep(1500); await shot('mini', 4000);
    await js(`${OV}.mini(false); 1`); await sleep(500);
  }
  if (steps.has('party')) {
    await js(`${V}.play().catch(() => {}); 1`);
    const code = await js(`import('/js/party/room.js').then(async ({ party }) => { await party.create(); return party.room.code; })`);
    const B = await mk('b', 'Аня');
    await B.js(`import('/js/party/room.js').then(({ party }) => party.join(${JSON.stringify(code)}).then(() => true))`);
    await until(`import('/js/party/room.js').then(({ present }) => present().length === 2)`, 25000);
    await sleep(3000);
    await B.js(`import('/js/party/room.js').then((m) => m.queueAdd({ releaseId: 1, typeId: 1, sourceId: 8, position: 1, sort: 1, title: 'Котёнок Ти', image: '', dub: 'AniDUB', epName: '1 серия' }))`);
    await sleep(2500);
    await js(`${V}.pause(); 1`); await shot('party', 3000);
    B.w.destroy();
  }
  srv.server.close();
  app.exit(0);
});
