'use strict';
// Все основные тесты разом: параллельно, каждый Electron-тест в своём профиле (_isolated.js), логи — в test/logs.
// Тесты ждут загрузки экранов (_settle.js), а не фиксированные паузы. Плавность апскейла меряется рядом с другими:
// их скрытые окна рисуют раз в секунду и видеокарту почти не занимают.
//   node test/run-all.js            основной набор
//   node test/run-all.js e2e resume только перечисленные
//   -j N                            сколько тестов одновременно (по умолчанию 4)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron'); // в Node это путь к electron.exe

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(__dirname, 'logs');
// [имя, файл, движок, отдельно]; долгие — первыми, чтобы короткие заполняли места рядом с ними
const SUITE = [
  ['skeleton-match', 'skeleton-match.js', 'electron'],
  ['upscale', 'upscale.js', 'electron'],
  ['upscale-fallback', 'upscale-fallback.js', 'electron'], // без ускорения NVIDIA: старый драйвер, GTX, AMD (SwiftShader), зависшая проверка
  ['ui-audit', 'ui-audit.js', 'electron'],
  ['layout-audit', 'layout-audit.js', 'electron'],
  ['contrast', 'contrast.js', 'electron'],
  ['screen-memory', 'screen-memory.js', 'electron'], // профиль, коллекция, «Популярное»: повторный заход без скелетона
  ['release-skeleton', 'release-skeleton.js', 'electron'], // скелетон страницы аниме совпадает с настоящей страницей
  ['prefetch-spam', 'prefetch-spam.js', 'electron'], // предзагрузка: наведение и нажатие без лишних запросов (перетаскивание — 0)
  ['nav-skeleton', 'nav-skeleton.js', 'electron'], // переход: без голого экрана, контент проявляется поверх скелетона
  ['press-prefetch', 'press-prefetch.js', 'electron'], // «Комментарии», уведомления — с нажатия, «История» — из памяти: без мелькания скелетона
  ['transitions-audit', 'transitions-audit.js', 'electron'], // все экраны: шапка и вкладки не мигают, одна анимация на переход
  ['release-reopen', 'release-reopen.js', 'electron'], // повторный заход на аниме — без скелетона, свежие данные фоном, смена аккаунта чистит память
  ['comments-thread', 'comments-thread.js', 'electron'], // ветки ответов, поле комментария, статус на постере, тёмная тема по умолчанию
  ['motion', 'motion.js', 'electron'], // навигация, вкладки, полосы, перекат чисел, плей/пауза, копирование
  ['empty-center', 'empty-center.js', 'electron'], // пустые экраны и «не найдено» — посередине свободного места
  ['titlebar', 'titlebar.js', 'electron'], // шапка окна: полоса, кнопки окна в цвет экрана, плеер, диалог, полный экран
  ['hero-backdrop', 'hero-backdrop.js', 'electron'], // шапка релиза: кнопки не темнеют после въезда экрана
  ['release-toolbar', 'release-toolbar.js', 'electron'], // шапка релиза: кнопки с первого кадра, без сдвига при загрузке
  ['release-comment-count', 'release-comment-count.js', 'electron'], // число комментариев релиза: не «5» из превью, а всё
  ['chat-scroll', 'chat-scroll.js', 'electron'], // колесо над чатом комнаты: короткий чат не глушит прокрутку панели
  ['release-notif', 'release-notif.js', 'electron'], // колокольчик релиза: только его озвучки, а не весь справочник
  ['lottie', 'lottie.js', 'electron'], // Lottie-анимации: файлы, сердце, жизненный цикл, режим экономии
  ['lottie-icons', 'lottie-icons.js', 'electron'], // жесты при наведении, глаз, полный экран, замок и часы: покой = статичная иконка
  ['e2e', 'e2e.js', 'electron'],
  ['watch-flow', 'watch-flow.js', 'electron'],
  ['sync', 'sync.js', 'electron'], // синхронизация истории между устройствами: локальный сервер (wrangler dev), сбои, аккаунты, обновление
  ['external-position', 'external-position.js', 'electron'], // mpv: место в серии сохраняется и продолжается, как у встроенного
  ['resume-marks', 'resume-marks.js', 'electron'], // «Продолжить» после серий, досмотренных на телефоне (отметки с сервера) — следующая за ними
  ['episodes-sticky', 'episodes-sticky.js', 'electron'], // чипы озвучки, источника и плеера прилипают под шапкой экрана серий
  ['player-center', 'player-center.js', 'electron'], // плеер на паузе: «Продолжить» посреди экрана
  ['web-quality', 'web-quality.js', 'electron'], // веб-плеер: качество AniLibria по «Приоритету качества», а не 720p сайта // путь до серии: «Продолжить», чипы озвучки/источника/плеера, переключатели в плеере
  ['resume', 'resume.js', 'electron'],
  ['pip', 'pip.js', 'electron'], // «Картинка в картинке»: плеер уходит из приложения, кнопки окна PiP, ✕ / «Назад во вкладку», закрытие
  ['player-ind', 'player-ind.js', 'electron'],
  ['audio', 'audio.js', 'electron'], // улучшение звука: громкость сочетаний, задержка, живой <video>
  ['hls-audio', 'hls-audio.js', 'electron'], // звук HLS без CODECS (как у Kodik): AAC LC объявлен как AAC LC, а не HE-AAC — иначе хрип
  ['stream-recover', 'stream-recover.js', 'electron'], // сбои узлов CDN: прокси повторяет и честно рвёт, плеер восстанавливается не один раз за серию
  ['discord', 'discord.js', 'electron'], // статус в Discord против поддельного Discord (~1 мин: ждёт переподключения и лимита)
  ['party', 'party.js', 'electron'], // совместный просмотр: два окна через публичные MQTT-брокеры
  ['party-edge', 'party-edge.js', 'electron'], // совместный просмотр: граничные случаи (~2 мин, тайминги протокола укорочены)
  ['party-watch', 'party-watch.js', 'electron'], // переключатели плеера в комнате: права хоста и гостя, смена озвучки у всех с места
  ['party-pip', 'party-pip.js', 'electron'], // ✕ окна PiP в комнате не ставит паузу всем и не даёт гостю «Управляет только хост»
  ['party-dub-resume', 'party-dub-resume.js', 'electron'], // та же серия в другой озвучке (после выхода из плеера) — с того же места, в комнате и без
  ['update', 'update.js', 'electron'], // автообновление против своего сервера: окно при запуске, «Пропустить», прогресс, ошибка, отмена

  ['smoke', 'smoke.js', 'node'],
  // после остальных и один: два видеотеста одновременно делили бы видеокарту
  ['upscale-trt', 'upscale-trt.js', 'electron', true],
  ['upscale-mini', 'upscale-mini.js', 'electron', true], // «Развернуть» мини-плеер с апскейлом: слой не мелькает в старом месте
  ['upscale-trt-install', 'upscale-trt-install.js', 'electron', true], // установка кнопкой: скачивает 93 МБ
];
// провал — ненулевой код или явные признаки в выводе тестов (LOW-CONTRAST — contrast.js: без него находки
// контраста не роняли общий прогон)
const FAILED = /\bFAIL\b|ERRORS: (?!none)|ISSUES: (?!none)|LOW-CONTRAST: (?!none)|UnhandledPromiseRejection|^Error:/m;

const args = process.argv.slice(2);
const jIdx = args.indexOf('-j');
const jobs = jIdx >= 0 ? Number(args.splice(jIdx, 2)[1]) : 4;
const only = args.filter((a) => !a.startsWith('-'));
const tests = SUITE.filter(([name]) => !only.length || only.includes(name));
if (!tests.length) { console.log('нет таких тестов; есть:', SUITE.map((t) => t[0]).join(', ')); process.exit(2); }
fs.mkdirSync(LOGS, { recursive: true });

function run([name, file, engine]) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anix-test-${name}-`));
    const cmd = engine === 'node' ? process.execPath : electron;
    const argv = engine === 'node' ? [path.join(__dirname, file)] : [path.join(__dirname, '_isolated.js'), dir, path.join(__dirname, file)];
    const p = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' }, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += '\nFAIL: тайм-аут 10 мин'; p.kill(); }, 600000);
    p.on('close', (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(LOGS, `${name}.log`), out);
      fs.rm(dir, { recursive: true, force: true }, () => {});
      // шум Chromium в выводе не считаем провалом теста
      const clean = out.split('\n').filter((l) => !/^\[\d+:\d+\/|Electron Security Warning|Content-Security-Policy|this app to unnecessary|For more information|^https?:\/\//.test(l)).join('\n');
      const ok = code === 0 && !FAILED.test(clean);
      const sec = ((Date.now() - t0) / 1000).toFixed(0);
      // SKIP — проверка не проводилась (например, видеокарту занимает игра): прошёл, но не целиком — видно в итоге
      const skips = (clean.match(/^SKIP\b.*$/gm) || []);
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(15)} ${sec.padStart(4)} с${ok ? '' : `  → test/logs/${name}.log`}${skips.length ? `  (пропущено проверок: ${skips.length})` : ''}`);
      resolve({ name, ok, sec, clean, skips });
    });
  });
}

(async () => {
  const t0 = Date.now();
  const queue = tests.filter((t) => !t[3]);
  const results = [];
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
    while (queue.length) results.push(await run(queue.shift()));
  }));
  for (const t of tests.filter((x) => x[3])) results.push(await run(t));
  const bad = results.filter((r) => !r.ok);
  for (const r of bad) {
    console.log(`\n--- ${r.name} (последние строки) ---`);
    console.log(r.clean.trim().split('\n').slice(-15).join('\n'));
  }
  const skipped = results.filter((r) => r.skips.length);
  if (skipped.length) {
    console.log('\n--- пропущенные проверки ---');
    for (const r of skipped) console.log(r.skips.map((l) => `${r.name}: ${l}`).join('\n'));
  }
  console.log(`\n${bad.length ? `ПРОВАЛЕНО: ${bad.map((r) => r.name).join(', ')}` : skipped.length ? 'ПРОШЛО, НО С ПРОПУСКАМИ' : 'ВСЁ ПРОШЛО'} · ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  process.exit(bad.length ? 1 : 0);
})();
