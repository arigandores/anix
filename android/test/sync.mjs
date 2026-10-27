// Синхронизация истории просмотра на телефоне (public/js/sync.js ↔ cloud/sync): сервер синхронизации — локальный
// (wrangler dev на компьютере, вход «test:<pid>»), телефон ходит к нему через adb reverse.
//  1. «на ПК» посмотрели 5-ю до 12:30 (записи — прямо в сервер) — на телефоне страница аниме «Продолжить · 5 серия»,
//     озвучка с ПК и «ещё 12 мин» (запросы из WebView к другому адресу — CORS)
//  2. «Продолжить» — серия с 12:30 без вопроса
//  3. смотрим и гасим экран (уходим из приложения: MainActivity.onStop → пауза и отправка), приложение убито —
//     место на сервере
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ensureDevice, install, launch, js, until, check, skip, done, tap, sleep, screenshot, sh, adb, PKG, pageErrors, persist, waitFor, ROOT } from './_device.mjs';

const RID = 21; const PID = 777;
const WRANGLER = path.join(ROOT, 'cloud', 'sync', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
if (!fs.existsSync(WRANGLER)) { skip('sync', 'нет cloud/sync/node_modules — cd cloud/sync && npm install'); done('sync'); }

await ensureDevice();
install();

// сервер синхронизации на компьютере — свой порт и пустая база; на телефоне тот же порт (adb reverse)
const port = await new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anix-sync-'));
const wr = spawn('node', [WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--var', 'TEST_AUTH:1', '--persist-to', persistDir, '--show-interactive-dev-session=false'],
  { cwd: path.join(ROOT, 'cloud', 'sync'), shell: process.platform === 'win32', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
const killWr = () => { try { if (process.platform === 'win32') execSync(`taskkill /pid ${wr.pid} /T /F`, { stdio: 'ignore' }); else wr.kill('SIGKILL'); } catch { /* уже */ } };
process.on('exit', () => { killWr(); try { adb('reverse', '--remove', `tcp:${port}`); } catch { /* нет */ } });
const SYNC = `http://127.0.0.1:${port}`;
if (!(await waitFor(async () => { try { return (await fetch(`${SYNC}/v1/pull`)).status === 400; } catch { return false; } }, 90000, 1000))) { check('сервер синхронизации запустился', false); done('sync'); }
adb('reverse', `tcp:${port}`, `tcp:${port}`);
const serverRel = async () => (await (await fetch(`${SYNC}/v1/pull?pid=${PID}&cursor=0:0:`, { headers: { 'X-Anix-Token': `test:${PID}` } })).json()).releases?.[RID];

await launch({ fresh: true });
if ((await js(`fetch('/api/config/toggles').then((r) => r.status)`)) >= 500) { skip('sync', 'бекенд Anixart не отвечает'); done('sync'); }
// озвучка с Kodik у «Мастера Муси» — настоящая
const pick = await js(`(async () => {
  const { A } = await import('/js/api.js');
  for (const ty of (await A.types(${RID})).types) {
    const so = (await A.sources(${RID}, ty.id)).sources.find((s) => /kodik/i.test(s.name));
    if (so) return { typeId: ty.id, typeName: ty.name, sourceId: so.id, sourceName: so.name };
  }
  return null;
})()`);
if (!pick) { skip('sync', 'нет озвучки с Kodik'); done('sync'); }

// 1. «ПК» отправил историю: 5-я серия, 12:30 из 24:10
const now = Date.now();
const pc = await fetch(`${SYNC}/v1/push`, { method: 'POST', headers: { 'X-Anix-Token': `test:${PID}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: PID, releases: { [RID]: {
  last: { releaseId: RID, typeId: pick.typeId, sourceId: pick.sourceId, position: 5, typeName: pick.typeName, sourceName: pick.sourceName, timestamp: Math.floor(now / 1000), at: now },
  eps: { [`${pick.sourceId}:5`]: { releaseId: RID, sourceId: pick.sourceId, position: 5, playbackPosition: 750000, duration: 1450000, isWatched: true, savedAt: now, at: now } },
} } }) });
check('«ПК» отправил историю', pc.ok);

// телефон: вход (тестовый) и свой сервер синхронизации — после перезапуска приложения
await js(`(localStorage.setItem('anixart.sync.url', ${JSON.stringify(SYNC)}), localStorage.setItem('anixart.token', 'test:${PID}'), localStorage.setItem('anixart.profile', JSON.stringify({ id: ${PID}, login: 'test' })), 1)`);
await persist();
await launch();
await js(`(import('/js/router.js').then((m) => m.navigate('release', { id: ${RID} })), 1)`);
const watchText = `(document.querySelector('#viewport > .screen:last-child .watch')?.innerText || '').replace(/\\s+/g, ' ').trim()`;
await until(`/Продолжить · 5 серия/.test(${watchText})`, 20000);
const w1 = await js(watchText);
check('страница аниме — «Продолжить · 5 серия», озвучка с ПК и «ещё 12 мин»', /Продолжить · 5 серия/.test(w1) && /ещё 12 мин/.test(w1) && w1.includes(pick.typeName), w1);
screenshot('sync-release');

// 2. «Продолжить» — серия с 12:30
await tap('.watch .btn-watch', { wait: 10000 });
const started = await until(`(() => { const v = document.querySelector('.player-overlay video'); return !!v && v.currentTime > 745 && !v.paused; })()`, 40000);
check('«Продолжить» — 5-я серия идёт с 12:30', !!started, await js(`JSON.stringify((() => { const v = document.querySelector('.player-overlay video');
  return { overlay: !!document.querySelector('.player-overlay'), t: v?.currentTime, paused: v?.paused, ready: v?.readyState, msg: document.querySelector('.player-overlay')?.innerText.replace(/\\s+/g, ' ').slice(0, 200),
    toast: document.getElementById('toast')?.textContent, dialog: document.querySelector('.backdrop')?.innerText.slice(0, 200), screen: document.body.dataset.screen }; })())`));
screenshot('sync-after-continue');
if (!started) done('sync');
await until(`document.querySelector('.player-overlay video').currentTime > 753`, 15000);

// 3. гасим экран посреди серии (onStop: пауза и отправка), через 3 с приложение убито — место на сервере
sh('input keyevent 223');
await sleep(3000);
const tStop = await js(`document.querySelector('.player-overlay video')?.currentTime || 0`).catch(() => 0);
sh(`am force-stop ${PKG}`);
const ep5 = await waitFor(async () => { const r = await serverRel(); const e = r?.eps?.[`${pick.sourceId}:5`]; return e && e.playbackPosition > 751000 ? e : null; }, 5000, 500);
check('погасили экран и закрыли приложение посреди серии — место на сервере', !!ep5 && Math.abs(ep5.playbackPosition / 1000 - tStop) < 3,
  `${ep5 ? (ep5.playbackPosition / 1000).toFixed(1) : '—'} с, на паузе ${Number(tStop).toFixed(1)} с`);
sh('input keyevent 224'); sh('wm dismiss-keyguard');
await sleep(1000);

await launch();
await js(`(import('/js/router.js').then((m) => m.navigate('release', { id: ${RID} })), 1)`);
await until(`/Продолжить · 5 серия/.test(${watchText})`, 20000);
check('после перезапуска — «Продолжить» с того же места', /остановились на 12:3\d|остановились на 12:[4-5]\d/.test(await js(watchText)), await js(watchText));

// 4–5. серия идёт, без паузы: «Домой» (серия уходит в «картинку в картинке», onStop нет) или список недавних — и
// приложение смахнули (процесс убит). Место на сервере — с момента ухода (onPause), а не с последней отправки раз в 30 с
for (const [what, keycode] of [['«Домой» (картинка в картинке)', 3], ['список недавних', 187]]) {
  await tap('.watch .btn-watch', { wait: 10000 });
  if (!(await until(`(() => { const v = document.querySelector('.player-overlay video'); return !!v && !v.paused && v.currentTime > 0; })()`, 40000))) { check(`${what}: серия запустилась`, false); continue; }
  const t0 = await js(`document.querySelector('.player-overlay video').currentTime`);
  await until(`document.querySelector('.player-overlay video').currentTime > ${t0 + 12}`, 30000); // дольше раза в 10 с: место уже сохранялось
  const tLeave = await js(`document.querySelector('.player-overlay video').currentTime`);
  sh(`input keyevent ${keycode}`);
  await sleep(800); // смахивают быстро — меньше секунды
  sh(`am force-stop ${PKG}`);
  const e = await waitFor(async () => { const r = await serverRel(); const x = r?.eps?.[`${pick.sourceId}:5`]; return x && Math.abs(x.playbackPosition / 1000 - tLeave) < 4 ? x : null; }, 5000, 500);
  const got = (await serverRel())?.eps?.[`${pick.sourceId}:5`]?.playbackPosition;
  check(`${what} посреди серии и приложение смахнули — место на сервере`, !!e, `на сервере ${got / 1000} с, ушли на ${Number(tLeave).toFixed(1)} с`);
  sh('input keyevent 3');
  await launch();
  await js(`(import('/js/router.js').then((m) => m.navigate('release', { id: ${RID} })), 1)`);
  await until(`/Продолжить · 5 серия/.test(${watchText})`, 20000);
}
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('sync');
