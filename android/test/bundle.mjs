// Модули server/ в сборке для Android (android/server.js из sync-web.mjs) работают как в Node:
// замены Buffer и crypto, подпись запросов, PKCE для входа через соцсети, ключи из config.local.json.
// node android/test/bundle.mjs — без телефона и эмулятора
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) failed++; };

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'anix-bundle-'));
try {
  execFileSync('node', [path.join(root, 'android', 'tools', 'sync-web.mjs'), out], { stdio: 'ignore' });
  const src = fs.readFileSync(path.join(out, 'android', 'server.js'), 'utf8');
  const cut = src.indexOf('// Android: то, что на ПК');
  check('в сборке есть модули server/ и shim.js', cut > 0);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  check('index.html: server.js — первым скриптом, android.css — после app.css',
    html.indexOf('/android/server.js') > 0 && html.indexOf('/android/server.js') < html.indexOf('<script', html.indexOf('/android/server.js') + 30)
    && html.indexOf('/android/android.css') > html.indexOf('/css/app.css'));
  check('модели апскейла в сборку не попали', !fs.existsSync(path.join(out, 'models')));

  // app.css: правила с :hover — только при наведении мышью (на телефоне :hover залипает после тапа), общей полосы
  // прокрутки ПК (::-webkit-scrollbar) нет — она держала колонку справа; остальное как было
  const SCROLLBAR = /(^|\})\s*::-webkit-scrollbar[^{]*\{[^}]*\}/g;
  const orig = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(SCROLLBAR, '$1');
  const conv = fs.readFileSync(path.join(out, 'css', 'app.css'), 'utf8');
  check('app.css для Android: без общей полосы прокрутки ПК', !/(^|\})\s*::-webkit-scrollbar/.test(conv) && /\.tabbar\.scrollable::-webkit-scrollbar/.test(conv));
  const balanced = (c) => { let d = 0; for (const ch of c) { if (ch === '{') d++; else if (ch === '}') d--; if (d < 0) return false; } return d === 0; };
  check('app.css для Android: скобки на месте', balanced(conv));
  const outside = conv.replace(/@media \(hover: hover\) \{[^{}]*\{[^{}]*\} \}/g, '');
  check('app.css для Android: :hover — только внутри @media (hover: hover)', !/:hover/.test(outside), (outside.match(/[^{}]*:hover[^{]*/) || [''])[0].trim().slice(0, 80));
  const count = (c, re) => (c.match(re) || []).length;
  check('app.css для Android: ни одно правило с :hover не потерялось', count(conv, /:hover/g) === count(orig, /:hover/g), `${count(orig, /:hover/g)} → ${count(conv, /:hover/g)}`);
  const decl = (c) => count(c.replace(/@media \(hover: hover\) \{/g, ''), /\{/g);
  check('app.css для Android: правил столько же (плюс разделённые списки)', decl(conv) >= decl(orig) && decl(conv) <= decl(orig) + count(orig, /:hover/g), `${decl(orig)} → ${decl(conv)}`);

  const ctx = vm.createContext({ atob, btoa, TextEncoder, TextDecoder, crypto: globalThis.crypto, console, URL, URLSearchParams, AbortSignal, setTimeout });
  vm.runInContext(`${src.slice(0, cut)}\nthis.R = __anixRequire;`, ctx);
  const { Buffer: B, crypto: C } = ctx.R.shims;

  // SHA-256: известные векторы и границы блоков (55/56/64 байта), utf-8
  const vectors = ['', 'abc', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'я'.repeat(1000)];
  const bad = vectors.filter((v) => C.createHash('sha256').update(v).digest('hex') !== crypto.createHash('sha256').update(v).digest('hex'));
  check('createHash(sha256) совпадает с Node', !bad.length, bad.map((v) => v.slice(0, 10)).join(', '));
  check('randomBytes(32) — 32 случайных байта', C.randomBytes(32).length === 32 && C.randomBytes(32).toString('hex') !== C.randomBytes(32).toString('hex'));
  const ints = Array.from({ length: 2000 }, () => C.randomInt(10));
  check('randomInt(10) — 0…9, все значения', ints.every((n) => n >= 0 && n < 10) && new Set(ints).size === 10);

  // Buffer: base64 туда и обратно, url-safe и без «=» (Kodik), utf-8
  const texts = ['', 'a', 'ab', 'abc', 'Привет, мир', '🙂 emoji'];
  check('Buffer base64 ↔ utf8 как в Node', texts.every((s) => B.from(s, 'utf8').toString('base64') === Buffer.from(s, 'utf8').toString('base64')
    && B.from(Buffer.from(s).toString('base64'), 'base64').toString('utf8') === s));
  const urlSafe = Buffer.from('ÿþý?>~ subjects?').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  check('Buffer base64: url-safe и без «=»', B.from(urlSafe, 'base64').toString('utf8') === Buffer.from(urlSafe, 'base64').toString('utf8'));

  // Подпись: тот же формат заголовков, что у server/sign.js
  const sign = ctx.R('/server/sign.js');
  const real = require(path.join(root, 'server', 'sign.js'));
  const h = sign.apiHeaders(); const hr = real.apiHeaders();
  check('apiHeaders: те же заголовки и User-Agent', JSON.stringify(Object.keys(h)) === JSON.stringify(Object.keys(hr)) && h['User-Agent'] === hr['User-Agent']);
  const lens = new Set(Array.from({ length: 50 }, () => sign.sign(34).length));
  const realLens = new Set(Array.from({ length: 50 }, () => real.sign(34).length));
  check('Sign: длины как у Node-версии', [...lens].every((l) => realLens.has(l) || Math.abs(l - [...realLens][0]) <= 8), [...lens].join(','));

  // PKCE (VK, Telegram): challenge = base64url(SHA-256(verifier)); у каждого входа свой verifier
  const social = ctx.R('/server/social.js');
  const cfg = ctx.R('/server/config.js');
  const prov = ['vk', 'telegram'].find((p) => cfg.features().social[p]);
  if (prov) {
    const r1 = social.authRequest(prov); const r2 = social.authRequest(prov);
    const challenge = new URL(r1.url).searchParams.get('code_challenge');
    const expect = crypto.createHash('sha256').update(r1.verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    check(`PKCE ${prov}: code_challenge = SHA-256(verifier)`, challenge === expect);
    check(`PKCE ${prov}: verifier каждый раз новый`, r1.verifier !== r2.verifier && r1.verifier.length >= 43);
  } else console.log('SKIP PKCE — нет ключей VK/Telegram в config.local.json');
  check('ключи из config.local.json — как на ПК', JSON.stringify(cfg.features()) === JSON.stringify(require(path.join(root, 'server', 'config.js')).features()));
  check('парсеры загружаются', typeof ctx.R('/server/parsers/index.js').parse === 'function');
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
if (failed) { console.log(`FAIL bundle: ${failed}`); process.exit(1); }
console.log('OK bundle');
