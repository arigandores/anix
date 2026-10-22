'use strict';
// временный стенд: варианты «Нейросети» телефона (anime4k-gl.js) на настоящих кадрах Kodik (несколько сцен).
// Точность: кадр 720p -> вдвое меньше -> вариант x2 -> PSNR к кадру; резкость: средний модуль градиента яркости к
// кадру; ореолы: доля точек, вышедших за мин/макс кадра в окне 3x3 больше чем на 6/255; цена: мс на кадр 720p на этой
// видеокарте (только для сравнения между собой). Картинка: фрагменты 720p -> x2, листы по 4 (PNG в A4K_OUT).
// Шейдеры, которых нет в приложении (линии Anime4K, adaptive-sharpen), — из A4K_SHADERS (папка шейдеров mpv)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = process.env.A4K_OUT;
const SH = process.env.A4K_SHADERS;
const G = {};
for (const f of ['Anime4K_Thin_HQ', 'Anime4K_Darken_HQ', 'Anime4K_Deblur_DoG', 'Anime4K_Deblur_Original', 'Anime4K_Clamp_Highlights', 'adaptive-sharpen']) G[f] = fs.readFileSync(path.join(SH, `${f}.glsl`), 'utf8');

app.whenReady().then(async () => {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  await js(`localStorage.clear(); localStorage.setItem('anixart.pref.SELECTED_PLAYER','2'); localStorage.setItem('anixart.pref.ON_EPISODE_DISCLAIMER','true'); 1`);
  await new Promise((ok) => { win.webContents.once('did-finish-load', ok); win.webContents.reload(); });
  await sleep(2500);
  await js(`window.__G = ${JSON.stringify(G)}; 1`);
  await js(`(async () => {
    const { A } = await import('/js/api.js');
    const types = (await A.types(2487)).types; const ty = types.find((x) => x.name === 'Studio Band') || types[0];
    const so = (await A.sources(2487, ty.id)).sources.find((s) => /kodik/i.test(s.name));
    (await import('/js/router.js')).navigate('episodes', { release: { id: 2487, title_ru: 'Атака титанов 3' }, type: ty, source: so });
  })(); 1`);
  await sleep(3500);
  await js(`document.querySelector('#viewport .screen:last-child .ep-row').click(); 1`);
  for (let i = 0; i < 80 && !(await js(`!!document.querySelector('.player-overlay video') && document.querySelector('.player-overlay video').readyState >= 2`)); i++) await sleep(250);
  await js(`document.querySelectorAll('.backdrop').forEach((b) => b.querySelector('.sheet-item')?.click()); 1`);
  const all = {};
  for (const [n, t] of [[1, 300], [2, 640], [3, 1000]]) {
    await js(`(() => { const v = document.querySelector('.player-overlay video'); v.muted = true; v.pause(); v.currentTime = ${t}; return 1; })()`);
    for (let i = 0; i < 60 && !(await js(`(() => { const v = document.querySelector('.player-overlay video'); return !v.seeking && v.readyState >= 2; })()`)); i++) await sleep(250);
    await sleep(800);
    const r = await js(`(async () => {
      const v = document.querySelector('.player-overlay video');
      const W = v.videoWidth, H = v.videoHeight;
      const fr = new OffscreenCanvas(W, H); const fx = fr.getContext('2d'); fx.drawImage(v, 0, 0);
      const ref = fx.getImageData(0, 0, W, H).data;
      const w = W / 2, h = H / 2;
      const sm = new OffscreenCanvas(w, h); const sx = sm.getContext('2d'); sx.imageSmoothingQuality = 'high'; sx.drawImage(fr, 0, 0, w, h);
      const { createAnime4K } = await import('/js/anime4k-gl.js');
      const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const grad = (d, ww, hh) => { let s = 0; for (let y = 1; y < hh - 1; y += 2) for (let x = 1; x < ww - 1; x += 2) { const i = (y * ww + x) * 4; s += Math.abs(lum(d, i + 4) - lum(d, i - 4)) + Math.abs(lum(d, i + ww * 4) - lum(d, i - ww * 4)); } return s / ((ww / 2) * (hh / 2)); };
      const refGrad = grad(ref, W, H);
      const refL = new Float32Array(W * H); for (let i = 0; i < W * H; i++) refL[i] = lum(ref, i * 4);
      const halo = (d) => { let n = 0, k = 0; for (let y = 1; y < H - 1; y += 1) for (let x = 1; x < W - 1; x += 1) { let mn = 255, mx = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const q = refL[(y + dy) * W + x + dx]; if (q < mn) mn = q; if (q > mx) mx = q; } const l = lum(d, (y * W + x) * 4); if (l > mx + 6 || l < mn - 6) n++; k++; } return n / k; };
      const score = (d) => { let se = 0; for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) { const e = (d[i * 4 + c] - ref[i * 4 + c]) / 255; se += e * e; } return { psnr: +(10 * Math.log10(1 / (se / (W * H * 3)))).toFixed(2), sharp: +(grad(d, W, H) / refGrad).toFixed(3), halo: +(halo(d) * 100).toFixed(2) }; };
      const g = (f, name = f + '.glsl', edit = (x) => x) => ({ name, text: edit(window.__G[f]) });
      const RS = ['Anime4K_Restore_CNN_S.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl'];
      const RM = ['Anime4K_Restore_CNN_M.glsl', 'Anime4K_Upscale_CNN_x2_M.glsl'];
      const AS = (k) => g('adaptive-sharpen', 'adaptive-sharpen.glsl', (x) => x.replace(/#define curve_height\\s+[\\d.]+/, '#define curve_height ' + k));
      const BASE = 'RS + RCAS 0.5 (720p сейчас)';
      const VARIANTS = {
        'билинейно': null,
        [BASE]: { chain: RS, sharp: 0.5, sharpen: 'rcas' },
        'RS без резкости': { chain: RS, sharp: 0 },
        'RM + RCAS 0.5 (480p сейчас)': { chain: RM, sharp: 0.5, sharpen: 'rcas' },
        'RS + RCAS 0.3': { chain: RS, sharp: 0.3, sharpen: 'rcas' },
        'RS + RCAS 0.7': { chain: RS, sharp: 0.7, sharpen: 'rcas' },
        'RS + NIS 0.25': { chain: RS, sharp: 0.25, sharpen: 'nis' },
        'RS + NIS 0.5': { chain: RS, sharp: 0.5, sharpen: 'nis' },
        'RS + adaptive 0.5': { chain: [...RS, AS('0.5')], sharp: 0 },
        'RS + adaptive 1.0': { chain: [...RS, AS('1.0')], sharp: 0 },
        'RS + Darken + RCAS 0.5': { chain: [...RS, g('Anime4K_Darken_HQ')], sharp: 0.5, sharpen: 'rcas' },
        'RS + Thin + RCAS 0.5': { chain: [...RS, g('Anime4K_Thin_HQ')], sharp: 0.5, sharpen: 'rcas' },
        'RS + Darken + Thin + RCAS 0.5': { chain: [...RS, g('Anime4K_Darken_HQ'), g('Anime4K_Thin_HQ')], sharp: 0.5, sharpen: 'rcas' },
        'RS + Deblur DoG': { chain: [...RS, g('Anime4K_Deblur_DoG')], sharp: 0 },
        'RS + Deblur Original': { chain: [...RS, g('Anime4K_Deblur_Original')], sharp: 0 },
        'Clamp + RS + RCAS 0.5': { chain: [g('Anime4K_Clamp_Highlights'), ...RS], sharp: 0.5, sharpen: 'rcas' },
      };
      const SHEETS = [
        ['билинейно', BASE, 'RS без резкости', 'RM + RCAS 0.5 (480p сейчас)'],
        [BASE, 'RS + RCAS 0.3', 'RS + RCAS 0.7', 'RS + NIS 0.25'],
        [BASE, 'RS + NIS 0.5', 'RS + adaptive 0.5', 'RS + adaptive 1.0'],
        [BASE, 'RS + Darken + RCAS 0.5', 'RS + Thin + RCAS 0.5', 'RS + Darken + Thin + RCAS 0.5'],
        [BASE, 'RS + Deblur DoG', 'RS + Deblur Original', 'Clamp + RS + RCAS 0.5'],
      ];
      const out = {}; const crops = {};
      const cw = 360, chh = 220, cx0 = Math.round(W / 2 - cw / 2), cy0 = Math.round(H / 2 - chh / 2);
      const cropFrom = (canvas, scale) => { const c = new OffscreenCanvas(cw * 2, chh * 2); c.getContext('2d').drawImage(canvas, cx0 * scale, cy0 * scale, cw * scale, chh * scale, 0, 0, cw * 2, chh * 2); return c; };
      const part = new OffscreenCanvas(cw, chh); part.getContext('2d').drawImage(fr, cx0, cy0, cw, chh, 0, 0, cw, chh);
      for (const [name, opt] of Object.entries(VARIANTS)) {
        let d; let ms = 0;
        try {
          if (!opt) { const b = new OffscreenCanvas(W, H); const bx = b.getContext('2d'); bx.imageSmoothingQuality = 'low'; bx.drawImage(sm, 0, 0, W, H); d = bx.getImageData(0, 0, W, H).data; }
          else {
            const a = createAnime4K(document.createElement('video'), opt);
            await a.render(sm, w, h);
            const oc = new OffscreenCanvas(W, H); const ocx = oc.getContext('2d'); ocx.drawImage(a.canvas, 0, 0); d = ocx.getImageData(0, 0, W, H).data;
            ms = +(await a.bench(W, H, 7)).toFixed(2);
            a.dispose();
            const a2 = createAnime4K(document.createElement('video'), opt);
            await a2.render(part, cw, chh);
            const cc = new OffscreenCanvas(cw * 2, chh * 2); const ccx = cc.getContext('2d'); ccx.drawImage(a2.canvas, 0, 0); ccx.getImageData(0, 0, 1, 1); crops[name] = cc;
            a2.dispose();
          }
          out[name] = { ...score(d), ms };
        } catch (e) { out[name] = { error: String(e && e.message || e).slice(0, 300) }; }
      }
      const bl = new OffscreenCanvas(W * 2, H * 2); bl.getContext('2d').drawImage(fr, 0, 0, W * 2, H * 2); crops['билинейно'] = cropFrom(bl, 2);
      const pngs = [];
      for (const names of SHEETS) {
        const sheet = new OffscreenCanvas(2 * cw * 2, 2 * (chh * 2 + 28)); const s = sheet.getContext('2d');
        s.fillStyle = '#000'; s.fillRect(0, 0, sheet.width, sheet.height); s.font = '20px sans-serif';
        names.forEach((nm, k) => { const x = (k % 2) * cw * 2; const y = Math.floor(k / 2) * (chh * 2 + 28); s.fillStyle = '#fff'; s.fillText(nm, x + 8, y + 21); if (crops[nm]) s.drawImage(crops[nm], x, y + 28); });
        const blob = await sheet.convertToBlob({ type: 'image/png' });
        pngs.push(await new Promise((ok) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result).split(',')[1]); rd.readAsDataURL(blob); }));
      }
      return { size: [W, H], out, pngs };
    })()`);
    r.pngs.forEach((p, k) => fs.writeFileSync(path.join(OUT, `a4k2-scene${n}-sheet${k + 1}.png`), Buffer.from(p, 'base64')));
    all[n] = r.out;
    console.log(JSON.stringify({ scene: n, size: r.size, out: r.out }));
  }
  fs.writeFileSync(path.join(OUT, 'a4k2-results.json'), JSON.stringify(all, null, 1));
  app.exit(0);
}).catch((e) => { console.log('FAIL', e && e.message); app.exit(1); });
