// Совместный просмотр: комната по коду, общее состояние плеера, участники и чат. Связь — party/net.js.
// Схема собрана по Syncplay и Jellyfin SyncPlay:
//  • Одно общее состояние { seq, cmd, content, paused, pos, at, rate, wait } — любая команда участника (пауза,
//    перемотка, серия, скорость) публикуется как следующее состояние (seq+1); одновременные команды с одним seq
//    разрешаются по cmd — у всех одинаково. pos — позиция в момент at (часы автора, from).
//  • Часы: у каждого свои; разницу с каждым участником меряем пингами, как NTP (берём замер с наименьшей задержкой).
//  • Ведущий — самый давний участник: раз в 5 с переопубликует отсчёт (pos, at) в своих часах, ведёт ожидание всех.
//  • Рассинхрон: до 0,15 с — ничего; до 2,5 с — плавно скоростью (±10 %); больше — перемотка и 1,5 с без поправок.
//    Перемотка во время игры — с упреждением на время догрузки после неё (меряется на каждой перемотке): иначе
//    после перемотки участник всегда отстаёт на это время. Первые 6 с после пуска перематываем уже от 0,6 с.
//  • Ожидание всех: смена серии ставит всех на паузу (wait); каждый, у кого серия готова, шлёт ready; ведущий
//    запускает всех разом через 0,6 с, когда готовы все или прошло 10 с.
//  • Очередь «Дальше» (queue) — часть состояния: предложить может любой, включить — кто может управлять, порядок и
//    удаление — хост (своё предложение может убрать и автор). Кончились серии — включается первое из очереди.
//    Одновременные правки решаются как любые команды; своё предложение, проигравшее в такой гонке, добавляется снова.
// Видео каждый берёт сам; через брокеры идут только команды. Управлять могут все или только хост (ctrl); хост ушёл —
// хостом становится самый давний участник.
// Настройки картинки и звука (апскейл, улучшение звука, качество) у каждого свои — их комната не трогает.
import { connectRoom, newCode, normCode, fmtCode, randomId } from './net.js';
import { A, auth } from '../api.js';
import { prefs, db } from '../store.js';

// Тайминги протокола, мс. Тесты подменяют их короткими (window.__anixPartyTiming) — логика та же, ждать меньше
const TIMING = {
  hb: 10000, gone: 32000, // сердцебиение; участник пропал, если от него столько ничего
  ref: 5000, // ведущий переопубликует отсчёт
  stale: 15000, // отсчёт без автора старше этого — «мёртвая» комната
  hostGone: 2000, // хост пропал (закрыл приложение, оборвалась связь) столько назад — хостом становится ведущий
  joinQuiet: 6000, // только вошедший столько не берёт на себя роль ведущего
  synced: 5000, empty: 7000, ping: 15000,
  confirmGone: 4000, // «последняя воля» от одного брокера — столько ждём, отзовётся ли участник
};
const T = (k) => window.__anixPartyTiming?.[k] ?? TIMING[k];
const DEAD = 0.15; const SEEK_AT = 2.5; const NUDGE_MAX = 0.1; const COOLDOWN_MS = 1500;
const WARM_MS = 6000; const WARM_SEEK = 0.6; // первые секунды после пуска: догоняем перемоткой, а не скоростью
const WAIT_MAX_MS = 10000; const GO_DELAY_MS = 600;

const listeners = new Set();
let room = null;
const emit = (type, data) => { for (const fn of listeners) { try { fn(type, data); } catch (e) { console.error(e); } } };

export const party = {
  get room() { return room; },
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  create: () => enter(newCode(), true),
  join: (code) => { const c = normCode(code); if (!c) throw new Error('Неверный код комнаты'); return enter(c, false); },
  leave,
  fmtCode,
  intent: null, // { queue: 'any' } — «Предложить»: выбранная серия любого аниме уйдёт в очередь (party/ui.js, suggestMode)
};

// служебное уведомление комнаты — той же карточкой, что действия участников и чат (party/ui.js)
const info = (text) => emit('notice', { system: true, text });
const myName = () => auth.profile?.login || `Гость ${room?.peerId.slice(0, 4).toUpperCase() || ''}`;
const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
const contentKey = (c) => (c ? `${c.releaseId}:${c.sourceId}:${c.position}` : '');

async function enter(code, creator) {
  if (room) await leave();
  const peerId = randomId(6);
  const r = {
    code, peerId, creator, joinedAt: Date.now(),
    members: new Map(), // peerId → { name, avatar, joinedAt, lastSeen }
    clocks: new Map(), // peerId → [{ off, rtt }] — off = их часы − мои
    state: null, chat: [], readies: new Map(), player: null, timers: [], net: null,
    synced: creator, pending: null, // вошедший не трогает общее состояние, пока не узнал его (или комната пуста)
    myAdds: new Map(), hostGoneAt: 0, // мои предложения, ещё не подтверждённые чужим состоянием; когда пропал хост
  };
  room = r;
  try {
    r.net = await connectRoom(code, { peerId, onMessage, onGone: (id, url) => brokerGone(id, url), onStatus: () => emit('status') });
  } catch (e) { if (room === r) { room = null; emit('left'); } throw e; } // нет связи ни с одним брокером
  if (room !== r) { r.net.close(); return null; }
  const hello = () => ({ name: myName(), avatar: auth.profile?.avatar || '', joinedAt: r.joinedAt });
  // брокерам нужно время на подключение: присутствие и первые пинги — по готовности
  const greet = () => { r.net.setPresence(hello()); r.net.send('hb', hello()); pingBurst(); };
  r.timers.push(setTimeout(greet, 1200), setTimeout(greet, 4000));
  if (!creator) r.timers.push(setTimeout(() => { if (room === r && !r.synced) { r.synced = true; flushPending(); } }, T('synced')));
  // вошли, а никого нет: неверный код или друг ещё не зашёл — комната при этом остаётся, можно ждать
  if (!creator) r.timers.push(setTimeout(() => { if (room === r && !r.members.size) info(r.state && r.state.content ? 'В комнате сейчас никого — серия на паузе, пока кто-нибудь не зайдёт' : 'В комнате пока никого — проверьте код или подождите друга'); }, T('empty')));
  r.timers.push(setInterval(() => { r.net.send('hb', hello()); pruneMembers(); }, T('hb')));
  r.timers.push(setInterval(() => r.net.send('ping', { t0: Date.now() }), T('ping')));
  r.timers.push(setInterval(leaderDuties, 500));
  r.timers.push(setInterval(() => syncPlayer(false), 1000));
  // пропуск опенинга/эндинга — настройка комнаты; поначалу — как в личных настройках создателя
  const skip = { opening: prefs.get('SKIP_OPENING') === 'auto', ending: prefs.get('SKIP_ENDING') === 'auto', filler: !!prefs.get('SKIP_FILLERS') };
  if (creator) r.state = { seq: 0, cmd: '', content: null, paused: true, pos: 0, at: Date.now(), from: peerId, rate: 1, wait: null, ctrl: 'all', host: peerId, queue: [], gone: [], skip };
  emit('joined');
  return r;
}

// Закрыли приложение (или вкладку), не выйдя из комнаты: рвём соединения с брокерами без «до свидания» — брокер сразу
// публикует «последнюю волю», и остальные видят уход через секунды, а не через ~30 с ожидания сердцебиения
addEventListener('pagehide', () => { if (room && room.net) room.net.drop(); });

async function leave() {
  const r = room; if (!r) return;
  // уходит хост — сразу отдаёт права самому давнему из остальных
  if (r.state && r.state.host === r.peerId && r.members.size) {
    const next = [...r.members].reduce((a, b) => (b[1].joinedAt < a[1].joinedAt ? b : a))[0];
    try { commit({ host: next }); } catch { /* связь уже закрыта */ }
  }
  room = null;
  for (const t of r.timers) { clearInterval(t); clearTimeout(t); }
  if (r.player) r.player.unbind();
  try { r.net && r.net.send('bye', {}); } catch { /* уже закрыто */ }
  setTimeout(() => r.net && r.net.close(), 200);
  emit('left');
}

// --- участники и часы ---
// retained — сохранённое присутствие: участник мог уйти, не попрощавшись; без сердцебиения он пропадёт через 12 с
// Участник, о котором пришло не представление (пинг, команда), — просим представиться сразу, а не ждать сердцебиения:
// иначе до 10 с он был бы «Участником». «X в комнате» показываем, когда имя известно.
function seenMember(id, d, retained = false) {
  if (id === room.peerId) return;
  const m = room.members.get(id);
  const fresh = !m;
  const lastSeen = retained ? Math.max(m?.lastSeen || 0, Date.now() - T('gone') + 12000) : Date.now();
  const named = !!(d?.name || m?.named);
  room.members.set(id, { name: d?.name || m?.name || 'Участник', named, avatar: d?.avatar ?? m?.avatar ?? '', joinedAt: d?.joinedAt || m?.joinedAt || Date.now(), lastSeen, announced: m?.announced });
  const now = room.members.get(id);
  if (!named && fresh) room.net.send('who', { to: id });
  if (named && !now.announced) {
    now.announced = true;
    if (!retained && Date.now() - room.joinedAt > 3000) say(id, 'Заходит в комнату');
  }
  if (fresh) pingBurst();
  if (fresh || (named && !m?.named)) emit('members');
}
const helloData = () => ({ name: myName(), avatar: auth.profile?.avatar || '', joinedAt: room.joinedAt });
let lastWho = 0;
function dropMember(id) {
  const m = room && room.members.get(id); if (!m) return;
  room.members.delete(id); room.clocks.delete(id);
  emit('notice', { from: id, who: m.name, avatar: m.avatar, text: 'Выходит из комнаты' });
  emit('members');
}
// «Последняя воля» пришла от брокера: соединение участника с ним оборвалось. От одного брокера — это может быть
// краткий обрыв у живого участника (у каждого три соединения): просим отозваться и считаем ушедшим, только если он
// промолчал T('confirmGone'). От двух и более сразу — приложение закрыли или пропал интернет: уход сразу.
function brokerGone(id, url) {
  const m = room && room.members.get(id); if (!m) return;
  const at = Date.now();
  if (!m.goneVia || at - m.goneVia.at > 3000) m.goneVia = { at, urls: new Set() };
  m.goneVia.urls.add(url);
  if (m.goneVia.urls.size >= 2) { dropMember(id); return; }
  room.net.send('who', { to: id });
  room.timers.push(setTimeout(() => { const x = room && room.members.get(id); if (x && x.lastSeen < at) dropMember(id); }, T('confirmGone')));
}
function pruneMembers() { for (const [id, m] of room.members) if (Date.now() - m.lastSeen > T('gone')) dropMember(id); }
function pingBurst() { for (let i = 0; i < 4; i++) room.timers.push(setTimeout(() => room && room.net.send('ping', { t0: Date.now() }), i * 700)); }
// часы участника → мои: берём замер с наименьшей задержкой из последних 8
function offsetOf(id) {
  if (!id || id === room.peerId) return 0;
  const s = room.clocks.get(id); if (!s || !s.length) return 0; // неизвестно (например, автор ушёл) — считаем часы верными
  return s.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
}
const toLocal = (t, from) => t - offsetOf(from);
export function present() { return [{ id: room.peerId, name: myName(), avatar: auth.profile?.avatar || '', joinedAt: room.joinedAt, me: true }, ...[...room.members].map(([id, m]) => ({ id, ...m }))]; }
const leaderId = () => present().reduce((a, b) => (b.joinedAt < a.joinedAt || (b.joinedAt === a.joinedAt && b.id < a.id) ? b : a)).id;
const nameOf = (id) => (id === room.peerId ? 'Вы' : room.members.get(id)?.name || 'Участник');

// --- сообщения ---
function onMessage(msg, { retained }) {
  if (!room) return;
  const { from, k, d } = msg;
  if (k === 'hello' || k === 'hb') { seenMember(from, d, retained); return; }
  if (k !== 'st' || !retained) { const m = room.members.get(from); if (m) m.lastSeen = Date.now(); else if (k !== 'bye') seenMember(from, null); }
  if (k === 'bye') { dropMember(from); return; }
  if (k === 'ping') { room.net.send('pong', { to: from, t0: d.t0, t1: Date.now() }); return; }
  if (k === 'who') { if (d.to === room.peerId && Date.now() - lastWho > 1500) { lastWho = Date.now(); room.net.send('hb', helloData()); } return; }
  if (k === 'pong' && d.to === room.peerId) {
    const t3 = Date.now(); const rtt = t3 - d.t0; const off = d.t1 - (d.t0 + t3) / 2;
    const s = room.clocks.get(from) || []; s.push({ off, rtt }); if (s.length > 8) s.shift(); room.clocks.set(from, s);
    return;
  }
  if (k === 'st') { receiveState(d); return; }
  if (k === 'ready') { const set = room.readies.get(d.wait) || new Set(); set.add(from); room.readies.set(d.wait, set); return; }
  if (k === 'chat') { pushChat({ from, name: nameOf(from), text: String(d.text || '').slice(0, 500), t: Date.now() }); }
}
function pushChat(m) {
  room.chat.push(m); if (room.chat.length > 5000) room.chat.shift(); // история целиком; окно чата — с прокруткой
  emit('chat', m);
}
export function sendChat(text) {
  text = String(text || '').trim().slice(0, 500); if (!text || !room) return;
  room.net.send('chat', { text });
  pushChat({ from: room.peerId, name: 'Вы', text, t: Date.now(), me: true });
}

// --- общее состояние ---
// новее: больший seq; при равном — тот же cmd (свежий отсчёт той же команды) или cmd больше (одновременные команды)
function compare(a, b) { if (!b) return 1; if (a.seq !== b.seq) return a.seq - b.seq; return a.cmd === b.cmd ? 0 : a.cmd > b.cmd ? 1 : -1; }
function receiveState(next) {
  if (!room.synced) { room.synced = true; room.timers.push(setTimeout(flushPending, 0)); }
  const cur = room.state; const c = compare(next, cur);
  if (c < 0) return;
  room.state = next;
  if (c === 0) return; // свежий отсчёт той же команды
  if (cur && cur.seq > 0) notice(cur, next);
  if (cur && cur.host !== next.host) emit('host', { host: next.host, by: next.from });
  emit('state');
  readdMine();
  applyToPlayer(cur);
}
function commit(patch) {
  const s = room.state || { seq: 0, ctrl: 'all', host: room.peerId, rate: 1 };
  // Команда без своей позиции (кто управляет, очередь, хост) ставит отсчёт на «сейчас» — значит, и позицию надо
  // перенести на «сейчас», иначе серия откатится к прошлому отсчёту (до 5 с назад)
  const pos = 'pos' in patch || !s.content ? {} : { pos: expected(s) };
  const next = { ...s, ...pos, why: null, ...patch, seq: s.seq + 1, cmd: randomId(4), from: room.peerId, at: patch.at || Date.now() };
  room.state = next;
  room.net.setState(next);
  emit('state');
  if (s.host !== next.host) emit('host', { host: next.host, by: room.peerId });
  return next;
}
export const canControl = () => { if (!room) return true; const s = room.state; return !s || s.ctrl !== 'host' || s.host === room.peerId || !present().some((p) => p.id === s.host); };
export const isHost = () => !!room && room.state?.host === room.peerId;
export function setControl(ctrl) { if (isHost()) commit({ ctrl }); }
// Пропуск опенинга и эндинга в комнате — общая настройка (меняет хост), а не личная у каждого: иначе личный автопропуск
// любого участника перематывал бы всех. Пропускает автоматически один плеер — хоста (нет хоста — ведущего); у
// остальных серия перематывается вслед, с уведомлением «Пропущен опенинг». Выключено — у всех кнопки «Пропустить».
export const roomSkip = (kind) => !!room?.state?.skip?.[kind];
export function setRoomSkip(kind, on) { if (isHost()) commit({ skip: { ...(room.state.skip || {}), [kind]: !!on } }); }
export function partySkipAuto(kind) {
  if (!room || !roomSkip(kind)) return false;
  const host = room.state.host;
  return host === room.peerId || (!room.members.has(host) && leaderId() === room.peerId);
}
// хост отдаёт права другому участнику
export function giveHost(id) { if (room && isHost() && room.members.has(id)) commit({ host: id }); }
export const memberName = (id) => nameOf(id);

// --- очередь «Дальше» ---
const queue = () => room.state?.queue || [];
const gone = (id) => [...(room.state?.gone || []), id].slice(-50);
export function queueAdd(content) {
  const item = { id: randomId(4), content, by: room.peerId, byName: myName() };
  room.myAdds.set(item.id, item);
  commit({ queue: [...queue(), item] });
}
export function queueRemove(id) {
  const it = queue().find((x) => x.id === id); if (!it || !(isHost() || it.by === room.peerId)) return;
  room.myAdds.delete(id);
  commit({ queue: queue().filter((x) => x.id !== id), gone: gone(id) });
}
export function queueMove(id, to) {
  if (!isHost()) return;
  const q = queue().slice(); const from = q.findIndex((x) => x.id === id); if (from < 0) return;
  const [it] = q.splice(from, 1); q.splice(Math.max(0, Math.min(q.length, to)), 0, it);
  commit({ queue: q });
}
export function queuePlay(id) {
  const it = queue().find((x) => x.id === id); if (!it) return;
  if (!canControl()) { info('Включает только хост'); return; }
  room.myAdds.delete(id);
  const prev = room.state;
  commit({ content: it.content, paused: true, pos: 0, wait: randomId(4), queue: queue().filter((x) => x.id !== id), gone: gone(id), why: 'queue' });
  applyToPlayer(prev); // своя команда: серию включаем и у себя
}
// серии кончились (последняя серия тайтла): включаем первое из очереди
export function partyEnded() {
  if (!room) return false;
  const first = queue()[0];
  if (first && canControl()) { queuePlay(first.id); return true; }
  info(first ? 'Серии закончились — следующее в очереди включит хост' : 'Серии закончились — предложите, что смотреть дальше');
  return false;
}
// моё предложение проиграло одновременной правке — добавляем снова (если его не включили и не удалили)
function readdMine() {
  const s = room.state;
  for (const [id, it] of room.myAdds) {
    if ((s.gone || []).includes(id)) room.myAdds.delete(id);
    else if (queue().some((x) => x.id === id)) { if (s.from !== room.peerId) room.myAdds.delete(id); }
    else room.timers.push(setTimeout(() => { if (room && room.myAdds.has(id) && !queue().some((x) => x.id === id)) commit({ queue: [...queue(), it] }); }, 300));
  }
}

// подпись к чужой команде: «Аня: пауза», «Аня: перемотка на 12:34», «Аня включает 5 серию»
// Уведомление о чужом действии: кто и что сделал (party/ui.js показывает карточкой с аватаром)
const say = (from, text) => emit('notice', { from, who: nameOf(from), text });
const fmtDelta = (sec) => { sec = Math.round(Math.abs(sec)); const m = Math.floor(sec / 60); const r = sec % 60; return m ? `${m} мин${r ? ` ${r} с` : ''}` : `${r} с`; };
function notice(prev, s) {
  if (s.from === room.peerId) return;
  const from = s.from; const c = s.content;
  const q0 = prev.queue || []; const q1 = s.queue || [];
  if (c && contentKey(prev.content) !== contentKey(c)) { // другая серия или аниме
    const same = prev.content && prev.content.releaseId === c.releaseId && prev.content.sourceId === c.sourceId;
    const fillers = /^fillers:(\d+)$/.exec(s.why || '');
    if (s.why === 'queue') say(from, `Из очереди: ${c.title} · ${c.epName}`);
    else if (fillers) say(from, `Следующая серия: ${c.epName} — пропущено ${fillersText(Number(fillers[1]))}`);
    else if (same) say(from, `${c.position > prev.content.position ? 'Следующая' : 'Предыдущая'} серия: ${c.epName}`);
    else say(from, `Включает: ${c.title} · ${c.epName}`);
    return;
  }
  if (prev.ctrl !== s.ctrl) { say(from, s.ctrl === 'host' ? 'Теперь управляет только хост' : 'Теперь управлять могут все'); return; }
  for (const k of ['opening', 'ending', 'filler']) {
    if (!!prev.skip?.[k] === !!s.skip?.[k]) continue;
    if (k === 'filler') say(from, s.skip[k] ? 'Филлеры теперь пропускаются' : 'Филлеры больше не пропускаются');
    else say(from, `${k === 'opening' ? 'Опенинг' : 'Эндинг'} ${s.skip[k] ? 'теперь пропускается сам' : 'больше не пропускается сам'}`);
    return;
  }
  if (q1.length > q0.length) { const it = q1[q1.length - 1]; say(it.by, `Предлагает: ${it.content.title} · ${it.content.epName}`); return; }
  if (q1.length < q0.length) {
    const gone = q0.find((x) => !q1.some((y) => y.id === x.id));
    if (gone) say(from, gone.by === room.peerId ? `Убрал(а) ваше предложение: ${gone.content.title}` : `Убрано из очереди: ${gone.content.title} · ${gone.content.epName}`);
    return;
  }
  if (q1.length && q0.map((x) => x.id).join() !== q1.map((x) => x.id).join()) { say(from, 'Порядок в очереди изменён'); return; }
  if (prev.paused !== s.paused && !s.wait) { say(from, s.paused ? 'Пауза' : 'Продолжение'); return; }
  // перемотка: где была бы серия к моменту команды без неё — и куда её поставили
  const was = prev.paused || prev.wait ? prev.pos : prev.pos + ((toLocal(s.at, s.from) - toLocal(prev.at, prev.from)) / 1000) * prev.rate;
  const delta = s.pos - was;
  if (s.why === 'skip-opening') say(from, 'Пропущен опенинг');
  else if (s.why === 'skip-ending') say(from, 'Пропущен эндинг');
  else if (Math.abs(delta) > 3) say(from, `Перемотка ${delta > 0 ? 'вперёд' : 'назад'} на ${fmtDelta(delta)} · ${fmtTime(s.pos)}`);
  else if (prev.rate !== s.rate) say(from, `Скорость ${String(s.rate).replace('.', ',')}x`);
}
// Причина следующей своей команды (пропуск опенинга/эндинга — player.js): уходит вместе с ней, чтобы у остальных было
// «Пропущен опенинг», а не просто «перемотка»
let nextWhy = null;
export function partyWhy(why) { nextWhy = { why, at: Date.now() }; }
const takeWhy = () => { const w = nextWhy && Date.now() - nextWhy.at < 3000 ? nextWhy.why : null; nextWhy = null; return w; };
// Отсчёт «мёртвый»: его автора нет в комнате и он старше 15 с (живая комната обновляет отсчёт каждые 5 с) — например,
// вошли по коду комнаты, из которой все ушли. Тогда серия стоит на последней известной позиции, а не «досчитывается»
// до сейчас (иначе плеер перемотал бы на часы вперёд).
const stale = (s) => s.from !== room.peerId && !room.members.has(s.from) && Date.now() - toLocal(s.at, s.from) > T('stale');
// где сейчас должна быть серия по общему состоянию
function expected(s) {
  if (s.paused || s.wait || stale(s)) return s.pos;
  return s.pos + ((Date.now() - toLocal(s.at, s.from)) / 1000) * s.rate;
}

// Ведущий: свежий отсчёт для опоздавших и тех, кто не знает часов автора; запуск после ожидания всех
let lastRef = 0;
function leaderDuties() {
  if (!room || !room.state || leaderId() !== room.peerId) return;
  if (!room.creator && Date.now() - room.joinedAt < T('joinQuiet')) return; // только вошли — ещё не знаем всех участников
  const s = room.state;
  if (stale(s) && !s.paused) { commit({ paused: true, pos: s.pos, wait: null }); return; } // мёртвый отсчёт — явная пауза
  // хост ушёл — через 15 с хостом становится ведущий (самый давний участник)
  if (s.host && s.host !== room.peerId && !room.members.has(s.host)) {
    if (!room.hostGoneAt) room.hostGoneAt = Date.now();
    else if (Date.now() - room.hostGoneAt > T('hostGone')) { room.hostGoneAt = 0; commit({ host: room.peerId }); return; }
  } else room.hostGoneAt = 0;
  if (s.wait) {
    const ready = room.readies.get(s.wait) || new Set();
    const all = present().every((p) => p.me ? room.player?.isReady() : ready.has(p.id));
    if (all || Date.now() - toLocal(s.at, s.from) > WAIT_MAX_MS) commit({ wait: null, paused: false, pos: s.pos, at: Date.now() + GO_DELAY_MS });
    return;
  }
  if (Date.now() - lastRef > T('ref') && s.content) { // и на паузе: сохранённое состояние у брокеров остаётся свежим
    lastRef = Date.now();
    const ref = { ...s, pos: expected(s), at: Date.now(), from: room.peerId };
    room.state = ref; room.net.setState(ref);
  }
}

// --- плеер ---
// Плеер (player.js) при открытии в комнате вызывает bindPlayer(ctl):
//   ctl = { video, content(): текущее содержимое или null, isLoading(), loadPosition(pos) → bool (та же озвучка), close(),
//           inPip(), nearPip(): в окне «Картинка в картинке» или только что из него вышли }
// и сообщает о загруженной серии — playerEpisode(content).
export function bindPlayer(ctl) {
  if (!room) return null;
  const v = ctl.video;
  let progSeek = null; let rateSet = v.playbackRate; let cooldown = 0; let nudgeTimer = 0; let playTimer = 0;
  let lead = 0.3; let seekAt = 0; let warmUntil = 0; // упреждение перемотки, с; когда перемотали; «прогрев» после пуска
  let selfPause = 0; // когда плеер сам встал на паузу (ждёт назначенного пуска) — это не действие человека
  const quietPause = () => { if (!v.paused) { selfPause = Date.now(); v.pause(); } };
  const p = {
    ctl,
    isReady: () => !ctl.isLoading() && v.readyState >= 3,
    unbind() { for (const [e, f] of evs) v.removeEventListener(e, f); clearTimeout(nudgeTimer); clearTimeout(playTimer); clearTimeout(pipTimer); if (room && room.player === p) room.player = null; },
    seek(t) { progSeek = t; v.currentTime = t; cooldown = Date.now() + COOLDOWN_MS; seekAt = Date.now(); },
    // перемотка на ходу: туда, где серия будет, когда догрузится
    seekLive(s) { p.seek(expected(s) + lead * s.rate); },
    rate(r) { rateSet = r; if (v.playbackRate !== r) v.playbackRate = r; },
    // Пуск в назначенный момент. До 150 мс — это «сейчас» (погрешность оценки часов): без паузы на ожидание
    playAt(when) {
      clearTimeout(playTimer);
      const wait = when - Date.now();
      if (wait > 150) { quietPause(); playTimer = setTimeout(() => v.play().catch(() => {}), wait); } else if (v.paused) v.play().catch(() => {});
    },
  };
  // действия пользователя → команда комнате; события, совпадающие с общим состоянием, — наши же, их пропускаем
  const userAct = (fn) => () => {
    const s = room && room.state;
    if (!s || !s.content || ctl.isLoading() || contentKey(ctl.content()) !== contentKey(s.content)) return;
    fn(s);
  };
  // Событие плеера расходится с общим состоянием — значит, это сделал сам человек: команда комнате, а если управлять
  // ему нельзя — откат и подсказка. События, которые вызвала сама комната (пауза хоста, подгонка), сюда не доходят.
  const act = (patch) => {
    if (!canControl()) { info('Управляет только хост'); syncPlayer(true); return; }
    commit({ ...patch, why: takeWhy() });
  };
  // Пауза рядом с окном «Картинка в картинке» (ctl.nearPip): ✕ этого окна ставит видео на паузу сам (браузер), плеер
  // её снимает — комнате она не нужна (у гостя ещё и «Управляет только хост»). Ждём: окно закрылось — пропускаем,
  // осталось открытым — это пауза кнопкой в окне PiP, отправляем
  let pipTimer = 0;
  const pauseCmd = userAct((s) => { if (!s.paused && !v.ended && !s.wait && Date.now() - selfPause > 500) act({ paused: true, pos: v.currentTime }); });
  const evs = [
    ['play', userAct((s) => { if (s.paused || s.wait) act({ paused: false, wait: null, pos: v.currentTime }); })],
    ['pause', () => {
      clearTimeout(pipTimer);
      if (!ctl.nearPip?.()) { pauseCmd(); return; }
      pipTimer = setTimeout(() => { if (ctl.inPip?.() && v.paused) pauseCmd(); }, 400);
    }],
    ['seeked', userAct((s) => {
      if (progSeek != null && Math.abs(v.currentTime - progSeek) < 0.6) { progSeek = null; return; }
      if (Math.abs(v.currentTime - expected(s)) > 1) act({ pos: v.currentTime });
    })],
    ['ratechange', userAct((s) => { if (Math.abs(v.playbackRate - rateSet) > 0.001 && v.playbackRate !== s.rate) { rateSet = v.playbackRate; act({ rate: v.playbackRate, pos: v.currentTime }); } })],
    ['canplay', () => { const s = room && room.state; if (s && s.wait && p.isReady()) room.net.send('ready', { wait: s.wait }); }],
    // догрузка после нашей перемотки закончилась — запоминаем, сколько она длилась
    ['playing', () => { if (seekAt && Date.now() - seekAt < 5000) lead = Math.min(1.5, lead * 0.5 + ((Date.now() - seekAt) / 1000) * 0.5); seekAt = 0; }],
  ];
  for (const [e, f] of evs) v.addEventListener(e, f);
  p.sync = (hard) => {
    const s = room && room.state;
    if (!s || !s.content || ctl.isLoading() || contentKey(ctl.content()) !== contentKey(s.content)) return;
    if (s.paused || s.wait || stale(s)) {
      clearTimeout(playTimer);
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - s.pos) > 0.3) p.seek(s.pos);
      p.rate(s.rate);
      if (s.wait && p.isReady()) room.net.send('ready', { wait: s.wait });
      return;
    }
    const startLocal = toLocal(s.at, s.from);
    if (startLocal > Date.now()) { if (Math.abs(v.currentTime - s.pos) > 0.3) p.seek(s.pos); p.rate(s.rate); p.playAt(startLocal); warmUntil = startLocal + WARM_MS; return; }
    const d = expected(s) - v.currentTime;
    if (v.paused) { if (Math.abs(d) > 0.3) p.seekLive(s); p.rate(s.rate); v.play().catch(() => {}); warmUntil = Date.now() + WARM_MS; return; }
    if (v.seeking || v.readyState < 3 || (!hard && Date.now() < cooldown)) return;
    const warm = Date.now() < warmUntil;
    if (Math.abs(d) > SEEK_AT || ((hard || warm) && Math.abs(d) > (warm ? WARM_SEEK : 0.8))) { p.seekLive(s); p.rate(s.rate); return; }
    if (Math.abs(d) > DEAD) {
      p.rate(s.rate * (1 + Math.max(-NUDGE_MAX, Math.min(NUDGE_MAX, d * 0.5))));
      clearTimeout(nudgeTimer); nudgeTimer = setTimeout(() => p.rate(s.rate), 1000);
    } else p.rate(s.rate);
  };
  if (room.player) room.player.unbind();
  room.player = p;
  emit('player'); // открылся плеер комнаты — окно «Смотреть вместе» закрывается (party/ui.js)
  return p;
}
function syncPlayer(hard) { if (room && room.player && room.player.sync) room.player.sync(hard); }

// «3 филлера», «5 филлеров»
export function fillersText(n) {
  const a = n % 100; const b = n % 10;
  return `${n} ${a > 10 && a < 20 ? 'филлеров' : b === 1 ? 'филлер' : b > 1 && b < 5 ? 'филлера' : 'филлеров'}`;
}
// Плеер загрузил серию: своя смена серии → команда комнате (с ожиданием всех); пришедшая от комнаты — синхронизация.
// why — почему сменилась (остальным в уведомлении): 'fillers:N' — следующая серия через N пропущенных филлеров
// at — с какого места и на паузе ли: когда комнату создают из открытого плеера посреди серии.
// at.wait — серия с этого места, но с ожиданием всех (смена озвучки посреди серии, «Продолжить»)
export function playerEpisode(content, at = null, why = null) {
  if (!room || !room.player) return;
  if (!room.synced) { room.pending = { content, at }; return; }
  const s = room.state;
  if (s && contentKey(s.content) === contentKey(content)) { syncPlayer(true); return; }
  if (!canControl() && s && s.content) { info('Серию выбирает хост'); applyToPlayer(null); return; }
  if (at && at.wait) commit({ content, paused: true, pos: at.pos, wait: randomId(4), why });
  else if (at) commit({ content, paused: at.paused, pos: at.pos, wait: null, why });
  else if (s && s.content && s.content.releaseId === content.releaseId && s.content.position === content.position) {
    // та же серия в другой озвучке — с того же места, а не с начала (озвучка входит в ключ серии): один в комнате —
    // где остановился сам (сохранённое место прежней озвучки; закрытый плеер комнату не ставит на паузу, и её отсчёт
    // успевал уйти вперёд), с другими — где сейчас комната
    const alone = [...room.members.keys()].every((id) => id === room.peerId);
    const mine = db.getEpisode(s.content.releaseId, s.content.sourceId, s.content.position)?.playbackPosition;
    const pos = alone && mine > 0 ? mine / 1000 : expected(s);
    commit({ content, paused: true, pos, wait: randomId(4), why });
  } else commit({ content, paused: true, pos: 0, wait: randomId(4), why });
}
// вошли в комнату с открытым плеером: в пустой комнате показываем свою серию, иначе — переходим на серию комнаты
function flushPending() {
  const p = room && room.pending; if (!p) return;
  room.pending = null;
  if (room.state && room.state.content) applyToPlayer(null); else playerEpisode(p.content, p.at);
}

// Состояние изменилось: другая серия — открываем её (в открытом плеере или новом), иначе — подгоняем плеер
async function applyToPlayer(prev) {
  const s = room && room.state; if (!s || !s.content) return;
  const pl = room.player;
  if (pl && contentKey(pl.ctl.content()) === contentKey(s.content)) { syncPlayer(true); return; }
  if (prev && contentKey(prev.content) === contentKey(s.content) && !pl) return; // плеер закрыт пользователем — не навязываем
  if (pl && pl.ctl.loadPosition(s.content)) return; // та же озвучка — серия переключится в открытом плеере
  await openContent(s.content);
}
// Серия комнаты другой озвучки или другого аниме: открытый плеер переключится на неё сам (player.js, replace)
export async function openContent(c) {
  if (!c) return;
  try {
    const [rel, eps] = await Promise.all([A.release(c.releaseId, true), A.episodes(c.releaseId, c.typeId, c.sourceId, c.sort || 1)]);
    const release = rel.release || { id: c.releaseId, title_ru: c.title, image: c.image };
    const episodes = eps.episodes || [];
    const index = episodes.findIndex((e) => e.position === c.position);
    if (index < 0) { info('Эта серия у вас не открывается'); return; }
    const { openBuiltinPlayer } = await import('../player.js');
    openBuiltinPlayer({ release, episodes, index, sort: c.sort || 1, typeId: c.typeId, dub: c.dub, keepMini: true });
  } catch { info('Не удалось открыть серию комнаты'); }
}
