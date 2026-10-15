'use strict';
// Таймкоды опенинга и эндинга (логика из anixapp, electron/lib/skip-marks.js).
// Kodik: на странице плеера parseSkipButton("1:49-3:19,23:32-25:13", "anime").
// AniLibria: у серии поля opening/ending ({start, stop}).
// У Kodik первым интервалом иногда идёт короткое интро озвучки (5–30 с), а настоящий опенинг — следующим:
// тогда интро и опенинг сливаются в один пропуск. Если есть только OP и ED — пропуск внутри OP, не с 0:00.
// Результат: { opening: {start, end} | null, ending: {start, end} | null } в секундах, или null.

const INTRO_MAX_DURATION = 45; // короче — «бампер» озвучки, а не опенинг
const OP_MIN_DURATION = 50; // типичная длина опенинга
const OP_MAX_DURATION = 200;

function parseClock(str) {
  const p = String(str).trim().split(':').map(Number);
  if (!p.length || p.some((n) => !Number.isFinite(n))) return null;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0];
}

function usableRange(start, end) {
  const a = Number(start); const b = Number(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b - a < 2) return null;
  return { start: a, end: b };
}

const rangeDuration = (r) => (r ? Math.max(0, r.end - r.start) : 0);

// Короткий бампер в начале серии (интро озвучки), не опенинг
function isVoiceoverIntro(range) {
  if (!range) return false;
  const dur = rangeDuration(range);
  return dur > 0 && dur < INTRO_MAX_DURATION && range.start < 90;
}

function looksLikeOpening(range) {
  if (!range || isVoiceoverIntro(range)) return false;
  const dur = rangeDuration(range);
  return dur >= OP_MIN_DURATION && dur <= OP_MAX_DURATION && range.start < 720;
}

function pickOpening(candidates) {
  if (!candidates.length) return null;
  const longest = (list) => list.slice().sort((a, b) => rangeDuration(b) - rangeDuration(a))[0];
  const typical = candidates.filter(looksLikeOpening);
  if (typical.length) return longest(typical);
  const early = candidates.filter((r) => r.start < 600 && !isVoiceoverIntro(r));
  if (early.length) return longest(early);
  if (candidates.length === 1 && isVoiceoverIntro(candidates[0])) return null; // чистое интро — не опенинг
  return candidates.find((r) => !isVoiceoverIntro(r)) || null;
}

function rangeFromUnknown(v) {
  if (v == null) return null;
  if (Array.isArray(v) && v.length >= 2) return usableRange(v[0], v[1]);
  if (typeof v === 'object') return usableRange(v.start ?? v.from ?? v.begin, v.stop ?? v.end ?? v.to ?? v.finish);
  return null;
}

// Короткий бампер прямо перед OP → один интервал от интро до конца OP
function mergeIntroWithOpening(intro, opening) {
  if (!intro || !opening) return opening;
  if (intro.end > opening.start + 8) return opening;
  return usableRange(Math.min(intro.start, opening.start), opening.end);
}

function classifySkipRanges(ranges) {
  const list = (ranges || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length >= 3) {
    const ending = list[list.length - 1];
    const beforeEnd = list.slice(0, -1);
    const opening = mergeIntroWithOpening(beforeEnd.find(isVoiceoverIntro), pickOpening(beforeEnd));
    return opening || ending ? { opening, ending } : null;
  }
  if (list.length === 2) {
    const [a, b] = list;
    if (isVoiceoverIntro(a) && b.start >= 480) return { opening: null, ending: b }; // интро + ED: в начале не пропускаем
    if (isVoiceoverIntro(a) && looksLikeOpening(b)) return { opening: mergeIntroWithOpening(a, b), ending: null };
    if (isVoiceoverIntro(a)) {
      const opening = pickOpening([a, b]);
      if (opening === b) return { opening: mergeIntroWithOpening(a, b), ending: null };
      return { opening: null, ending: b.start >= 480 ? b : null };
    }
    return { opening: a, ending: b }; // обычные OP + ED
  }
  const only = list[0];
  if (isVoiceoverIntro(only)) return null;
  return only.start >= 600 ? { opening: null, ending: only } : { opening: only, ending: null };
}

// Kodik: parseSkipButton("1:49-3:19,23:32-25:13", "anime") на странице плеера
function parseKodikSkipButton(html) {
  const m = String(html || '').match(/parseSkipButton\(\s*"([^"]*)"\s*,\s*"[^"]*"\s*\)/);
  if (!m || !m[1].trim()) return null;
  const ranges = m[1].trim().split(',').map((part) => {
    const bits = part.split('-');
    return bits.length < 2 ? null : usableRange(parseClock(bits[0]), parseClock(bits[1]));
  }).filter(Boolean);
  return classifySkipRanges(ranges);
}

function skipFromLibriaEpisode(ep) {
  if (!ep) return null;
  let opening = rangeFromUnknown(ep.opening);
  const ending = rangeFromUnknown(ep.ending);
  if (isVoiceoverIntro(opening)) opening = null; // AniLibria иногда отдаёт короткий преролл как opening
  return opening || ending ? { opening, ending } : null;
}

module.exports = { parseKodikSkipButton, skipFromLibriaEpisode, classifySkipRanges, isVoiceoverIntro };
