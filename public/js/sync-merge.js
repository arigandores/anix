// Слияние истории просмотра разных устройств — общее для приложения (sync.js) и сервера синхронизации (cloud/sync).
// Запись аниме: { last, eps }. last — последняя серия (как db.lastWatched: озвучка, источник, номер, timestamp в
// секундах), eps — серии по ключу «источник:номер» (как db.episodes: место, длительность, отметки) с временем
// изменения at (мс). По каждой серии и по последней серии побеждает более свежая запись; равные — остаётся своя.
export const epKey = (sourceId, position) => `${sourceId}:${position}`;
const newer = (a, b, at) => (b && (!a || at(b) > at(a)) ? b : a);
export const lastAt = (l) => l?.at || (l?.timestamp || 0) * 1000; // у старых записей — только timestamp в секундах
// у записей до синхронизации at нет — время из того, что есть: место, запуск, отметка (сек)
export const epAt = (e) => e?.at || e?.savedAt || e?.startedAt || (e?.markedAt || 0) * 1000;

// changed — что-то взято из b; lastChanged — взята последняя серия из b (у приложения — новый выбор озвучки)
export function mergeRelease(a, b) {
  const out = { last: a?.last || null, eps: { ...(a?.eps || {}) } };
  let changed = false; let lastChanged = false;
  const last = newer(out.last, b?.last, lastAt);
  if (last !== out.last) { out.last = last; changed = lastChanged = true; }
  for (const [k, e] of Object.entries(b?.eps || {})) {
    const pick = newer(out.eps[k], e, epAt);
    if (pick !== out.eps[k]) { out.eps[k] = pick; changed = true; }
  }
  return { rel: out, changed, lastChanged };
}
