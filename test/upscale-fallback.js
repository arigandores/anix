'use strict';
// Улучшение картинки без ускорения NVIDIA — как у пользователей с другими видеокартами (имитация на этой машине):
//   driver — GeForce со старым драйвером (CUDA 13 не запускается): подсказка «обновите драйвер», работа на WebGPU
//   gtx    — GeForce без тензорных ядер (GTX 10, compute capability 6.1): ускорения нет, работа на WebGPU
//   amd    — нет NVIDIA (AMD / Intel): WebGPU на программном адаптере SwiftShader, ускорение не показывается
//   hang   — anix-trt не отвечает: через ANIX_TRT_PROBE_MS считается недоступной, улучшение не ждёт её вечно
//   nof16  — видеокарта без shader-f16 (часть AMD / Intel): модели в f32 на настоящей видеокарте и на живой серии
//   radeon — встроенная AMD Radeon (если включён гибридный режим видеокарт; иначе пропуск)
// Запуск: electron test/upscale-fallback.js — все сценарии по очереди, каждый своим процессом Electron
// (electron test/upscale-fallback.js <сценарий> — один). Аккаунт Anixart не затрагивается.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CASES = {
  driver: { probe: { error: 'CUDA driver version is insufficient for CUDA runtime version' }, nvidia: '1' },
  gtx: { probe: { gpu: 'NVIDIA GeForce GTX 1060 6GB', cc: 6.1 }, nvidia: '1' },
  amd: { probe: { error: 'CUDA driver version is insufficient for CUDA runtime version' }, nvidia: '0', swiftshader: true },
  hang: { probe: 'hang', nvidia: '1', probeMs: 3000 },
  nof16: { probe: { gpu: 'NVIDIA GeForce GTX 1060 6GB', cc: 6.1 }, nvidia: '1', noF16: true },
  radeon: { probe: { error: 'CUDA driver version is insufficient for CUDA runtime version' }, nvidia: '0', lowPower: true },
};
const SLOW = (c) => c.swiftshader || c.lowPower; // медленный адаптер: «не успевает» — тоже правильный исход
// Видеокарта занята не нами (игра): загрузка по nvidia-smi до запуска плеера, медиана 5 замеров за ~1,5 с, выше BUSY% —
// строка «87% · 11528 МБ», иначе '' (свободна или nvidia-smi нет)
const BUSY = 30;
async function otherGpuLoad() {
  const { execFileSync } = require('child_process');
  const xs = [];
  for (let i = 0; i < 5; i++) {
    try { xs.push(execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/)[0].split(',').map(Number)); } catch { return ''; }
    await new Promise((r) => setTimeout(r, 300));
  }
  xs.sort((a, b) => a[0] - b[0]);
  const [util, mem] = xs[2];
  return util > BUSY ? `${util}% · ${mem} МБ` : '';
}
const mode = process.argv.find((a) => CASES[a]);

if (!mode) {
  // все сценарии по очереди: у каждого свои переменные окружения и ключи командной строки
  const { spawnSync } = require('child_process');
  const electron = process.versions.electron ? process.execPath : require('electron'); // в Electron require('electron') — API, не путь
  let bad = 0;
  for (const name of Object.keys(CASES)) {
    const os = require('os'); const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anix-fallback-${name}-`));
    const r = spawnSync(electron, [path.join(ROOT, 'test', '_isolated.js'), dir, __filename, name], { encoding: 'utf8', timeout: 240000 });
    const out = (r.stdout || '') + (r.stderr || '').split('\n').filter((l) => /FAIL|Error/.test(l)).join('\n');
    process.stdout.write(out);
    if (r.status !== 0 || /\bFAIL\b/.test(out)) bad++;
  }
  console.log(bad ? `UPSCALE-FALLBACK FAIL: ${bad}` : 'UPSCALE-FALLBACK OK');
  if (process.versions.electron) require('electron').app.exit(bad ? 1 : 0); else process.exit(bad ? 1 : 0);
  return;
}

const C = CASES[mode];
process.env.ANIX_TRT_PROBE = typeof C.probe === 'string' ? C.probe : JSON.stringify(C.probe);
process.env.ANIX_GPU_NVIDIA = C.nvidia;
if (C.probeMs) process.env.ANIX_TRT_PROBE_MS = String(C.probeMs);
const { app, BrowserWindow, ipcMain } = require('electron');
if (C.lowPower) app.commandLine.appendSwitch('force_low_power_gpu');
if (C.swiftshader) { app.commandLine.appendSwitch('use-webgpu-adapter', 'swiftshader'); app.commandLine.appendSwitch('enable-unsafe-swiftshader'); app.commandLine.appendSwitch('enable-unsafe-webgpu'); }
const { start } = require('../server');
require('../electron/trt').register(ipcMain);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(() => main().catch((e) => { console.log(`FAIL [${mode}] исключение: ${e && e.message}`); app.exit(1); }));
async function main() {
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1700, height: 1000, show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, preload: path.join(ROOT, 'electron', 'preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  win.webContents.setFrameRate(60);
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(String(e.message).slice(0, 300)); if (/\[upscale\]/.test(e.message)) console.log(`   [${mode}] консоль: ${String(e.message).slice(0, 300)}`); });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true);
  const fails = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok ' : 'FAIL'} [${mode}] ${what}`); if (!ok) fails.push(what); };

  // без shader-f16: страница не видит эту возможность — движок выбирает f32, как на таких видеокартах
  if (C.noF16) await js(`(() => { const has = GPUSupportedFeatures.prototype.has; GPUSupportedFeatures.prototype.has = function (f) { return f === 'shader-f16' ? false : has.call(this, f); }; })(); 1`);
  const adapter = await js(`(async () => { const a = await navigator.gpu.requestAdapter(); return a ? [a.info.vendor, a.info.description || a.info.architecture, a.features.has('shader-f16') ? 'f16' : 'f32'].join(' · ') : 'нет'; })()`);
  console.log(`   [${mode}] WebGPU: ${adapter}`);
  if (mode === 'radeon' && !/^amd/i.test(adapter)) { console.log(`   [radeon] SKIP: встроенная Radeon недоступна (режим только дискретной видеокарты) — WebGPU: ${adapter}`); app.exit(0); return; }
  const t0 = Date.now();
  const st = await js(`(async () => (await import('/js/upscale/bench.js')).trtStatus())()`);
  const waited = Date.now() - t0;
  const want = { driver: 'driver', gtx: undefined, amd: 'gpu', hang: 'gpu', nof16: undefined, radeon: 'gpu' }[mode];
  check(!st.supported && st.reason === want, `состояние ускорения: supported ${st.supported}, reason ${st.reason}${st.error ? ` (${st.error})` : ''} за ${waited} мс`);
  if (mode === 'hang') check(waited < 6000, `зависшая проверка не держит дольше тайм-аута (${waited} мс)`);

  // без shader-f16 (часть AMD / Intel): модели считаются в f32 — проверяем на маленьком кадре, что результат верный
  if (C.swiftshader || C.noF16 || C.lowPower) {
    for (const id of ['artcnn-c4f16', 'janai-v31-perf', 'janai-sd-compact']) {
      const r = await js(`(async () => {
        const E = await import('/js/upscale/engine.js');
        const { device, f16 } = await E.getGpu();
        const spec = await E.loadModel(${JSON.stringify(id)}); const up = await E.createUpscaler(spec);
        const W = 96, H = 64; const cv = new OffscreenCanvas(W, H); const cx = cv.getContext('2d');
        cx.fillStyle = '#e8d0b0'; cx.fillRect(0, 0, W, H); cx.strokeStyle = '#202028'; cx.lineWidth = 3;
        for (let i = 0; i < 4; i++) { cx.beginPath(); cx.arc(48, 32, 8 + i * 7, 0, 6.2); cx.stroke(); }
        const src = cx.getImageData(0, 0, W, H).data; const frame = new VideoFrame(cv, { timestamp: 0 }); up.setSize(W, H);
        const W2 = W * 2, H2 = H * 2, bpr = Math.ceil(W2 * 8 / 256) * 256;
        const rb = device.createBuffer({ size: bpr * H2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = device.createCommandEncoder(); up.encode(enc, frame); enc.copyTextureToBuffer({ texture: up.output }, { buffer: rb, bytesPerRow: bpr }, [W2, H2]);
        device.queue.submit([enc.finish()]); await rb.mapAsync(GPUMapMode.READ);
        const u16 = new Uint16Array(rb.getMappedRange().slice(0)); rb.unmap(); frame.close(); up.destroy();
        const h2f = (hb) => { const s = hb & 0x8000 ? -1 : 1; const e = (hb >> 10) & 31; const m = hb & 1023; return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15); };
        const C = spec.in === 'luma' ? 1 : 3; let se = 0, n = 0, bad = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < C; c++) {
          let v = 0; for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) v += h2f(u16[(y * 2 + dy) * bpr / 2 + (x * 2 + dx) * 4 + c]) / 4;
          if (!isFinite(v)) { bad++; continue; } const p = (y * W + x) * 4;
          const ref = C === 1 ? (0.2126 * src[p] + 0.7152 * src[p + 1] + 0.0722 * src[p + 2]) / 255 : src[p + c] / 255;
          se += (Math.min(1, Math.max(0, v)) - ref) ** 2; n++;
        }
        return { f16, psnr: +(10 * Math.log10(1 / (se / n))).toFixed(1), bad };
      })()`);
      check((C.lowPower || !r.f16) && r.bad === 0 && r.psnr > 26, `${id} в ${r.f16 ? 'f16' : 'f32 (без shader-f16)'}: PSNR после обратного уменьшения ${r.psnr} дБ, NaN ${r.bad}`);
    }
  }

  // настройки: подсказка про драйвер только для NVIDIA со старым драйвером; иначе пункта нет
  const navErr = await js(`(async () => { try { await import('/js/screens/settings.js'); (await import('/js/router.js')).navigate('settings', { section: 'picture' }); return ''; } catch (e) { return String(e && e.stack || e); } })()`);
  if (navErr) console.log(`   [${mode}] переход в настройки: ${navErr.slice(0, 300)}`);
  let settingsText = '';
  // пока грузится главная, router не начинает второй переход — повторяем, пока настройки не откроются
  for (let i = 0; i < 40 && !/Улучшение картинки/.test(settingsText); i++) {
    await sleep(400); settingsText = await js(`document.querySelector('#viewport').textContent`);
    if (!/Улучшение картинки/.test(settingsText) && i % 5 === 4) await js(`(async () => { (await import('/js/router.js')).navigate('settings', { section: 'picture' }); })(); 1`);
  }
  await sleep(500); settingsText = await js(`document.querySelector('#viewport').textContent`);
  check(/Улучшение картинки/.test(settingsText), `экран настроек открыт (${settingsText.length} символов${/Улучшение картинки/.test(settingsText) ? '' : `: ${settingsText.slice(0, 120)}`})`);
  const hasHint = /Обновите драйвер видеокарты NVIDIA/.test(settingsText); const hasTrt = /Ускорение NVIDIA/.test(settingsText);
  check(mode === 'driver' ? hasHint : !hasTrt, `настройки: ${hasHint ? 'подсказка про драйвер' : hasTrt ? 'пункт ускорения есть' : 'пункта ускорения нет'}`);

  // загрузка видеокарты чужими приложениями — до запуска плеера (иначе в замер попадёт наше же улучшение)
  const busy = SLOW(C) ? '' : await otherGpuLoad();
  // плеер: «Атака титанов 3», Kodik — «Авто» работает на WebGPU
  await js(`localStorage.setItem('anixart.pref.SELECTED_PLAYER','2'); localStorage.setItem('anixart.pref.ON_EPISODE_DISCLAIMER','true'); localStorage.setItem('anixart.pref.UPSCALE_MODE', JSON.stringify('auto')); 1`);
  await js(`(async () => { const { getGpu } = await import('/js/upscale/engine.js'); const { gpuKey } = await import('/js/upscale/bench.js');
    localStorage.setItem('anixart.pref.UPSCALE_BENCH_LATER', JSON.stringify(gpuKey((await getGpu()).info) + '|false')); })()`);
  await js(`(async () => {
    const { A } = await import('/js/api.js');
    const types = (await A.types(2487)).types; const ty = types.find((x) => x.name === 'Studio Band') || types[0];
    const so = (await A.sources(2487, ty.id)).sources.find((s) => /kodik/i.test(s.name));
    (await import('/js/router.js')).navigate('episodes', { release: { id: 2487, title_ru: 'Атака титанов 3' }, type: ty, source: so });
  })(); 1`);
  await sleep(3500);
  await js(`document.querySelector('#viewport .screen:last-child .ep-row').click(); 1`);
  for (let i = 0; i < 60 && !(await js(`!!document.querySelector('.player-overlay video') && document.querySelector('.player-overlay video').readyState >= 2`)); i++) await sleep(250);
  await js(`document.querySelectorAll('.backdrop').forEach((b) => b.querySelector('.sheet-item')?.click()); 1`);
  await js(`(() => { const v = document.querySelector('.player-overlay video'); v.muted = true; v.currentTime = 300; v.play(); })(); 1`);
  // программный адаптер медленный: «Авто» может честно сказать, что не успевает, — это тоже правильный исход
  let s = null;
  for (let i = 0; i < (SLOW(C) ? 480 : 80); i++) {
    await sleep(250);
    s = await js(`(() => { const u = document.querySelector('.player-overlay').upscale; return { state: u.status.state, text: u.status.text, stages: u.debug.stages }; })()`);
    if (s.state === 'on' || s.state === 'idle' || s.state === 'error') break;
  }
  const noTrt = s.stages.every((x) => !/:trt$/.test(x));
  check(noTrt, `«Авто» без TensorRT: ${s.stages.join(' + ') || 'без модели'}`);
  // скорость меряется на настоящей видеокарте: её занимает другое приложение (игра) — «не успевает» и рывки честные,
  // проверять скорость нельзя (ложный провал), остальное проверяем
  const perf = (ok, what) => (busy ? console.log(`SKIP [${mode}] ${what} — видеокарту занимает другое приложение: ${busy}`) : check(ok, what));
  perf(s.state === 'on' || (SLOW(C) && s.state === 'idle'), `«Авто» без ускорения: ${s.state} · ${s.text || '—'} · ${s.stages.join(' + ') || 'без модели'}`);
  // плавность: за 5 с улучшен почти каждый кадр, пропусков нет
  if (s.state === 'on') {
    await sleep(3000);
    const q = () => js(`(() => { const ov = document.querySelector('.player-overlay'); const p = ov.querySelector('video').getVideoPlaybackQuality(); return { drawn: ov.upscale.debug.drawn, total: p.totalVideoFrames, dropped: p.droppedVideoFrames, ms: Math.round(ov.upscale.debug.lastMs) }; })()`);
    const a0 = await q(); await sleep(5000); const a1 = await q();
    const total = a1.total - a0.total; const drawn = a1.drawn - a0.drawn; const dropped = a1.dropped - a0.dropped;
    perf(SLOW(C) || (total > 90 && drawn >= total * 0.9 && dropped === 0), `плавно: кадров ${total}, улучшено ${drawn}, пропущено ${dropped}, ${a1.ms} мс`);
  }
  // меню плеера: строка ускорения — подсказка (driver) или её нет
  await js(`document.querySelector('.player-controls .gear').click(); [...document.querySelectorAll('.player-menu .pm-row')].find((x) => /Улучшение/.test(x.textContent)).click(); 1`);
  await sleep(500);
  const menuText = await js(`document.querySelector('.player-menu').innerText`);
  const mHint = /Обновите драйвер/.test(menuText); const mTrt = /Ускорение NVIDIA/.test(menuText);
  check(mode === 'driver' ? mHint : !mTrt, `меню плеера: ${mHint ? 'подсказка про драйвер' : mTrt ? 'строка ускорения есть' : 'строки ускорения нет'}`);
  check(!errors.length, `консоль без ошибок${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  app.exit(fails.length ? 1 : 0);
}
