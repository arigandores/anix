// Собирает фронтенд для Android: копия public/ (без моделей апскейла — TensorRT/WebGPU на телефоне пока нет)
// + android/server.js: модули server/, которые работают в WebView (подпись, парсеры, ключи), и android/web/shim.js.
// Запускается из Gradle (app/build.gradle.kts, задача syncWeb): node android/tools/sync-web.mjs <куда>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.resolve(process.argv[2] || path.join(root, 'android', 'app', 'build', 'web', 'www'));
const SKIP = new Set(['models']);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'public'))) {
  if (SKIP.has(name)) continue;
  fs.cpSync(path.join(root, 'public', name), path.join(out, name), { recursive: true });
}

// Копия app.css для пальца. :hover на телефоне «залипает» после тапа (подсветка остаётся на нажатой кнопке) — правила
// с :hover действуют только там, где есть наведение: @media (hover: hover). В списке селекторов «.a:hover,
// .a:focus-visible» без :hover остаётся снаружи. Общая полоса прокрутки ПК (::-webkit-scrollbar шириной 10px) убрана:
// с ней WebView держит под полосу колонку справа, и отступ справа шире левого; без неё — системная полоса поверх
// содержимого, как в приложениях Android. Комментарии убираются (внутри них бывают скобки)
function forTouch(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let outCss = ''; let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) { outCss += css.slice(i); break; }
    const head = css.slice(i, open);
    let depth = 1; let j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const body = css.slice(open + 1, j - 1);
    const sel = head.trim();
    if (sel.startsWith('@media') || sel.startsWith('@supports') || sel.startsWith('@layer')) outCss += `${head}{${forTouch(body)}}`;
    else if (sel.startsWith('::-webkit-scrollbar')) { /* полоса прокрутки ПК */ }
    else if (sel.startsWith('@') || !sel.includes(':hover')) outCss += `${head}{${body}}`;
    else {
      const parts = sel.split(/,(?![^(]*\))/).map((s) => s.trim());
      const hover = parts.filter((s) => s.includes(':hover')); const rest = parts.filter((s) => !s.includes(':hover'));
      if (rest.length) outCss += `\n${rest.join(', ')} {${body}}`;
      outCss += `\n@media (hover: hover) { ${hover.join(', ')} {${body}} }`;
    }
    i = j;
  }
  return outCss;
}
const cssFile = path.join(out, 'css', 'app.css');
fs.writeFileSync(cssFile, forTouch(fs.readFileSync(cssFile, 'utf8')));

// Модули server/ в обёртке CommonJS. Node-модули, которые им нужны, — маленькие замены ниже (SHIMS)
const MODULES = ['server/sign.js', 'server/config.js', 'server/social.js', 'server/parsers/index.js', 'server/parsers/skip-marks.js'];
const wrapped = MODULES.map((m) => {
  const src = fs.readFileSync(path.join(root, m), 'utf8');
  return `${JSON.stringify('/' + m)}: function (module, exports, require, __dirname, __filename, process, Buffer, fetch) {\n${src}\n}`;
}).join(',\n');

// Ключи источников — как на ПК: config.local.json кладётся в сборку (build/release.js)
let configText = '{}';
try { configText = fs.readFileSync(path.join(root, 'config.local.json'), 'utf8'); JSON.parse(configText); } catch { configText = '{}'; }
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const bundle = `// Собрано android/tools/sync-web.mjs — не править вручную
var APP_VERSION = ${JSON.stringify(version)};
var __anixRequire, __anixSetFetch;
(function () {
  'use strict';
  var CONFIG_TEXT = ${JSON.stringify(configText)};
  var relay = function () { return Promise.reject(new TypeError('fetch is not ready')); };
  var fetchProxy = function (u, o) { return relay(u, o); };
  __anixSetFetch = function (f) { relay = f; };

  // Buffer: только то, чем пользуются модули server/ (base64 и utf8)
  function decodeB64(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    while (s.length % 4) s += '=';
    var bin = atob(s); var b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }
  function Buf(bytes) { this.bytes = bytes; this.length = bytes.length; }
  Buf.prototype.toString = function (enc) {
    if (enc === 'base64') { var bin = ''; for (var i = 0; i < this.bytes.length; i++) bin += String.fromCharCode(this.bytes[i]); return btoa(bin); }
    return new TextDecoder().decode(this.bytes);
  };
  Buf.prototype.toString = (function (base) {
    return function (enc) { if (enc === 'hex') { var s = ''; for (var i = 0; i < this.bytes.length; i++) s += (this.bytes[i] < 16 ? '0' : '') + this.bytes[i].toString(16); return s; } return base.call(this, enc); };
  })(Buf.prototype.toString);
  var Buffer = {
    from: function (v, enc) {
      if (typeof v === 'string') return new Buf(enc === 'base64' ? decodeB64(v) : new TextEncoder().encode(v));
      if (v instanceof ArrayBuffer) return new Buf(new Uint8Array(v));
      return new Buf(new Uint8Array(v.buffer || v, v.byteOffset || 0, v.byteLength));
    },
    isBuffer: function (v) { return v instanceof Buf; },
  };

  // SHA-256 синхронно (как crypto.createHash в Node): PKCE во входе через соцсети (server/social.js)
  var K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function sha256(msg) {
    var len = msg.length; var withPad = ((len + 9 + 63) >> 6) << 6;
    var m = new Uint8Array(withPad); m.set(msg); m[len] = 0x80;
    var bits = len * 8; var dv = new DataView(m.buffer);
    dv.setUint32(withPad - 4, bits >>> 0); dv.setUint32(withPad - 8, Math.floor(bits / 4294967296));
    var H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    var W = new Uint32Array(64);
    var rotr = function (x, n) { return (x >>> n) | (x << (32 - n)); };
    for (var off = 0; off < withPad; off += 64) {
      for (var i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        var s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    var out = new Uint8Array(32); var odv = new DataView(out.buffer);
    for (i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  function randomBelow(n) { // равномерно, как crypto.randomInt
    var max = Math.floor(4294967296 / n) * n; var a = new Uint32Array(1);
    do { crypto.getRandomValues(a); } while (a[0] >= max);
    return a[0] % n;
  }
  function join() {
    var parts = Array.prototype.join.call(arguments, '/').split('/'); var outp = [];
    parts.forEach(function (p) { if (p === '..') outp.pop(); else if (p && p !== '.') outp.push(p); });
    return '/' + outp.join('/');
  }
  var SHIMS = {
    crypto: {
      randomInt: function (a, b) { return b === undefined ? randomBelow(a) : a + randomBelow(b - a); },
      randomUUID: function () { return crypto.randomUUID(); },
      randomBytes: function (n) { var b = new Uint8Array(n); crypto.getRandomValues(b); return new Buf(b); },
      createHash: function (alg) {
        if (alg !== 'sha256') throw new Error('android: нет хеша ' + alg);
        var data = new Uint8Array(0);
        var hash = {
          update: function (v) { var add = typeof v === 'string' ? new TextEncoder().encode(v) : (v.bytes || v); var n = new Uint8Array(data.length + add.length); n.set(data); n.set(add, data.length); data = n; return hash; },
          digest: function (enc) { var d = new Buf(sha256(data)); return enc ? d.toString(enc) : d; },
        };
        return hash;
      },
    },
    fs: { readFileSync: function (f) { if (f === '/config.local.json') return CONFIG_TEXT; throw new Error('ENOENT ' + f); } },
    os: { homedir: function () { return '/home'; } },
    path: { join: join, dirname: function (p) { return p.replace(/\\/[^/]*$/, '') || '/'; } },
  };
  var process = { env: {} };

  var defs = {
${wrapped}
  };
  var cache = {};
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var fn = defs[id];
    if (!fn) throw new Error('android: нет модуля ' + id);
    var module = { exports: {} }; cache[id] = module;
    var dir = id.replace(/\\/[^/]*$/, '');
    fn(module, module.exports, function (r) {
      if (SHIMS[r]) return SHIMS[r];
      var p = join(dir, r); if (!/\\.js$/.test(p)) p += '.js';
      return load(p);
    }, dir, id, process, Buffer, fetchProxy);
    return module.exports;
  }
  __anixRequire = load;
  __anixRequire.shims = { Buffer: Buffer, crypto: SHIMS.crypto }; // для android/test/bundle.mjs
})();

${fs.readFileSync(path.join(root, 'android', 'web', 'shim.js'), 'utf8')}`;

fs.mkdirSync(path.join(out, 'android'), { recursive: true });
fs.writeFileSync(path.join(out, 'android', 'server.js'), bundle);

// server.js — первым скриптом страницы, до hls.js и app.js
const indexFile = path.join(out, 'index.html');
const html = fs.readFileSync(indexFile, 'utf8');
if (!html.includes('<meta charset="utf-8">')) throw new Error('sync-web: в index.html нет <meta charset="utf-8">');
if (!html.includes('<link rel="stylesheet" href="/css/app.css">')) throw new Error('sync-web: в index.html нет app.css');
fs.copyFileSync(path.join(root, 'android', 'web', 'android.css'), path.join(out, 'android', 'android.css'));
// фоновая проверка уведомлений (NotifyJob.kt): страница без интерфейса
for (const f of ['background.html', 'background.js']) fs.copyFileSync(path.join(root, 'android', 'web', f), path.join(out, 'android', f));
fs.writeFileSync(indexFile, html
  .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <script src="/android/server.js"></script>')
  .replace('<link rel="stylesheet" href="/css/app.css">', '<link rel="stylesheet" href="/css/app.css">\n  <link rel="stylesheet" href="/android/android.css">'));
console.log(`sync-web: ${out}`);
