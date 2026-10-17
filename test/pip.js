'use strict';
require('./_failfast'); // упал — сразу FAIL с текстом ошибки, без ожидания таймаута
// «Картинка в картинке»: плеер уходит из приложения (каталог свободен, клавиши не забирает), кнопки окна PiP
// (серии, ±10 с) и название в нём, следующая серия без невидимого «Продолжить?», ✕, «Назад во
// вкладку» и «Развернуть» — плеер во весь размер (после ✕ пауза браузера снята), закрытие плеера закрывает и окно PiP.
// ✕ и «Назад во вкладку» окна PiP имитируются: выход из PiP с паузой рядом (так делает ✕) и без неё.
const { app, BrowserWindow, nativeTheme } = require('electron');
const { start } = require('../server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ` — ${info}` : ''}`); if (!ok) fails++; };
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  const srv = await start(0);
  const win = new BrowserWindow({ width: 1100, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(srv.url);
  const js = (c) => win.webContents.executeJavaScript(c, true); // true — с жестом пользователя (PiP без него не открыть)
  const until = async (cond, max = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { if (await js(cond)) return true; await sleep(100); } return false; };
  await until(`!!document.querySelector('#viewport .screen')`, 15000);
  // обработчики mediaSession — для вызова «кнопок окна PiP»
  await js(`(() => { window.__ms = {}; const s = navigator.mediaSession; const o = s.setActionHandler.bind(s);
    s.setActionHandler = (a, f) => { __ms[a] = f; o(a, f); }; })(); 1`);
  const eps = JSON.parse(await js(`(async () => {
    const r = await (await fetch('/api/episode/1/1/8?sort=1')).json(); window.__eps = r.episodes;
    return JSON.stringify(r.episodes.slice(0, 2).map((e) => ({ sid: e.sourceId ?? e.source?.id, pos: e.position, name: e.name || e.position + ' серия' })));
  })()`));
  if (eps.length < 2) throw new Error('в тестовом аниме меньше двух серий');
  // вторая серия начата раньше — в PiP продолжится с места без вопроса
  await js(`import('/js/store.js').then(({ db }) => { db.putEpisode(1, ${eps[1].sid}, ${JSON.stringify(eps[1].pos)}, { playbackPosition: 30000 }); db.putEpisode(1, ${eps[0].sid}, ${JSON.stringify(eps[0].pos)}, { playbackPosition: 0 }); return 1; })`);
  await js(`import('/js/player.js').then(({ openBuiltinPlayer }) => { window.__p = openBuiltinPlayer({ release: { id: 1, title_ru: 'Котёнок Ти' }, episodes: __eps, index: 0, sort: 1, startAt: 1000 }); return 1; })`);
  const V = `document.querySelector('.player-overlay video')`;
  const OV = `document.querySelector('.player-overlay')`;
  const playing = `(() => { const v = ${V}; return !!v && v.readyState >= 3 && !v.paused; })()`;
  check('серия запустилась', await until(playing, 30000));
  const state = () => js(`(() => { const ov = ${OV}; const v = ${V};
    return { pip: !!v && document.pictureInPictureElement === v, anyPip: !!document.pictureInPictureElement, ov: !!ov, shown: !!ov && getComputedStyle(ov).display !== 'none',
      mini: !!ov && ov.classList.contains('mini'), paused: !!v && v.paused, t: v ? v.currentTime : 0, ep: ov ? ov.querySelector('.ttl span').textContent : '',
      dialog: !!document.querySelector('.backdrop:not(.closing)') }; })()`);

  // 1. Кнопка PiP: плеер уходит из приложения
  check('кнопка PiP есть', await js(`!!document.querySelector('.player-controls .pip-btn')`));
  await js(`document.querySelector('.player-controls .pip-btn, .player-controls [title^="Картинка в картинке"]').click(); 1`);
  check('PiP открылся', await until(`document.pictureInPictureElement === ${V}`));
  let s = await state();
  check('в PiP плеер в приложении не виден', !s.shown, JSON.stringify(s));
  // 2. Клавиши приложения плеер не забирает: Esc не закрывает его, пробел не ставит на паузу
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); 1`);
  await sleep(300);
  s = await state();
  check('Esc и пробел в приложении не трогают плеер в PiP', s.ov && s.pip && !s.paused, JSON.stringify(s));
  // 3. Название и постер — в окне PiP; кнопки серий и ±10 с
  const meta = JSON.parse(await js(`JSON.stringify({ title: navigator.mediaSession.metadata && navigator.mediaSession.metadata.title, artist: navigator.mediaSession.metadata && navigator.mediaSession.metadata.artist, next: typeof __ms.nexttrack, prev: __ms.previoustrack, back: typeof __ms.seekbackward })`));
  check('название серии в окне PiP', meta.title === eps[0].name && meta.artist === 'Котёнок Ти', JSON.stringify(meta));
  check('кнопки «следующая серия» и −10 с есть, «предыдущей» на первой серии нет', meta.next === 'function' && meta.back === 'function' && meta.prev == null, JSON.stringify(meta));
  const t0 = (await state()).t;
  await js(`__ms.seekforward({ action: 'seekforward' }); 1`);
  await sleep(200);
  s = await state();
  check('+10 с из окна PiP', s.t - t0 > 8, `${t0.toFixed(1)} → ${s.t.toFixed(1)}`);
  // 4. Следующая серия в PiP: без вопроса «Продолжить?» (его не видно), с сохранённого места, PiP остаётся
  await js(`__ms.nexttrack({ action: 'nexttrack' }); 1`);
  const nextOk = await until(`(() => { const ov = ${OV}; const v = ${V}; return ov.querySelector('.ttl span').textContent === ${JSON.stringify(eps[1].name)} && v.readyState >= 3 && !v.paused; })()`, 30000);
  s = await state();
  check('следующая серия идёт в PiP без «Продолжить?», с места', nextOk && s.pip && !s.dialog && s.t >= 29, JSON.stringify(s));
  check('название в окне PiP сменилось', await js(`navigator.mediaSession.metadata.title === ${JSON.stringify(eps[1].name)} && typeof __ms.previoustrack === 'function'`));
  // 5. ✕ в окне PiP (браузер ставит паузу рядом с выходом) — как «Назад во вкладку»: плеер во весь размер, серия идёт
  await js(`${V}.pause(); document.exitPictureInPicture(); 1`);
  const fullAgain = `(() => { const ov = ${OV}; return !document.pictureInPictureElement && getComputedStyle(ov).display !== 'none' && !ov.classList.contains('mini'); })()`;
  check('✕ в окне PiP — плеер во весь размер', await until(fullAgain, 3000));
  check('после ✕ серия идёт (пауза браузера снята)', await until(playing, 3000), JSON.stringify(await state()));
  // ✕ после паузы, которую поставили сами раньше, — пауза остаётся
  await js(`${V}.requestPictureInPicture(); 1`);
  await until(`document.pictureInPictureElement === ${V}`);
  await js(`${V}.pause(); 1`); await sleep(1000);
  await js(`document.exitPictureInPicture(); 1`);
  await until(fullAgain, 3000); await sleep(400);
  s = await state();
  check('✕ на своей паузе — плеер во весь размер, пауза остаётся', s.shown && !s.mini && s.paused, JSON.stringify(s));
  // 6. Снова в PiP клавишей I, «Развернуть» (комната) — обратно в приложение во весь размер
  await js(`${V}.play(); 1`);
  await until(playing);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true })); 1`);
  check('I — в PiP', await until(`document.pictureInPictureElement === ${V}`));
  await js(`${OV}.mini(false); 1`);
  check('«Развернуть» в PiP — плеер в приложении во весь размер', await until(`(() => { const ov = ${OV}; return !document.pictureInPictureElement && getComputedStyle(ov).display !== 'none' && !ov.classList.contains('mini'); })()`, 3000));
  // 7. «Назад во вкладку» (выход без паузы) из свёрнутого в угол плеера — во весь размер, серия идёт
  await js(`${OV}.mini(true); 1`);
  await js(`${V}.requestPictureInPicture(); 1`);
  await until(`document.pictureInPictureElement === ${V}`);
  await js(`document.exitPictureInPicture(); 1`);
  check('«Назад во вкладку» — плеер во весь размер', await until(`(() => { const ov = ${OV}; return getComputedStyle(ov).display !== 'none' && !ov.classList.contains('mini'); })()`, 3000));
  s = await state();
  check('после «Назад во вкладку» серия идёт', !s.paused, JSON.stringify(s));
  // 8. Закрыли плеер в PiP — окно PiP закрывается, кнопки окна PiP и клавиш мультимедиа сняты
  await js(`${V}.requestPictureInPicture(); 1`);
  await until(`document.pictureInPictureElement === ${V}`);
  await js(`window.__p.close(); 1`);
  await sleep(500);
  s = await state();
  check('закрыли плеер — окна PiP нет', !s.ov && !s.anyPip, JSON.stringify(s));
  check('кнопки серий сняты', await js(`__ms.nexttrack == null && __ms.seekforward == null && navigator.mediaSession.metadata == null`));
  console.log(fails ? `FAIL pip: ${fails}` : 'pip: all ok');
  srv.server.close();
  app.exit(fails ? 1 : 0);
});
