// Нативный сервер приложения (LocalServer.kt) против тестового сервера на компьютере. Android 17 не пускает приложение
// в локальную сеть (10.0.2.2 эмулятора) без разрешения — тестовый сервер виден ему через adb reverse на 127.0.0.1:
// /__relay — заголовки, редиректы, несколько Set-Cookie, тело POST, сетевые ошибки как у fetch;
// /stream — перезапись m3u8 (и Kodik с типом video/MP2T), Range для mp4, Referer/UA/Cookie;
// статика (SPA, 404, выход из папки), вход через Google в системном браузере
import http from 'node:http';
import crypto from 'node:crypto';
import { ensureDevice, install, launch, js, check, done, pageErrors, adb } from './_device.mjs';

const MP4 = crypto.randomBytes(100000);
const seen = []; // заголовки запросов, которые дошли до тестового сервера
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  seen.push({ path: u.pathname, headers: req.headers });
  if (u.pathname === '/hdr') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.headers)); return; }
  if (u.pathname === '/redir') { res.writeHead(302, { Location: '/hdr?from=redir', 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'] }); res.end(); return; }
  if (u.pathname === '/post') {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { const b = Buffer.concat(chunks); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ method: req.method, type: req.headers['content-type'], len: b.length, sha: crypto.createHash('sha256').update(b).digest('hex') })); });
    return;
  }
  if (u.pathname === '/pl/master.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="/abs/init.mp4"\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nhttp://other.example/seg2.ts?x=1&y=2\n');
    return;
  }
  if (u.pathname === '/kodik/720.mp4:hls:manifest.m3u8') { res.writeHead(200, { 'Content-Type': 'video/MP2T' }); res.end('#EXTM3U\n#EXTINF:4,\n./seg-1-v1-a1.ts\n'); return; }
  if (u.pathname === '/video.mp4') {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': MP4.length, 'Accept-Ranges': 'bytes' }); res.end(MP4); return; }
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : MP4.length - 1;
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${MP4.length}`, 'Accept-Ranges': 'bytes' });
    res.end(MP4.subarray(a, b + 1));
    return;
  }
  res.writeHead(404); res.end('nope');
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const PORT_T = srv.address().port;
const H = `http://127.0.0.1:${PORT_T}`;

try {
  await ensureDevice();
  adb('reverse', `tcp:${PORT_T}`, `tcp:${PORT_T}`);
  install();
  await launch();
  const R = (expr) => js(`(async () => { const relay = window.__anixRelay; ${expr} })()`);

  // --- /__relay ---
  const noKey = await js(`fetch('/__relay', { method: 'POST', headers: { 'X-Relay': btoa(JSON.stringify({ url: '${H}/hdr', method: 'GET', headers: {} })) } }).then((r) => r.status)`);
  check('relay без ключа приложения — 403 (другим приложениям телефона не воспользоваться)', noKey === 403, noKey);
  const hdr = await R(`const r = await relay('${H}/hdr', { headers: { 'User-Agent': 'AnixTest/1', Referer: 'https://ref.example/', Cookie: 'c=3', 'X-Custom': 'x' } }); return { status: r.status, ok: r.ok, body: await r.json() };`);
  check('relay: свои User-Agent, Referer, Cookie доходят как есть', hdr.status === 200 && hdr.body['user-agent'] === 'AnixTest/1' && hdr.body.referer === 'https://ref.example/' && hdr.body.cookie === 'c=3', hdr.body);
  const red = await R(`const r = await relay('${H}/redir', { redirect: 'manual' }); return { status: r.status, loc: r.headers.get('location'), cookies: r.headers.getSetCookie(), joined: r.headers.get('set-cookie') };`);
  check('relay: redirect manual — 302 и Location', red.status === 302 && red.loc === '/hdr?from=redir', red);
  check('relay: несколько Set-Cookie — getSetCookie() как в Node', JSON.stringify(red.cookies) === JSON.stringify(['a=1; Path=/', 'b=2; Path=/']), red.cookies);
  const fol = await R(`const r = await relay('${H}/redir'); return { status: r.status, url: r.url, redirected: r.redirected };`);
  check('relay: редирект по умолчанию — конечный адрес в r.url', fol.status === 200 && fol.url.endsWith('/hdr?from=redir') && fol.redirected, fol);
  const post = await R(`
    const bin = new Uint8Array(70000); for (let i = 0; i < bin.length; i++) bin[i] = (i * 7) % 256;
    const a = await (await relay('${H}/post', { method: 'POST', body: bin, headers: { 'Content-Type': 'application/octet-stream' } })).json();
    const f = await (await relay('${H}/post', { method: 'POST', body: new URLSearchParams({ q: 'привет', n: '1' }) })).json();
    const e = await (await relay('${H}/post', { method: 'POST', body: '' })).json();
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bin))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { a, f, e, sha };`);
  check('relay: двоичное тело POST доходит без искажений', post.a.len === 70000 && post.a.sha === post.sha, post.a);
  check('relay: форма — тип x-www-form-urlencoded', /x-www-form-urlencoded/.test(post.f.type || '') && post.f.len > 0, post.f);
  check('relay: пустое тело POST', post.e.method === 'POST' && post.e.len === 0, post.e);
  const errs = await R(`
    const code = async (u) => { try { await relay(u); return 'no error'; } catch (e) { return (e instanceof TypeError ? 'TypeError:' : 'other:') + (e.cause && e.cause.code); } };
    return { refused: await code('http://127.0.0.1:1/'), nohost: await code('http://no-such-host.invalid/') };`);
  check('relay: соединение отклонено — TypeError с cause.code', /^TypeError:(ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT)/.test(errs.refused), errs.refused);
  check('relay: нет такого адреса — TypeError ENOTFOUND', errs.nohost === 'TypeError:ENOTFOUND', errs.nohost);

  // --- /stream ---
  const pl = await js(`fetch('/stream?url=' + encodeURIComponent('${H}/pl/master.m3u8') + '&referer=' + encodeURIComponent('https://kodik.example/') + '&cookie=k%3D1').then(async (r) => ({ type: r.headers.get('content-type'), text: await r.text() }))`);
  const lines = pl.text.split('\n');
  const q = (s) => { const m = /\/stream\?url=([^&"]+)/.exec(s); return m ? decodeURIComponent(m[1]) : null; };
  check('stream m3u8: тип плейлиста', /mpegurl/i.test(pl.type), pl.type);
  check('stream m3u8: URI ключа — абсолютный через /stream', q(lines.find((l) => l.startsWith('#EXT-X-KEY'))) === `${H}/pl/key.bin`, lines[1]);
  check('stream m3u8: EXT-X-MAP от корня', q(lines.find((l) => l.startsWith('#EXT-X-MAP'))) === `${H}/abs/init.mp4`, lines[2]);
  check('stream m3u8: относительный сегмент', q(lines.find((l) => l.includes('seg1'))) === `${H}/pl/seg1.ts`);
  check('stream m3u8: чужой хост с параметрами — целиком', q(lines.find((l) => l.includes('seg2'))) === 'http://other.example/seg2.ts?x=1&y=2');
  check('stream m3u8: Referer и Cookie передаются сегментам', lines.filter((l) => l.includes('/stream?')).every((l) => l.includes('referer=') && l.includes('cookie=')));
  seen.length = 0;
  const kod = await js(`fetch('/stream?url=' + encodeURIComponent('${H}/kodik/720.mp4:hls:manifest.m3u8')).then((r) => r.text())`);
  check('stream: Kodik (video/MP2T, путь .m3u8) — тоже плейлист', kod.includes('/stream?url=') && kod.includes(encodeURIComponent(`${H}/kodik/seg-1-v1-a1.ts`)), kod.slice(0, 120));
  check('stream: User-Agent плеера по умолчанию', /Chrome\/96/.test(seen[0]?.headers['user-agent'] || ''), seen[0]?.headers['user-agent']);
  const rng = await js(`fetch('/stream?url=' + encodeURIComponent('${H}/video.mp4'), { headers: { Range: 'bytes=1000-1999' } }).then(async (r) => ({ s: r.status, cr: r.headers.get('content-range'), ar: r.headers.get('accept-ranges'), len: (await r.arrayBuffer()).byteLength }))`);
  check('stream mp4: Range → 206 и Content-Range', rng.s === 206 && rng.cr === `bytes 1000-1999/${MP4.length}` && rng.len === 1000 && rng.ar === 'bytes', rng);
  const full = await js(`fetch('/stream?url=' + encodeURIComponent('${H}/video.mp4')).then(async (r) => (await r.arrayBuffer()).byteLength)`);
  check('stream mp4: целиком', full === MP4.length, full);
  check('stream: без url — 400', await js(`fetch('/stream').then((r) => r.status)`) === 400);

  // --- статика ---
  const st = await js(`Promise.all(['/js/app.js', '/no-such.js', '/release/123', '/%2e%2e/%2e%2e/shared_prefs/x.xml'].map((p) => fetch(p).then(async (r) => [r.status, r.headers.get('content-type'), (await r.text()).slice(0, 40)])))`);
  check('статика: модуль с типом text/javascript', st[0][0] === 200 && /javascript/.test(st[0][1]), st[0]);
  check('статика: нет файла — 404', st[1][0] === 404, st[1]);
  check('статика: путь экрана — index.html (SPA)', st[2][0] === 200 && /html/.test(st[2][1]), st[2]);
  check('статика: выход из папки — запрещён', st[3][0] === 403 || st[3][0] === 404, st[3]);

  // --- вход через Google в системном браузере: страница в браузере отдаёт токен, приложение ждёт ---
  const g = await js(`(async () => {
    const f = await (await fetch('/__features')).json();
    if (!f.social.google) return { skip: true };
    const s = await (await fetch('/social/google/start')).json();
    const cfg = await (await fetch('/social/google/config')).json();
    const waiting = fetch('/social/google/wait?n=' + s.n).then((r) => r.json());
    await new Promise((ok) => setTimeout(ok, 800));
    const posted = await (await fetch('/social/google/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ n: s.n, idToken: 'tok-123', email: 'a@b.c' }) })).json();
    const got = await waiting;
    const again = await (await fetch('/social/google/wait?n=' + s.n)).json();
    const page = await fetch(new URL(s.url).pathname).then((r) => r.status);
    return { s, cfg, posted, got, again, page };
  })()`);
  if (g.skip) console.log('SKIP [Google] нет ключей Google в config.local.json');
  else {
    check('Google: страница входа — на localhost и том же порту, с возвратом в приложение (app=android)', g.s.url === `http://localhost:38371/google-auth.html?n=${g.s.n}&app=android` && g.page === 200, g.s.url);
    check('Google: ключи Firebase переданы странице', !!g.cfg.apiKey && !!g.cfg.authDomain);
    check('Google: ожидание получает токен, как только страница его прислала', g.posted.ok && g.got.field === 'googleIdToken' && g.got.token === 'tok-123' && g.got.email === 'a@b.c', g.got);
    check('Google: ключ входа одноразовый', !!g.again.error, g.again);
  }
  check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} finally {
  srv.close();
  try { adb('reverse', '--remove', `tcp:${PORT_T}`); } catch { /* уже нет */ }
}
done('server');
