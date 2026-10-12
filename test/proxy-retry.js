'use strict';
// Повторы прокси при сбоях бекенда: поддельный upstream отвечает 502/обрывает соединение, затем 200.
// Запуск: node test/proxy-retry.js
const http = require('http');

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!ok) fails++; };

(async () => {
  const hits = {};
  const upstream = http.createServer((req, res) => {
    const key = `${req.method} ${req.url.split('?')[0]}`;
    const n = (hits[key] = (hits[key] || 0) + 1);
    if (req.url.startsWith('/flaky502')) { if (n <= 2) { res.writeHead(502); return res.end('bad gateway'); } }
    if (req.url.startsWith('/reset')) { if (n <= 1) return req.socket.destroy(); }
    if (req.url.startsWith('/always502')) { res.writeHead(502); return res.end('bad gateway'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"code":0}');
  });
  await new Promise((ok) => upstream.listen(0, '127.0.0.1', ok));
  process.env.ANIXART_API_BASE = `http://127.0.0.1:${upstream.address().port}/`;
  const { start } = require('../server');
  const s = await start(0);
  const get = async (p, opts) => { const r = await fetch(s.url + 'api/' + p, opts); return r.status; };

  check('GET: 502, 502, затем 200 → 200', (await get('flaky502')) === 200, `попыток ${hits['GET /flaky502']}`);
  check('GET: обрыв соединения, затем 200 → 200', (await get('reset')) === 200, `попыток ${hits['GET /reset']}`);
  check('GET: всегда 502 → 502 после 3 попыток', (await get('always502')) === 502 && hits['GET /always502'] === 3, `попыток ${hits['GET /always502']}`);
  check('POST: 502 не повторяется', (await get('flaky502post', { method: 'POST', body: '' })) === 502 && hits['POST /flaky502post'] === 1, `попыток ${hits['POST /flaky502post']}`);
  check('POST: обрыв после отправки не повторяется', (await get('reset', { method: 'POST', body: '' })) === 502 && hits['POST /reset'] === 1, `попыток ${hits['POST /reset']}`);

  console.log(fails ? `FAILED: ${fails}` : 'ALL OK');
  s.server.close(); upstream.close();
  process.exit(fails ? 1 : 0);
})();
