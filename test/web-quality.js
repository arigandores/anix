'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// Веб-плеер: качество по настройке «Приоритет качества», а не то, что задал сайт (electron/web-quality.js). Плеер
// AniLibria (Playerjs) сам включает 720p, хотя есть 1080p. Серия Liberty в веб-плеере: без модуля — 720p сайта,
// с модулем — максимальное / 720p / 480p по настройке. Нужна сеть. electron test/web-quality.js
const { app, BrowserWindow } = require('electron');
const { start } = require('../server');
const { attachWebQuality } = require('../electron/web-quality');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) bad++; };

app.whenReady().then(async () => {
  const srv = await start(0);
  // серия Liberty: AniLiberty у «Свадьбы светлячков» (20643), если нет — первая подходящая из расписания
  const api = async (p) => (await fetch(`${srv.url}api/${p}`)).json();
  let url = null;
  for (const rid of [20643, ...Object.values(await api('schedule')).filter(Array.isArray).flat().map((r) => r.id)]) {
    const ty = ((await api(`episode/${rid}`)).types || []).find((x) => /AniLiberty/.test(x.name));
    const so = ty && ((await api(`episode/${rid}/${ty.id}`)).sources || []).find((x) => x.name === 'Liberty');
    const ep = so && ((await api(`episode/${rid}/${ty.id}/${so.id}?sort=1`)).episodes || [])[0];
    if (ep && !ep.iframe) { url = ep.url; break; }
  }
  check(!!url, `серия Liberty для веб-плеера: ${url}`);

  // качество плеера сайта во вложенном окне веб-плеера (ждём, пока плеер готов и качество устоялось)
  async function run(pref, attach) {
    const win = new BrowserWindow({ width: 1000, height: 640, show: false, webPreferences: { backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    let picked = null;
    if (attach) attachWebQuality(win.webContents, { onPicked: (q) => { picked = q; } });
    await win.loadURL(srv.url);
    const js = (c) => win.webContents.executeJavaScript(c, true);
    await js(`localStorage.setItem('anixart.pref.SELECTED_VIDEO_QUALITY_V2', '${pref}'); 1`);
    await js(`import('/js/player.js').then(({ openWebPlayer }) => openWebPlayer({ url: ${JSON.stringify(url)}, iframe: false, name: '1 серия' }, { title_ru: 'Тест' }))`);
    const frameQ = async () => {
      const f = win.webContents.mainFrame.framesInSubtree.find((x) => /libria/.test(x.url));
      if (!f) return null;
      try { return await f.executeJavaScript(`typeof player !== 'undefined' && player.api ? player.api('quality') : null`); } catch { return null; }
    };
    let q = null;
    for (let i = 0; i < 60; i++) { await sleep(250); q = await frameQ(); if (q && (!attach || picked)) break; }
    await sleep(700); q = await frameQ(); // переключение применилось и держится
    await win.loadURL('about:blank').catch(() => {}); // окно не уничтожаем: иначе следующее не загрузится (ERR_FAILED)
    return { q, picked };
  }

  const site = await run(0, false);
  check(site.q === '720p', `без модуля — качество сайта: ${site.q}`);
  const max = await run(0, true);
  check(max.q === '1080p', `«максимальное» — ${max.q}`);
  const q720 = await run(4, true);
  check(q720.q === '720p', `«720p» — ${q720.q}`);
  const q480 = await run(3, true);
  check(q480.q === '480p', `«480p» — ${q480.q}`);

  console.log(bad ? `FAILED: ${bad}` : 'ALL OK');
  srv.server.close();
  app.exit(bad ? 1 : 0);
});
