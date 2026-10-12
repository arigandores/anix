'use strict';
// Аудит видимости «тональных» элементов (кнопки, бейджи, пилюли, поля, чипы) в обеих темах:
// итоговый цвет фона элемента (с учётом полупрозрачных слоёв) против подложки под ним.
// Запуск: npx electron test/contrast.js [папка-для-скриншотов]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(out, { recursive: true });

const AUDIT = `(() => {
  const SEL = '.btn-tonal, .list-btn:not(.tag), .badge:not(.rating), .chip-ann, .input, .chip.on, .ep-row .num, .fav-btn, .type-row .ph, .status-bubble, .searchbar, .tile';
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return [0,0,0,0]; const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const over = (top, bot) => { const a = top[3]; return [top[0]*a + bot[0]*(1-a), top[1]*a + bot[1]*(1-a), top[2]*a + bot[2]*(1-a), 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); }; return .2126*f(c[0]) + .7152*f(c[1]) + .0722*f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
  // итоговый фон под элементом: композиция всех предков (без самого элемента)
  const behind = (el) => { const chain = []; let n = el.parentElement; while (n) { chain.push(parse(getComputedStyle(n).backgroundColor)); n = n.parentElement; } let c = parse(getComputedStyle(document.body).backgroundColor); c[3] = 1; for (let i = chain.length - 1; i >= 0; i--) c = over(chain[i], c); return c; };
  const res = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (!el.offsetParent) continue;
    const st = getComputedStyle(el);
    const base = behind(el);
    const own = parse(st.backgroundColor);
    const border = parse(st.borderTopColor); const bw = parseFloat(st.borderTopWidth) || 0;
    const fill = over(own, base);
    const r = ratio(fill, base);
    const rBorder = bw > 0 ? ratio(over(border, base), base) : 1;
    const shadow = st.boxShadow !== 'none';
    const visible = r >= 1.12 || rBorder >= 1.3 || shadow;
    if (!visible) res.push({ el: (el.className || el.tagName).toString().slice(0, 40), text: (el.textContent || el.placeholder || '').trim().slice(0, 24), ratio: +r.toFixed(3) });
  }
  return res;
})()`;

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  // профиль с открытой статистикой — чтобы проверить кнопки «Списки просмотра», «Оценки» и т.д.
  const mockProfile = `(() => { const of = window.fetch; window.fetch = async (u, o) => { const r = await of(u, o);
    if (/\\/api\\/profile\\/1(\\?|$)/.test(String(u))) { const j = await r.clone().json(); Object.assign(j.profile, { is_stats_hidden: false, is_counts_hidden: false, watching_count: 135, plan_count: 79, completed_count: 372, hold_on_count: 11, dropped_count: 93, friend_count: 1, comment_count: 0, collection_count: 0 }); return new Response(JSON.stringify(j)); }
    return r; }; })()`;
  const screens = [
    ['home', "r.switchTab('home')", 3500], ['release', "r.navigate('release',{id:21})", 4000],
    ['episodes', "r.navigate('episodes',{release:{id:1,title_ru:'T'}})", 3000], ['filter', "r.navigate('filter',{})", 2000],
    ['profile', "r.navigate('profile',{id:1})", 3500], ['collection', "r.navigate('collection',{id:1})", 3000],
    ['auth', "r.navigate('auth',{})", 1500], ['discover', "r.switchTab('discover')", 4500], ['settings', "r.navigate('settings',{})", 1500],
  ];
  const report = {};
  for (const theme of ['dark', 'light']) {
    await js(`localStorage.setItem('anixart.theme','${theme}')`);
    await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
    await sleep(3000);
    await js(mockProfile);
    for (const [label, code, wait] of screens) {
      await js(`(async () => { document.querySelectorAll('.backdrop').forEach(b => b.remove()); const r = await import('/js/router.js'); ${code} })()`);
      await sleep(wait);
      const bad = await js(AUDIT);
      if (bad.length) report[`${theme}/${label}`] = bad;
      if (label === 'profile') {
        await win.webContents.capturePage(); await sleep(200);
        await js(`document.querySelector('#viewport').scrollTop = 520`); await sleep(400);
        await win.webContents.capturePage(); await sleep(200);
        fs.writeFileSync(path.join(out, `contrast-${theme}-profile.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }
  console.log('LOW-CONTRAST:', Object.keys(report).length ? JSON.stringify(report, null, 1) : 'none');
  srv.server.close();
  app.exit(0);
});
