'use strict';
// Быстрая проверка без Electron: сервер стартует, прокси к бекенду, Sign, парсер Kodik и стрим-прокси работают.
const assert = require('assert');
const { start } = require('../server');
const { sign } = require('../server/sign');

(async () => {
  const s = sign();
  assert(s.length > 100 && /^[A-Za-z0-9+/=]+\d[A-Za-z0-9]{7}$/.test(s), 'Sign имеет формат base64 + цифра + 7 символов');

  const { server, url } = await start(0);
  const get = async (p, o) => { const r = await fetch(url + p, o); return r; };
  try {
    const rel = await (await get('api/release/1?extended_mode=true')).json();
    assert.strictEqual(rel.code, 0); assert.strictEqual(rel.release.id, 1);
    console.log('ok release/1:', rel.release.title_ru);

    const f = await (await get('api/filter/0?extended_mode=true', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status_id: 2, sort: 0 }) })).json();
    assert(f.content.length > 0); console.log('ok filter: ongoing', f.content.length);

    const tgt = await (await get('api/episode/target/1/8/1')).json();
    assert(/d=/.test(tgt.episode.url)); console.log('ok episode/target');

    const p = await (await get(`parse?url=${encodeURIComponent(tgt.episode.url)}`)).json();
    const q = Object.keys(p.playback);
    assert(q.length > 0, 'Kodik вернул качества'); console.log('ok kodik parser:', q.join(', '));

    const pl = await (await get(`stream?url=${encodeURIComponent(p.playback[q[0]])}&referer=${encodeURIComponent(tgt.episode.url)}`)).text();
    assert(pl.startsWith('#EXTM3U') && pl.includes('/stream?url=')); console.log('ok m3u8 rewrite');
    const seg = pl.split('\n').find((l) => l.startsWith('/stream'));
    const buf = Buffer.from(await (await get(seg.slice(1))).arrayBuffer());
    assert(buf[0] === 0x47, 'MPEG-TS sync byte'); console.log('ok segment', buf.length, 'bytes');
    console.log('ALL OK');
  } finally { server.close(); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
