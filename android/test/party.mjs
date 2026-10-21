// Совместный просмотр «телефон ↔ компьютер» через настоящие публичные MQTT-брокеры: телефон создаёт комнату кнопкой
// «Смотреть вместе», приложение для ПК (скрытое окно Electron, _party-peer.cjs) входит по коду; оба видят двух
// участников, сообщение из чата телефона доходит до ПК и обратно, «Пригласить» — ссылка в буфер, выход виден
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureDevice, install, launch, js, until, check, skip, done, tap, sleep, screenshot, typeText, waitFor, ROOT, pageErrors, windowState } from './_device.mjs';

await ensureDevice();
install();
await launch({ fresh: true });
if ((await js(`fetch('/api/config/toggles').then((r) => r.status)`)) >= 500) { skip('совместный просмотр', 'бекенд Anixart не отвечает'); done('party'); }

await tap('.release-row', { index: 0, wait: 25000, after: 1200 });
await tap('.btn-party', { wait: 20000, after: 2500 });
const code = await until(`import('/js/party/room.js').then(({ party }) => party.room?.code || null)`, 20000);
check('«Смотреть вместе» — комната создана', !!code, code);
if (!code) done('party');

// второй участник — приложение для ПК
const events = [];
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const peer = spawn(electron, [path.join(ROOT, 'android', 'test', '_party-peer.cjs'), code], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
peer.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.startsWith('PEER ')) events.push(JSON.parse(l.slice(5))); });
const ev = (fn, ms) => waitFor(() => events.find(fn), ms, 300);
try {
  check('ПК вошёл в комнату телефона', !!(await ev((e) => e.joined, 30000)));
  check('телефон видит двух участников', !!(await until(`import('/js/party/room.js').then(({ party, present }) => party.room && present().length === 2)`, 30000)));
  check('ПК видит двух участников', !!(await ev((e) => e.members === 2, 30000)));

  // чат из панели комнаты на телефоне
  await tap('.appbar .party-btn', { after: 1200 });
  check('панель комнаты открылась', !!(await until(`!!document.querySelector('.party-send input')`, 5000)));
  screenshot('party-panel');
  check('при открытой панели карточка «заходит в комнату» не закрывает поле чата', !!(await until(`!document.querySelector('.party-bubble:not(.out)') || ![...document.querySelectorAll('.party-bubble')].some((b) => /Заходит/.test(b.textContent))`, 8000)));
  await until(`!document.querySelector('.party-bubble:not(.out)')`, 8000); // «Комната создана» и т. п. — исчезают сами
  await tap('.party-send input', { after: 1500 }); // клавиатура выезжает — панель ужимается, кнопка «Отправить» переезжает
  const focused = await js(`document.activeElement === document.querySelector('.party-send input')`);
  if (!focused) { screenshot('party-input-miss'); console.log('  поле чата без фокуса, в фокусе:', await js(`document.activeElement?.className || document.activeElement?.tagName`)); }
  check('тап по полю чата — фокус в нём', focused);
  await typeText('phone');
  // комната обновилась, пока пишем (хост поменял настройку) — панель перерисовалась, а поле с текстом и клавиатура на месте
  await js(`import('/js/party/room.js').then(({ setControl }) => (setControl('host'), 1))`);
  await sleep(1200);
  const kept = await js(`({ focus: document.activeElement === document.querySelector('.party-send input'), value: document.querySelector('.party-send input')?.value })`);
  check('комната обновилась во время набора — фокус и текст в поле чата на месте', kept.focus && kept.value === 'phone' && (await windowState()).imeVisible, kept);
  await js(`import('/js/party/room.js').then(({ setControl }) => (setControl('all'), 1))`);
  await sleep(800);
  await typeText('-hello');
  screenshot('party-typed');
  await tap('.party-send button', { after: 800 });
  const sent = await js(`import('/js/party/room.js').then(({ party }) => ({ chat: party.room.chat.map((m) => m.text), value: document.querySelector('.party-send input')?.value, focus: document.activeElement?.className }))`);
  check('сообщение отправлено с телефона (есть в чате, поле очистилось)', sent.chat.includes('phone-hello') && !sent.value, sent);
  const got = await ev((e) => e.chat, 30000);
  check('сообщение телефона дошло до ПК', !!got, got?.chat);
  check('ответ ПК виден на телефоне', !!(await until(`/pc-hello/.test(document.querySelector('.party-panel')?.textContent || '')`, 30000)));

  // «Пригласить» — https-ссылка с кодом в буфере обмена, подтверждение
  await tap('.party-panel .btn-primary', { text: 'Пригласить', after: 1200 });
  check('«Пригласить» — «Приглашение скопировано»', !!(await until(`/Приглашение скопировано/.test(document.body.textContent)`, 5000)));

  await js(`import('/js/party/room.js').then(({ sendChat }) => (sendChat('phone-bye'), 1))`);
  check('ПК получил прощание и вышел', !!(await ev((e) => e.bye, 30000)));
  check('телефон видит, что участник ушёл', !!(await until(`import('/js/party/room.js').then(({ present }) => present().length === 1)`, 40000)));
  await tap('.party-panel .btn', { text: 'Выйти из комнаты', after: 1200 });
  check('«Выйти из комнаты» — комнаты нет', await js(`import('/js/party/room.js').then(({ party }) => !party.room)`));
} finally {
  peer.kill();
}
await sleep(300);
check('на странице нет необработанных ошибок', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
done('party');
