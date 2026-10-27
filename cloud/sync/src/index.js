// Сервер синхронизации истории просмотра Anix: последняя серия аниме (озвучка, источник, номер) и место в сериях —
// общие для всех устройств одного аккаунта Anixart. Cloudflare Worker + D1.
//   GET  /v1/pull?pid=<профиль>&cursor=<курсор> — записи, изменившиеся после курсора, небольшой порцией:
//        { releases: { rid: { last, eps } }, more, cursor, now }
//   POST /v1/push  { pid, releases: { rid: { last, eps } } } — записи устройства, ответ { now, written }
// now — часы сервера: приложение по ним выравнивает свои (время изменения записей сравнивается между устройствами).
// Хранение — строка на запись: «last» (последняя серия аниме) или «источник:номер» (серия). Так порции ответа
// маленькие при любой длине аниме (медленная или ограниченная сеть их переварит), а слияние делает сам запрос:
// запись заменяется, только если присланная свежее (at — время изменения, sync-merge.js), без гонок.
// Вход — токен Anixart в заголовке X-Anix-Token: чей он, спрашиваем у Anixart (profile/<pid> → is_my_profile) и
// запоминаем на сутки. Сам токен не хранится и не пишется в журнал — только его SHA-256.
// TEST_AUTH=1 (только локальный wrangler dev в тестах) — токен «test:<pid>» без Anixart.
import { apiHeaders } from '../../../server/sign.js';
import { lastAt, epAt } from '../../../public/js/sync-merge.js';

const API = 'https://api-s.anixsekai.com/';
const AUTH_TTL = 24 * 3600e3; // перепроверка токена у Anixart раз в сутки
// Anixart недоступен — ранее проверенный токен годится ещё 3 дня (отозванный — тоже, поэтому недолго). Записи о
// токенах старше — удаляются: после каждого перелогина остаётся прежний токен, который больше не придёт
const AUTH_GRACE = 3 * 24 * 3600e3;
const ANIXART_TIMEOUT = 8000;
const OVERLAP = 5000; // курсор с запасом: запись, попавшая в ту же миллисекунду, придёт ещё раз (слияние это терпит)
const PAGE = 40; // записей в ответе pull (~250 байт каждая)
const LIMITS = { body: 64 * 1024, items: 400 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Anix-Token',
  'Access-Control-Max-Age': '86400',
};
const json = (body, status = 200) => Response.json(body, { status, headers: CORS });

let schemaReady = null;
function schema(db) {
  return (schemaReady ??= db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS item (pid INTEGER NOT NULL, rid INTEGER NOT NULL, k TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (pid, rid, k))'),
    db.prepare('CREATE INDEX IF NOT EXISTS item_updated ON item (pid, updated, rid, k)'),
    db.prepare('CREATE TABLE IF NOT EXISTS auth (h TEXT PRIMARY KEY, pid INTEGER NOT NULL, checked INTEGER NOT NULL)'),
  ]).catch((e) => { schemaReady = null; throw e; }));
}

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ownsProfile(token, pid) {
  const r = await fetch(`${API}profile/${pid}?token=${encodeURIComponent(token)}`, { headers: apiHeaders(), signal: AbortSignal.timeout(ANIXART_TIMEOUT) });
  if (!r.ok) throw new Error(`Anixart ${r.status}`);
  const j = await r.json();
  return j.is_my_profile === true;
}

// true — токен этого профиля; false — нет; бросает, если проверить нечем (Anixart недоступен, а запомненного нет)
async function authorize(env, token, pid) {
  if (env.TEST_AUTH === '1' && token === `test:${pid}`) return true;
  const h = await sha256(token);
  const now = Date.now();
  const row = await env.DB.prepare('SELECT pid, checked FROM auth WHERE h = ?').bind(h).first();
  if (row && row.pid === pid && now - row.checked < AUTH_TTL) return true;
  let mine;
  try { mine = await ownsProfile(token, pid); } catch (e) {
    if (row && row.pid === pid && now - row.checked < AUTH_GRACE) return true;
    throw e;
  }
  if (mine) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO auth (h, pid, checked) VALUES (?, ?, ?) ON CONFLICT (h) DO UPDATE SET pid = excluded.pid, checked = excluded.checked').bind(h, pid, now),
      env.DB.prepare('DELETE FROM auth WHERE checked < ?').bind(now - AUTH_GRACE), // раз в сутки на токен — дёшево
    ]);
  } else if (row) await env.DB.prepare('DELETE FROM auth WHERE h = ?').bind(h).run();
  return mine;
}

// Курсор «updated:rid:k»: одна отправка пишет записи с одним updated — порядок внутри по аниме и ключу.
// Последняя порция отдаёт курсор «сейчас минус запас» и more: false
async function pull(env, pid, cursor) {
  const now = Date.now();
  const [us, rs, ...ks] = String(cursor || '0:0:').split(':');
  const u = Math.max(0, Number(us) || 0); const r = Math.max(0, Number(rs) || 0); const k = ks.join(':');
  const { results } = await env.DB.prepare(`SELECT rid, k, data, updated FROM item WHERE pid = ?1
      AND (updated > ?2 OR (updated = ?2 AND (rid > ?3 OR (rid = ?3 AND k > ?4))))
      ORDER BY updated, rid, k LIMIT ?5`).bind(pid, u, r, k, PAGE).all();
  const releases = {};
  for (const row of results) {
    const rel = (releases[row.rid] ||= { last: null, eps: {} });
    if (row.k === 'last') rel.last = JSON.parse(row.data); else rel.eps[row.k] = JSON.parse(row.data);
  }
  const more = results.length === PAGE;
  const last = results.at(-1);
  return { releases, more, cursor: more ? `${last.updated}:${last.rid}:${last.k}` : `${Math.max(u, now - OVERLAP)}:0:`, now };
}

// Запись заменяется, только если присланная свежее; written — сколько записано на самом деле
async function push(env, pid, items) {
  const now = Date.now();
  const stmt = env.DB.prepare(`INSERT INTO item (pid, rid, k, data, at, updated) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (pid, rid, k) DO UPDATE SET data = excluded.data, at = excluded.at, updated = excluded.updated WHERE excluded.at > item.at`);
  const res = items.length ? await env.DB.batch(items.map((i) => stmt.bind(pid, i.rid, i.k, i.data, i.at, now))) : [];
  return { now, written: res.reduce((n, r) => n + (r.meta?.changes || 0), 0) };
}

// Присланное приложением — в записи: только числовые аниме, ключ «last» или «источник:номер», не больше лимита
function itemsOf(releases) {
  if (!releases || typeof releases !== 'object' || Array.isArray(releases)) return null;
  const items = [];
  for (const [rid, rel] of Object.entries(releases)) {
    if (!/^\d+$/.test(rid) || !rel || typeof rel !== 'object') return null;
    if (rel.last && typeof rel.last === 'object') items.push({ rid: Number(rid), k: 'last', data: JSON.stringify(rel.last), at: lastAt(rel.last) });
    for (const [k, e] of Object.entries(rel.eps && typeof rel.eps === 'object' ? rel.eps : {})) {
      if (!/^\d+:\d+$/.test(k) || !e || typeof e !== 'object') return null;
      items.push({ rid: Number(rid), k, data: JSON.stringify(e), at: epAt(e) });
    }
    if (items.length > LIMITS.items) return null;
  }
  return items;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    if (route !== 'GET /v1/pull' && route !== 'POST /v1/push') return json({ error: 'not found' }, 404);
    const token = req.headers.get('X-Anix-Token') || '';
    let pid; let body = null;
    if (req.method === 'POST') {
      if (Number(req.headers.get('Content-Length') || 0) > LIMITS.body) return json({ error: 'too large' }, 413);
      const text = await req.text();
      if (text.length > LIMITS.body) return json({ error: 'too large' }, 413);
      try { body = JSON.parse(text); } catch { return json({ error: 'bad json' }, 400); }
      pid = Number(body?.pid);
    } else pid = Number(url.searchParams.get('pid'));
    if (!token || !Number.isInteger(pid) || pid <= 0) return json({ error: 'pid и X-Anix-Token обязательны' }, 400);
    try {
      await schema(env.DB);
      if (!(await authorize(env, token, pid))) return json({ error: 'forbidden' }, 403);
      if (req.method === 'GET') return json(await pull(env, pid, url.searchParams.get('cursor')));
      const items = itemsOf(body.releases);
      if (!items) return json({ error: 'bad releases' }, 400);
      return json(await push(env, pid, items));
    } catch (e) {
      return json({ error: String(e?.message || e) }, 502);
    }
  },
};
