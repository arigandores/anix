'use strict';
// Заголовки, которые бекенд ожидает от мобильного клиента Anixart:
//   User-Agent, Sign, X-Codec-Profile и X-Media-Session (отправляется пустым).
const crypto = require('crypto');

const VERSION_NAME = '10.0';
const VERSION_CODE = 26090418;
const PACKAGE_NAME = 'com.swiftsoft.anixartd';
// Отпечаток сертификата мобильного клиента
const SIGNATURE_MD5 = '9aa5c7af74e8cd70c86f7f9587bde23d';

const ALNUM = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randInt(from, to) { // включительно
  return from + crypto.randomInt(to - from + 1);
}
function randomString(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALNUM[crypto.randomInt(ALNUM.length)];
  return s;
}
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }
function pick(n, codes) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(codes[crypto.randomInt(codes.length)]);
  return s;
}
function reverse(s) { return s.split('').reverse().join(''); }
function digitShift(k, s) {
  let out = '';
  for (const ch of s) {
    if (ch >= '0' && ch <= '9') {
      let c = ch.charCodeAt(0) - k;
      if (c < 48) c += 10;
      out += String.fromCharCode(c);
    } else out += ch;
  }
  return out;
}
function caesar(k, s) {
  const m = k % 26;
  if (m === 0) return s;
  let out = '';
  for (const ch of s) {
    let c = ch.charCodeAt(0);
    if (c >= 65 && c < 91) { c += m; if (c > 90) c -= 26; }
    else if (c >= 97 && c < 123) { c += m; if (c > 122) c -= 26; }
    out += String.fromCharCode(c);
  }
  return out;
}
function digitCount(s) { let n = 0; for (const ch of s) if (ch >= '0' && ch <= '9') n++; return n; }
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64'); // Base64 без переносов строк

function sign(sdkInt = 34) {
  const a = randomString(4);
  const b = randomString(8);
  const k = randInt(1, 9);
  const p1 = pick(6, [...range(65, 70), ...range(117, 122), ...range(48, 50), 43, 33, 38, 60, 41]);
  const str4 = '1' + reverse(String(Math.floor(Date.now() / 1000)));
  const vc = String(VERSION_CODE);
  const ts = String(BigInt(str4) + BigInt(vc.slice(-4)));
  const mixCodes = [...range(78, 90), ...range(97, 109), ...range(53, 57), 43, 33, 38, 60, 41];
  let mixed = '';
  for (const d of ts) mixed += d + pick(1, mixCodes);
  const p2 = pick(7, [...range(71, 76), ...range(111, 116), ...range(51, 52), 63, 94, 40, 46, 47]);
  const p3 = pick(4, [...range(77, 82), ...range(105, 110), ...range(53, 54), 36, 92, 37, 125, 64]);
  const n1 = [99, 74, 49][crypto.randomInt(3)] - Number(vc.slice(-2));
  const p4 = pick(7, [...range(83, 90), ...range(97, 104), ...range(55, 57), 43, 93, 62, 123, 63]);
  const sdkLast = Number(String(sdkInt).slice(-1));
  const r = randInt(10, 27);
  const str5 = p1 + mixed + p2 + p3 + n1 + p4 + sdkLast + r;
  const rs = String(r);
  const first = Number(rs[0]);
  const last = Number(rs[rs.length - 1]);
  const i5 = first + last;
  let str;
  if (first === 1) {
    str = b64(caesar(last, digitShift(i5 - 1, str5))) + last +
      pick(2, [...range(49, 53), 43, 37, 60, 38, 63]) + pick(1, [38, 123, 93, 35, 64]);
  } else {
    str = caesar(last, digitShift(i5, b64(str5))) + last +
      pick(2, [...range(54, 57), 33, 94, 62, 126, 47]) + pick(1, [37, 125, 91, 36, 94]);
  }
  const sigPart = caesar(digitCount(a) + 1, reverse(SIGNATURE_MD5));
  const pkgPart = caesar(digitCount(b) + 2, PACKAGE_NAME);
  return digitShift(k, b64(a + str + sigPart + pkgPart + b)) + k + randomString(7);
}

// Битовая маска состояния баннера (по умолчанию 128),
// codecProfile приходит из config/toggles; пока он null — без seal.
let adState = 128;
let codecProfile = null;
function setCodecProfile(v) { codecProfile = v || null; }
function codecProfileHeader() {
  const i = adState;
  const t = Math.floor(Date.now() / 60000) & 63;
  const x = i ^ t;
  const base = `${(x >> 3) + 2}.${x & 7}.${(t * 7 + i * 13 + 90) & 255}`;
  // полное значение считается нативным кодом; без него отправляется "base.profile"
  return codecProfile ? `${base}.${codecProfile}` : base;
}

const DEVICE = {
  release: '14', sdk: 34, abi: 'arm64-v8a', manufacturer: 'Xiaomi', model: '23049PCD8G', lang: 'ru',
};
function userAgent() {
  return `AnixartApp/${VERSION_NAME}-${VERSION_CODE} (Android ${DEVICE.release}; SDK ${DEVICE.sdk}; ${DEVICE.abi}; ${DEVICE.manufacturer} ${DEVICE.model}; ${DEVICE.lang})`;
}

function apiHeaders() {
  return {
    'User-Agent': userAgent(),
    'Sign': sign(DEVICE.sdk),
    'X-Media-Session': '',
    'X-Codec-Profile': codecProfileHeader(),
  };
}

module.exports = { sign, apiHeaders, userAgent, setCodecProfile, VERSION_CODE, VERSION_NAME, PACKAGE_NAME };
