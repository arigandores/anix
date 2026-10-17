'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Статус в Discord (server/discord.js + public/js/discord.js) против поддельного Discord на своём канале:
// рукопожатие с Client ID, «Смотрит <тайтл>» с серией, озвучкой и полосой времени на живой серии, пауза, скорость,
// закрытие плеера убирает статус, выключатель и подпись в настройках, лимит Discord (5 обновлений за 20 с),
// подключение к Discord, запущенному позже, чужие сайты не меняют статус, чистка полей.
// Аккаунт Anixart не затрагивается. electron test/discord.js
const { app, BrowserWindow } = require('electron');
const http = require('http');
const net = require('net');
const path = require('path');
const PIPE = process.platform === 'win32' ? `\\\\?\\pipe\\anix-test-discord-${process.pid}` : path.join(require('os').tmpdir(), `anix-test-discord-${process.pid}`);
const CLIENT_ID = '123456789012345678';
process.env.ANIX_DISCORD_PIPE = PIPE; // вместо настоящего Discord
process.env.ANIX_DISCORD_CLIENT_ID = CLIENT_ID;
const discord = require('../server/discord');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// поддельный Discord: отвечает READY на рукопожатие, записывает SET_ACTIVITY
const got = []; let handshake = null; let server = null;
function listen() {
  server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0); const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        const msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8')); buf = buf.subarray(8 + len);
        const reply = (data) => { const j = Buffer.from(JSON.stringify(data)); const hd = Buffer.alloc(8); hd.writeInt32LE(1, 0); hd.writeInt32LE(j.length, 4); sock.write(Buffer.concat([hd, j])); };
        if (op === 0) { handshake = msg; reply({ cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }); }
        else if (op === 1 && msg.cmd === 'SET_ACTIVITY') { got.push({ at: Date.now(), activity: msg.args.activity || null }); reply({ cmd: 'SET_ACTIVITY', nonce: msg.nonce, data: msg.args.activity || null }); }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((r) => server.listen(`${PIPE}-0`, r));
}

app.whenReady().then(async () => {
  let bad = 0;
  const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };
  const last = () => got[got.length - 1]?.activity;
  const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); } return false; };

  // чистка полей из окна
  const c = discord.cleanActivity({ type: 99, details: 'x'.repeat(300), state: 'a', assets: { large_image: 'http://insecure/p.jpg', large_text: 'T' }, buttons: [{ label: 'b', url: 'javascript:alert(1)' }], evil: 1 });
  check(c.type === 3 && c.details.length === 128 && c.state.length === 2 && !c.assets.large_image && !c.buttons && !('evil' in c), 'поля из окна чистятся под лимиты Discord');

  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 760, show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setAudioMuted(true);
  await win.loadURL(srv.url);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await sleep(2500);
  const open = () => js(`(async () => {
    const { openBuiltinPlayer } = await import('/js/player.js');
    const r = await (await fetch('/api/episode/1/1/8?sort=1')).json();
    window.__p = openBuiltinPlayer({ release: { id: 1, title_ru: 'Котёнок Ти', title_original: 'Chi\\'s Sweet Home', image: 'https://example.com/poster.jpg' }, episodes: r.episodes, index: 0, sort: 1, dub: 'AniLibria' });
    return r.episodes.length;
  })()`);
  const dismissResume = () => js(`document.querySelector('.backdrop .sheet-item')?.click()`);

  const status = () => js(`fetch('/discord/status').then((r) => r.json())`);
  const settingsSub = async () => {
    await js(`import('/js/router.js').then((m) => m.navigate('settings', { section: 'discord' }))`); await sleep(1500);
    const t = await js(`[...document.querySelectorAll('.menu-item')].map((m) => m.innerText).find((x) => x.includes('Статус в Discord')) || ''`);
    await js(`history.back()`); await sleep(500);
    return t.split(/\r?\n/).slice(1).join(' ');
  };
  let st = await status();
  check(st.configured && !st.running, `Discord не запущен — /discord/status: ${JSON.stringify(st)}`);
  const sub0 = await settingsSub();
  check(/Выключено/.test(sub0), `по умолчанию выключено — настройки: «${sub0}»`);

  // по умолчанию выключено: плеер ничего не отправляет даже при запущенном Discord
  await listen();
  await open(); await sleep(6000); await dismissResume(); await sleep(3000);
  check(got.length === 0 && !handshake, 'по умолчанию статус не отправляется и к Discord не подключаемся');
  await js(`window.__p.close()`); await sleep(500);
  server.close(); await sleep(300);

  // включаем переключателем в настройках
  await js(`import('/js/router.js').then((m) => m.navigate('settings', { section: 'discord' }))`); await sleep(1500);
  await js(`(() => { const it = [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('Статус в Discord')); it.querySelector('input').click(); })()`);
  await sleep(300);
  const subOn = await js(`[...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('Статус в Discord')).querySelector('.sub').textContent`);
  check(await js(`localStorage.getItem('anixart.pref.DISCORD_PRESENCE')`) === 'true' && /не запущен/.test(subOn), `переключатель включает статус: «${subOn}»`);
  await js(`history.back()`); await sleep(500);

  // чужая страница не может менять статус: другой Origin / не JSON
  const evil = (headers) => new Promise((res) => { const rq = http.request(`${srv.url}discord/presence`, { method: 'POST', headers }, (r) => res(r.statusCode)); rq.end('{"details":"spam"}'); });
  check(await evil({ Origin: 'https://evil.example', 'Content-Type': 'application/json' }) === 403 && await evil({ 'Content-Type': 'text/plain' }) === 403
    && await evil({ 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }) === 403, 'запросы с чужих сайтов отклоняются');

  // 1) Discord запущен позже приложения: статус появляется после переподключения (раз в 15 с)
  await open();
  await sleep(4000); await dismissResume();
  check(got.length === 0, 'Discord не запущен — ошибок нет, статус ждёт');
  await listen();
  check(await waitFor(() => !!last(), 20000), 'Discord запустили позже — статус появился');
  check(handshake && handshake.client_id === CLIENT_ID && handshake.v === 1, 'рукопожатие с Client ID приложения');
  st = await status();
  check(st.running && st.state === 'connected', `Discord запущен — /discord/status: ${JSON.stringify(st)}`);

  // 2) содержимое статуса на живой серии
  await waitFor(() => last()?.timestamps, 8000);
  const a = last(); const dur = await js(`document.querySelector('.player-overlay video').duration`);
  console.log('статус:', JSON.stringify(a));
  check(a.type === 3 && a.status_display_type === 2 && a.details === 'Котёнок Ти', '«Смотрит Котёнок Ти»');
  check(/1 серия/.test(a.state) && /AniLibria/.test(a.state), `серия и озвучка: ${a.state}`);
  check(a.timestamps && Math.abs((a.timestamps.end - a.timestamps.start) - dur * 1000) < 1500 && Math.abs(Date.now() - a.timestamps.start - 1000 * await js(`document.querySelector('.player-overlay video').currentTime`)) < 6000,
    'полоса времени: начало и конец серии по часам');
  check(a.assets?.large_image === 'https://example.com/poster.jpg' && a.assets.large_text === "Chi's Sweet Home", 'постер и оригинальное название');
  check(a.buttons?.[0]?.url.endsWith('release/1'), 'кнопка «Открыть в Anixart»');

  // 3) пауза и скорость
  await js(`document.querySelector('.player-overlay video').pause()`);
  check(await waitFor(() => /^На паузе/.test(last()?.state || '') && !last().timestamps), '«На паузе» без полосы времени');
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.playbackRate = 2; v.play(); })()`);
  check(await waitFor(() => { const x = last(); return x?.timestamps && Math.abs((x.timestamps.end - x.timestamps.start) - dur * 500) < 1500; }), 'на скорости ×2 полоса времени вдвое короче');

  // 4) лимит Discord: частые события склеиваются
  const n0 = got.length; const t0 = Date.now();
  await js(`(async () => { const v = document.querySelector('.player-overlay video'); for (let i = 0; i < 12; i++) { v.currentTime += 1; await new Promise((r) => setTimeout(r, 150)); } })()`);
  await sleep(20000 - (Date.now() - t0));
  check(got.length - n0 <= 5, `12 перемоток — ${got.length - n0} обновлений за 20 с (лимит Discord — 5)`);

  // 5) закрытие плеера убирает статус
  await js(`window.__p.close()`);
  check(await waitFor(() => got.length && last() === null), 'плеер закрыт — статус убран');

  // 6) выключатель в настройках
  await js(`localStorage.setItem('anixart.pref.DISCORD_PRESENCE', 'false')`);
  const n1 = got.length;
  await open(); await sleep(6000); await dismissResume(); await sleep(5000);
  check(got.length === n1, 'выключено в настройках — статус не отправляется');
  await js(`window.__p.close(); localStorage.setItem('anixart.pref.DISCORD_PRESENCE', 'true')`);
  const sub1 = await settingsSub();
  check(/подключён/.test(sub1), `настройки: «${sub1}»`);

  discord.shutdown();
  server.close(); srv.server.close();
  console.log(bad ? `DISCORD FAIL: ${bad}` : 'DISCORD OK');
  app.exit(bad ? 1 : 0);
});
