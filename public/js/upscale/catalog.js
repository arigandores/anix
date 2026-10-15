// Каталог моделей апскейла: семейства и пресеты, уровни для ручного выбора и порядок качества для «Авто».
// arch — сеть: у пресетов одной сети одинаковая цена (Sharp1, DN/DS отличаются только весами), бенчмарк меряет
// сети, а не пресеты. trt — во сколько раз TensorRT быстрее WebGPU на этой сети (прикидка до бенчмарка).
// Файлы: public/models/upscale/<id> (WebGPU) и public/models/upscale-onnx/<id>.onnx (TensorRT, fp16).
//
// Выбор — по замерам на 650 кадрах (синтетика с чётким эталоном и пары Kodik/Libria одного кадра в разных качествах:
// LPIPS, DISTS, TOPIQ, ширина контуров) и на отрывках (мерцание). Модели выстраиваются по одной оси «точность и
// стабильность — чёткость»: ArtCNN (ближе всех к исходнику, не мерцает) < AniSD AC < AnimeJaNai V3.1 Sharp1 <
// AnimeJaNai SD Compact (самая чёткая, лучше всех вытягивает мыльный SD, но сильнее всех мерцает и на чистом HD
// уступает). Что лучше, зависит от того, насколько исходник мягче своего кадра — это меряет native.js.

export const MODELS = {
  'artcnn-c4f16': { family: 'ArtCNN', preset: 'C4F16', arch: 'artcnn-c4f16', macs: 12240, luma: true },
  'artcnn-c4f16-dn': { family: 'ArtCNN', preset: 'C4F16 DN', arch: 'artcnn-c4f16', macs: 12240, luma: true },
  'artcnn-c4f16-ds': { family: 'ArtCNN', preset: 'C4F16 DS', arch: 'artcnn-c4f16', macs: 12240, luma: true },
  'artcnn-c4f32': { family: 'ArtCNN', preset: 'C4F32', arch: 'artcnn-c4f32', macs: 47520, luma: true },
  'artcnn-c4f32-dn': { family: 'ArtCNN', preset: 'C4F32 DN', arch: 'artcnn-c4f32', macs: 47520, luma: true },
  'artcnn-c4f32-ds': { family: 'ArtCNN', preset: 'C4F32 DS', arch: 'artcnn-c4f32', macs: 47520, luma: true },
  'janai-v31-perf': { family: 'AnimeJaNai V3.1', preset: 'Performance', arch: 'janai-v31-perf', macs: 89424, trt: 2.6 },
  'janai-v31-perf-sharp': { family: 'AnimeJaNai V3.1', preset: 'Performance Sharp1', arch: 'janai-v31-perf', macs: 89424, trt: 2.6 },
  'janai-v31-bal': { family: 'AnimeJaNai V3.1', preset: 'Balanced', arch: 'janai-v31-bal', macs: 242112, trt: 3.9 },
  'janai-v31-bal-sharp': { family: 'AnimeJaNai V3.1', preset: 'Balanced Sharp1', arch: 'janai-v31-bal', macs: 242112, trt: 3.9 },
  'janai-v3-compact': { family: 'AnimeJaNai V3', preset: 'Compact (Quality)', arch: 'janai-v3-compact', macs: 598464, trt: 3.5 },
  'janai-v3-uc': { family: 'AnimeJaNai V3', preset: 'UltraCompact', arch: 'janai-v3-uc', macs: 303552, trt: 3.3 },
  'janai-v3-suc': { family: 'AnimeJaNai V3', preset: 'SuperUltraCompact', arch: 'janai-v3-suc', macs: 44712, trt: 2.0 },
  'janai-sd-compact': { family: 'AnimeJaNai SD', preset: 'Compact', arch: 'janai-v3-compact', macs: 598464, trt: 3.5 },
  'anisd-span': { family: 'AniSD', preset: 'G6i1', arch: 'anisd', macs: 409680, trt: 2.0 },
  'anisd-ac': { family: 'AniSD', preset: 'AC', arch: 'anisd', macs: 409680, trt: 2.0 },
};
export const modelName = (id) => (MODELS[id] ? `${MODELS[id].family} ${MODELS[id].preset}` : id);

// Размер кадра — для бенчмарка (время модели зависит от числа пикселей, не от содержимого)
export const sizeClass = (h) => (h <= 576 ? 'sd' : h <= 800 ? 'hd' : 'fhd');
export const CLASS_SIZE = { sd: [854, 480], hd: [1280, 720], fhd: [1920, 1080] };

// Класс исходника — по содержимому (native.js: blur — во сколько раз картинка мягче своего кадра):
// clean — честное разрешение; soft — заметно мягче (HD, нарисованный ниже своего кадра, сжатие);
// blur — растянутый SD («720p», внутри которого DVD). blur ставится только по устоявшейся оценке (много кадров,
// малый разброс) и только для кадра до 800 строк (у 4:3 — по ширине: 1280x960 — это «720p»): мягкая HD-серия
// в 1080p — это soft, SD-модели там не нужны. Пока оценки нет — clean: его модели не портят и мягкий исходник.
// Пороги — по сканам целых серий (5 мест по 12 кадров): Naruto 2x2 «720p» — 2.43, Toradora — 2.17 (окна сильно
// расходятся, разброс 0.4 — на границе), Frieren / JJK / CSM 720p — 1.24–1.35, Demon Slayer 1080p — 1.91 (soft: 1080p).
export const CLASSES = ['clean', 'soft', 'blur'];
export const CLASS_LABEL = { clean: 'чёткий исходник', soft: 'мягкий исходник', blur: 'растянутый SD' };
// prev — нынешний класс: уже признанный растянутым SD держится, пока оценка не уйдёт заметно (гистерезис —
// иначе на границе модель переключалась бы туда-сюда). Naruto 2x2 «720p»: размытие 2.3, разброс 0.2–0.3.
export const SOFT_FROM = 1.15; export const BLUR_FROM = 1.8; const BLUR_KEEP = 1.65;
const SPREAD_MAX = 0.4; const SPREAD_KEEP = 0.5;
export function sourceClass(h, est, w = 0, prev = '') {
  if (!est) return 'clean';
  const h169 = w ? Math.min(h, Math.round(w * 9 / 16)) : h;
  const keep = prev === 'blur';
  if (h169 <= 800 && est.n >= 10 && est.blur >= (keep ? BLUR_KEEP : BLUR_FROM) && est.spread <= (keep ? SPREAD_KEEP : SPREAD_MAX)) return 'blur';
  return est.blur >= SOFT_FROM ? 'soft' : 'clean';
}

// Ручные уровни: пресеты на выбор для каждого класса исходника (первый — по умолчанию; «Резкость» — вариант).
export const TIERS = ['fast', 'quality', 'max'];
export const TIER_LABEL = { fast: 'Лёгкое', quality: 'Сильное', max: 'Максимальное' };
const ART = ['artcnn-c4f16', 'artcnn-c4f32'];
const MID = ['janai-v31-perf', 'janai-v3-suc'];
export const LEVELS = {
  fast: { clean: ART, soft: ART, blur: ART },
  quality: { clean: MID, soft: MID, blur: MID },
  max: {
    clean: ['anisd-ac', 'janai-v31-bal', 'janai-sd-compact'],
    soft: ['janai-v31-bal', 'anisd-ac', 'janai-sd-compact'],
    blur: ['janai-sd-compact', 'janai-v31-bal', 'anisd-ac'],
  },
};
const TIER_OF_ARCH = { 'artcnn-c4f16': 'fast', 'artcnn-c4f32': 'fast', 'janai-v31-perf': 'quality', 'janai-v3-suc': 'quality', 'janai-v3-uc': 'quality' };
export const tierOf = (id) => (MODELS[id] && TIER_OF_ARCH[MODELS[id].arch]) || 'max';

// «Резкость» — только на ручном уровне: вариант той же сети. Мягче — ближе к исходнику, Резче — тоньше линии.
// V3.1 на «Обычно»: на чётком исходнике — обычная, на мягком — Sharp1 (по замерам она там лучше).
// ArtCNN DN (подавление шума) не берётся: по замерам хуже обычной даже на сильно сжатых стримах.
export const SHARPNESS = ['soft', 'normal', 'sharp'];
export const SHARP_LABEL = { soft: 'Мягче', normal: 'Обычно', sharp: 'Резче' };
export function styled(id, style, cls) {
  const m = MODELS[id];
  if (!m) return id;
  if (m.family === 'ArtCNN') return style === 'sharp' ? `${m.arch}-ds` : m.arch;
  if (m.family === 'AnimeJaNai V3.1') return style === 'sharp' || (style === 'normal' && cls !== 'clean') ? `${m.arch}-sharp` : m.arch;
  if (m.family === 'AniSD') return style === 'soft' ? 'anisd-span' : 'anisd-ac';
  return id;
}

// «Авто»: готовые пресеты для класса исходника, от лучшего к худшему — берётся первый, что успевает. «Резкость»
// здесь не участвует: в «Авто» модель выбирается за пользователя (это лучшие пресеты класса — как «Обычно»).
// Дальше по списку — дешевле: Balanced / AniSD / SD Compact -> Performance (в 2.7 раза дешевле Balanced) -> ArtCNN.
const AUTO = {
  clean: ['anisd-ac', 'janai-v31-perf', 'artcnn-c4f16'],
  soft: ['janai-v31-bal-sharp', 'janai-v31-perf-sharp', 'artcnn-c4f16'],
  blur: ['janai-sd-compact', 'janai-v31-bal-sharp', 'janai-v31-perf-sharp', 'artcnn-c4f16'],
};
export const autoList = (cls) => AUTO[cls] || AUTO.clean;

export const SECOND = 'artcnn-c4f16'; // второй проход x2 — когда целевое разрешение больше 2.5 исходного
