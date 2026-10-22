// Телефон: тянет ли он улучшение нейросетью — шейдеры Anime4K фрагментными шейдерами WebGL2 (anime4k-gl.js). Проверка —
// один раз в фоне (app.js): время кадра цепочек (CHAINS: Restore M + M, Restore S + M, M — на 480p и 720p; Restore S без
// увеличения — на 1080p); ответ — в localStorage (KEY: { ms: { '480': { rm, rs, m }, '720': {…}, '1080': { r } }, v }).
// Пункт «Нейросеть» в меню — только если хоть одна цепочка где-то успевает; на серии берётся лучшая, что успевает на её
// разрешении, во время просмотра — легче, если
// телефон перестал успевать (player.js); ни одна — резкость (sharpen.js). Выбрать вручную то, что телефон не потянет,
// нельзя. На ПК — свой апскейл (upscale/), выбрать можно всё.
// CHECK — версия проверки: шейдеры или способ поменялись — проверить заново
import { CHAINS, CHAIN_FOR } from '../anime4k-gl.js';

export const KEY = 'anix.a4k';
export const CHECK = 14; // 3 — цепочки с Restore; 4 — и 1080p (Restore без увеличения); 5 — лучший прогон; 6 — в простое; 7 — fp16 и texelFetch; 8 — и проверка картинки; 9 — с дебандингом; 10 — дебандинг легче; 11 — замер пачкой кадров; 12 — и ACNet; 13 — и Anix SR; 14 — снова только Anime4K
const BUDGET = (1000 / 24) * 0.9; // мс на кадр: 24 к/с с запасом (не успеет на деле — player.js облегчит на ходу)

const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };

export function checkDue() { const r = load(); return !r || r.v !== CHECK; }

export async function checkPhone(log = (m) => window.__anixLog?.(m)) {
  log('anime4k: проверка телефона…');
  const { createAnime4K } = await import('../anime4k-gl.js');
  const r = { ms: {}, v: CHECK };
  const SIZE = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080] };
  for (const [cls, names] of Object.entries(CHAIN_FOR)) {
    r.ms[cls] = {};
    for (const name of names) {
      const a = createAnime4K(document.createElement('video'), { chain: CHAINS[name] });
      try { r.ms[cls][name] = await a.bench(...SIZE[cls]); } catch (e) { r.ms[cls][name] = -1; r.error = String(e && e.message || e); } finally { a.dispose(); }
      await new Promise((ok) => setTimeout(ok, 300));
    }
  }
  // цена дебандинга: rm 720p с ним и без, подряд (в журнал)
  try {
    const t = async (deband) => { const a = createAnime4K(document.createElement('video'), { chain: CHAINS.rm, deband }); try { return await a.bench(1280, 720); } finally { a.dispose(); } };
    const r2 = []; for (let i = 0; i < 3; i++) r2.push([await t(false), await t(true)]); // по очереди: нагрев — поровну
    log(`anime4k: дебандинг на 720p rm: ${r2.map(([a, b]) => `без ${a.toFixed(0)} / с ним ${b.toFixed(0)}`).join(', ')} мс`);
  } catch { /* ignore */ }
  try { log(`anime4k: картинка ${await picture(createAnime4K)}`); } catch (e) { log(`anime4k: проверка картинки не удалась: ${e && e.message}`); }
  try { localStorage.setItem(KEY, JSON.stringify(r)); localStorage.removeItem(CAP); } catch { /* ignore */ }
  log(`anime4k: ${Object.entries(r.ms).map(([c, m]) => `${c}p ${Object.entries(m).map(([n, x]) => `${n} ${x.toFixed(0)}`).join(' ')}`).join(', ')} мс → ${neuralOk() ? 'нейросеть есть' : 'только резкость'}${r.error ? ` (${r.error})` : ''}`);
  return r;
}

// Меняет ли цепочка картинку на самом деле (fp16 на телефоне — не на ПК, где проверяли): тестовый кадр с линиями и
// градиентом -> rm в fp16 и в полной точности -> средняя разница (0–255) с простым растяжением и между собой
async function picture(createAnime4K) {
  const W = 640; const H = 360;
  const src = new OffscreenCanvas(W, H); const c = src.getContext('2d');
  const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#f2c49b'); g.addColorStop(1, '#2b4c7e'); c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#1a1a1a'; c.lineWidth = 1.5; for (let i = 0; i < 24; i++) { c.beginPath(); c.arc(80 + i * 22, 180 + Math.sin(i) * 60, 30 + i, 0, 5); c.stroke(); }
  c.fillStyle = '#fff'; c.font = '28px sans-serif'; c.fillText('Anix 720p', 220, 80);
  const shrink = new OffscreenCanvas(W / 2, H / 2); shrink.getContext('2d').drawImage(src, 0, 0, W / 2, H / 2); // кадр «маленький»
  const read = (cv) => { const o = new OffscreenCanvas(W, H); const x = o.getContext('2d'); x.drawImage(cv, 0, 0, W, H); return x.getImageData(0, 0, W, H).data; };
  const run = async (full) => { const a = createAnime4K(document.createElement('video'), { chain: CHAINS.rm, full }); try { await a.render(shrink, W / 2, H / 2); return read(a.canvas); } finally { a.dispose(); } };
  const plain = read(shrink); const f16 = await run(false); const f32 = await run(true);
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return (s / (a.length / 4 * 3)).toFixed(2); };
  return `от простого растяжения: fp16 ${diff(f16, plain)}, полная точность ${diff(f32, plain)}; fp16 от полной ${diff(f16, f32)}`;
}

const fits = (ms) => ms > 0 && ms <= BUDGET;
// нейросеть в меню: хоть одна цепочка успевает хоть на одном разрешении
export function neuralOk() { const r = load(); return !!r && !!r.ms && Object.values(r.ms).some((m) => Object.values(m).some(fits)); }
// лучшая цепочка, что успевает на источнике такого размера (по 16:9; 4:3 «720p» — 1280x960 — как 720p), не лучше
// from-й по списку класса (после облегчения во время просмотра, player.js); null — ни одна
export function pickChain(w, h, from = 0) {
  const r = load(); if (!r || !r.ms || !w) return null;
  const h169 = Math.min(h, Math.round(w * 9 / 16));
  const cls = h169 <= 480 ? 480 : h169 <= 720 ? 720 : h169 <= 1080 ? 1080 : 0;
  const names = CHAIN_FOR[cls] || [];
  for (let i = from; i < names.length; i++) if (fits((r.ms[cls] || {})[names[i]])) return names[i];
  return null;
}
// Облегчение запоминается (CAP: { '720': 1, … } — с какой по списку цепочки начинать): замер на старте шумит (видеокарта
// разгоняется не сразу), а если на деле цепочка не успела, следующие серии того же разрешения сразу начинаются с той,
// что успевает. Новая проверка телефона память сбрасывает
const CAP = 'anix.a4k.cap';
const clsOf = (w, h) => { const h169 = Math.min(h, Math.round(w * 9 / 16)); return h169 <= 480 ? 480 : h169 <= 720 ? 720 : 1080; };
export function capFor(w, h) { try { return (JSON.parse(localStorage.getItem(CAP) || '{}'))[clsOf(w, h)] || 0; } catch { return 0; } }
// после name на этом источнике — следующая по лёгкости (индекс в списке класса); запоминается
export function lighterFrom(w, h, name) {
  const cls = clsOf(w, h); const i = (CHAIN_FOR[cls] || []).indexOf(name) + 1;
  try { const c = JSON.parse(localStorage.getItem(CAP) || '{}'); c[cls] = Math.max(c[cls] || 0, i); localStorage.setItem(CAP, JSON.stringify(c)); } catch { /* ignore */ }
  return i;
}
