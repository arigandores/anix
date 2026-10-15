// Вкладка «AI»: помощник на Claude (ACP → claude-agent-acp, см. server/ai.js).
// Порядок: вход в Anixart → вход в Claude → чат. Без аккаунта приложения помощнику не с чем работать.
import { h, icon, iconButton, img, dialog, confirmDialog, timeAgo, skeletonSettled } from '../ui.js';
import { auth, A } from '../api.js';
import { registerScreen, navigate } from '../router.js';
import { openRelease, gradeText } from './common.js';
import { toolSpecs, runTool, describeTool, releaseCache } from '../ai-tools.js';
import { prefs } from '../store.js';

// Модель и effort из настроек (по умолчанию Sonnet 5.5 / medium); меняются в «Настройки → AI-помощник»
export const AI_MODELS = [['sonnet', 'Sonnet 5.5', 'быстрая и экономная — по умолчанию'], ['opus', 'Opus 5.5', 'точнее, но медленнее и тратит больше лимитов'], ['haiku', 'Haiku 5.5', 'самая быстрая, для простых вопросов'], ['fable', 'Fable 5.1', 'самая мощная и самая затратная']];
export const AI_EFFORTS = [['low', 'Низкая'], ['medium', 'Средняя'], ['high', 'Высокая'], ['xhigh', 'Очень высокая'], ['max', 'Максимальная']];
const aiConfig = () => ({ model: prefs.get('AI_MODEL'), effort: prefs.get('AI_EFFORT') });
const configLabel = () => { const m = AI_MODELS.find((x) => x[0] === prefs.get('AI_MODEL')); const e = AI_EFFORTS.find((x) => x[0] === prefs.get('AI_EFFORT')); return [state.authLabel, m && m[1], e && `глубина: ${e[1].toLowerCase()}`].filter(Boolean).join(' · '); };

const post = async (p, body) => {
  const r = await fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.code = j.code; throw e; }
  return j;
};

// ---------- состояние чата и история бесед ----------
// Беседы хранятся по аккаунту: anixart.ai.chats.<profileId> = { current, chats: [{ id, sessionId, title, updated, messages }] }.
// sessionId — сессия агента: при возврате к беседе агент восстанавливает её контекст (session/load).
const MAX_CHATS = 30;
const state = {
  profileId: 0, chatId: null, sessionId: null, loadedHere: false, messages: [], running: false, authLabel: '', loadingReplay: false,
  listeners: new Set(),
};
const notify = (what) => state.listeners.forEach((fn) => fn(what));
const storeKey = () => `anixart.ai.chats.${state.profileId}`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
function readStore() {
  try {
    const s = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (s && Array.isArray(s.chats)) return s;
  } catch { /* ignore */ }
  return { current: null, chats: [] };
}
function writeStore(s) { try { localStorage.setItem(storeKey(), JSON.stringify(s)); } catch { /* ignore */ } }
const titleOf = (messages) => ((messages || []).find((m) => m.role === 'user')?.text || 'Новый чат').replace(/\s+/g, ' ').slice(0, 80);
// незавершённые инструменты из прошлого запуска — как прерванные
const sanitize = (messages) => (messages || []).map((m) => ({ ...m, blocks: m.blocks && m.blocks.map((b) => (b.kind === 'tool' && b.status !== 'completed' ? { ...b, status: 'failed' } : b)) }));

function save() {
  if (!state.messages.length) return; // пустую беседу в историю не кладём
  const s = readStore();
  let c = s.chats.find((x) => x.id === state.chatId);
  if (!c) { c = { id: state.chatId, title: titleOf(state.messages) }; s.chats.unshift(c); }
  Object.assign(c, { sessionId: state.sessionId, messages: state.messages.slice(-80), updated: Date.now() });
  s.chats.sort((a, b) => b.updated - a.updated);
  s.chats = s.chats.slice(0, MAX_CHATS);
  s.current = state.chatId;
  writeStore(s);
}
function stopRunning() { if (state.running && state.sessionId) post('/ai/cancel', { sessionId: state.sessionId }).catch(() => {}); state.running = false; }
function openChat(c) {
  stopRunning();
  Object.assign(state, { chatId: c.id, sessionId: c.sessionId || null, loadedHere: false, messages: sanitize(c.messages) });
  const s = readStore(); s.current = c.id; writeStore(s);
  notify('reset');
}
function newChat() {
  stopRunning();
  Object.assign(state, { chatId: uid(), sessionId: null, loadedHere: false, messages: [] });
  const s = readStore(); s.current = null; writeStore(s);
  notify('reset');
}
function deleteChat(id) {
  const s = readStore();
  s.chats = s.chats.filter((c) => c.id !== id);
  if (s.current === id) s.current = null;
  writeStore(s);
  if (state.chatId === id) newChat();
}
function restore() {
  if (state.profileId === auth.profileId && state.chatId) return;
  stopRunning();
  state.profileId = auth.profileId;
  const s = readStore();
  const c = s.chats.find((x) => x.id === s.current);
  if (c) Object.assign(state, { chatId: c.id, sessionId: c.sessionId || null, loadedHere: false, messages: sanitize(c.messages) });
  else Object.assign(state, { chatId: uid(), sessionId: null, loadedHere: false, messages: [] });
}
const lastAssistant = () => { const m = state.messages[state.messages.length - 1]; return m && m.role === 'assistant' ? m : null; };

// ---------- окна «История» и «Память» ----------
function historyDialog() {
  const box = h('div', { class: 'sheet-list ai-history' });
  const d = dialog({ title: 'История бесед', content: box, cls: 'sheet' });
  const paint = () => {
    const chats = readStore().chats;
    box.replaceChildren();
    box.append(h('button', { class: 'sheet-item', onclick: () => { d.close(); newChat(); } }, icon('ic_plus'), h('span', null, 'Новый чат')));
    if (!chats.length) box.append(h('div', { class: 'muted', style: { padding: '10px 24px 14px' } }, 'Сохранённых бесед пока нет'));
    for (const c of chats) {
      const cur = c.id === state.chatId;
      box.append(h('div', { class: `sheet-item ai-hist-row ${cur ? 'checked' : ''}`, onclick: () => { d.close(); if (!cur) openChat(c); } },
        icon('ic_message'),
        h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, c.title || 'Без названия'), h('div', { class: 'muted', style: { fontSize: '12px' } }, timeAgo(Math.floor((c.updated || 0) / 1000)))),
        iconButton('ic_trash_outline', 'Удалить беседу', (e) => { e.stopPropagation(); deleteChat(c.id); paint(); }, 'sm')));
    }
  };
  paint();
}

async function memoryDialog() {
  const box = h('div', { class: 'ai-memory' }, h('div', { class: 'muted load-reveal' }, 'Загрузка…'));
  const d = dialog({
    title: 'Память помощника', content: box, cls: 'wide',
    actions: [{ label: 'Очистить всё', onClick: async () => { if (!(await confirmDialog('Очистить память', 'Помощник забудет всё, что запомнил о вас. Продолжить?', 'Очистить'))) return true; paint(await post('/ai/memory', { profileId: state.profileId, op: 'clear' })); return true; } },
      { label: 'Закрыть', primary: true }],
  });
  const paint = (m) => {
    box.replaceChildren(h('p', null, 'То, что помощник запомнил о ваших вкусах в прошлых беседах. Он учитывает это в советах и сам поддерживает память компактной.'));
    if (!m.entries.length) box.append(h('div', { class: 'muted', style: { padding: '8px 0' } }, 'Пока пусто — расскажите помощнику, что вам нравится, или попросите что-нибудь запомнить.'));
    for (const [key, title] of Object.entries(m.sections)) {
      const list = m.entries.filter((e) => e.section === key);
      if (!list.length) continue;
      box.append(h('div', { class: 'ai-mem-title' }, title), ...list.map((e) => h('div', { class: 'ai-mem-row' },
        h('div', { class: 'grow' }, e.text, h('span', { class: 'muted3', style: { fontSize: '11px', marginLeft: '6px' } }, e.date)),
        iconButton('ic_close', 'Забыть', async () => paint(await post('/ai/memory', { profileId: state.profileId, op: 'delete', id: e.id })), 'sm'))));
    }
    box.append(h('div', { class: 'muted3', style: { fontSize: '12px', marginTop: '10px' } }, `Занято: ${m.usage}`));
  };
  try { paint(await post('/ai/memory', { profileId: state.profileId, op: 'list' })); } catch (e) { box.replaceChildren(h('div', { class: 'ai-error' }, e.message)); }
  return d;
}

// ---------- поток событий сервера ----------
let es = null;
function connect() {
  if (es) return;
  es = new EventSource('/ai/events');
  es.onmessage = (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === 'tool') return execTool(e);
    if (e.type === 'permission') return askPermission(e);
    if (e.type === 'auth' && e.authStatus) { state.authLabel = e.authStatus.label || ''; notify('auth'); return; }
    if (e.type === 'agent_exit') { state.loadedHere = false; if (state.running) { state.running = false; pushError('Помощник неожиданно остановился. Попробуйте ещё раз.'); } return; }
    if (e.sessionId && e.sessionId !== state.sessionId) return;
    if (e.type === 'update') return onUpdate(e.update);
    if (e.type === 'done') { state.running = false; finishTools(); save(); notify('done'); return; }
    if (e.type === 'error') { state.running = false; finishTools(); pushError(e.error, e.code); return; }
  };
}

async function execTool(e) {
  let body;
  try { body = { id: e.id, result: await runTool(e.name, e.args) }; } catch (err) { body = { id: e.id, error: err.message || String(err) }; }
  post('/ai/tool-result', body).catch(() => {});
}

function onUpdate(u) {
  if (state.loadingReplay) return; // повтор истории при восстановлении сессии — у нас она уже есть
  let m = lastAssistant();
  if (!m) { m = { role: 'assistant', blocks: [] }; state.messages.push(m); }
  const tail = m.blocks[m.blocks.length - 1];
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      if (u.content?.type !== 'text') return;
      if (tail && tail.kind === 'text') tail.text += u.content.text; else m.blocks.push({ kind: 'text', text: u.content.text });
      break;
    case 'agent_thought_chunk': m.thinking = true; break;
    case 'tool_call': {
      const name = u._meta?.claudeCode?.toolName || u.title;
      m.blocks.push({ kind: 'tool', id: u.toolCallId, name, args: u.rawInput || {}, status: u.status || 'pending' });
      break;
    }
    case 'tool_call_update': {
      const b = m.blocks.find((x) => x.kind === 'tool' && x.id === u.toolCallId);
      if (!b) return;
      if (u.rawInput && Object.keys(u.rawInput).length) b.args = u.rawInput;
      if (u.status) b.status = u.status;
      break;
    }
    default: return;
  }
  notify('update');
}
function finishTools(status = 'completed') { const m = lastAssistant(); if (m) m.blocks.forEach((b) => { if (b.kind === 'tool' && (b.status === 'pending' || b.status === 'in_progress')) b.status = status; }); }
// «Стоп»: чат сразу снова рабочий (не ждём ответа сервера — если ход уже закончился, сигнала «готово» не будет),
// незавершённые шаги — прерванные; агенту отправляется отмена, если он ещё отвечает.
function cancelTurn() {
  if (state.sessionId) post('/ai/cancel', { sessionId: state.sessionId }).catch(() => {});
  if (!state.running) return;
  state.running = false; finishTools('failed'); save(); notify('done');
}
function pushError(text, code) {
  const m = lastAssistant() || (state.messages.push({ role: 'assistant', blocks: [] }), lastAssistant());
  m.blocks.push({ kind: 'error', text: /auth/i.test(String(code)) || code === -32000 ? 'Нужно заново войти в Claude.' : String(text || 'Ошибка') });
  if (code === -32000) state.needLogin = true;
  save(); notify('error');
}

function askPermission(e) {
  const tc = e.toolCall || {};
  const name = tc._meta?.claudeCode?.toolName || tc.title;
  const allow = e.options.find((o) => o.kind === 'allow_once') || e.options.find((o) => o.kind.startsWith('allow'));
  const reject = e.options.find((o) => o.kind === 'reject_once') || e.options.find((o) => o.kind.startsWith('reject'));
  let answered = false;
  const answer = (opt) => { if (answered) return; answered = true; post('/ai/permission', { id: e.id, optionId: opt ? opt.optionId : null }).catch(() => {}); };
  dialog({
    title: 'Подтвердите действие',
    content: h('div', null, h('p', { style: { color: 'var(--text)', fontSize: '15px' } }, describeTool(name, tc.rawInput || {})), h('p', null, 'Помощник просит разрешения изменить ваши закладки или оценки.')),
    actions: [{ label: 'Отклонить', onClick: () => answer(reject) }, { label: 'Разрешить', primary: true, onClick: () => answer(allow) }],
    onClose: () => answer(reject),
  });
}

async function ensureSession() {
  const profile = auth.profile;
  const body = { profile, tools: toolSpecs(), ...aiConfig() };
  if (state.sessionId && state.loadedHere) return;
  if (state.sessionId) {
    state.loadingReplay = true;
    try { await post('/ai/load', { ...body, sessionId: state.sessionId }); state.loadedHere = true; return; } catch { /* создадим новую */ } finally { state.loadingReplay = false; }
  }
  const r = await post('/ai/session', body);
  state.sessionId = r.sessionId; state.loadedHere = true; save();
}

async function send(text) {
  text = text.trim();
  if (!text || state.running) return;
  state.messages.push({ role: 'user', text });
  state.messages.push({ role: 'assistant', blocks: [] });
  state.running = true; save(); notify('send');
  try {
    await ensureSession();
    await post('/ai/prompt', { sessionId: state.sessionId, text, ...aiConfig() });
  } catch (e) {
    state.running = false;
    if (e.message === 'session_lost') { state.loadedHere = false; state.sessionId = null; }
    pushError(e.message, e.code);
  }
}

// ---------- Markdown (минимальный и безопасный: только текстовые узлы и разрешённые теги) ----------
function inline(text, parent) {
  const re = /(\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*([^*\s][^*]*)\*)/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    // содержимое жирного, курсива и подписи ссылки разбирается тоже: «**Советую [Триган](anixart://…)**»
    if (m[2]) parent.append(inline(m[2], h('b')));
    else if (m[3]) parent.append(link(m[3], m[4]));
    else if (m[5]) parent.append(h('code', null, m[5]));
    else if (m[6]) parent.append(inline(m[6], h('i')));
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
  return parent;
}
function link(label, href) {
  const rel = /^anixart:\/\/release\/(\d+)/.exec(href);
  if (rel) return inline(label, h('a', { class: 'ai-rel-link', onclick: () => openRelease(releaseCache.get(Number(rel[1])) || { id: Number(rel[1]) }) }));
  if (/^https?:\/\//i.test(href)) return inline(label, h('a', { href, target: '_blank', rel: 'noopener noreferrer' }));
  return inline(label, h('span'));
}
function markdown(src) {
  const root = h('div', { class: 'ai-md' });
  let list = null;
  for (const raw of String(src).split('\n')) {
    const line = raw.trimEnd();
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line); const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line); const hd = /^(#{1,3})\s+(.*)$/.exec(line);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) { list = h(tag); root.append(list); }
      list.append(inline(ul ? ul[1] : ol[2], h('li')));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    if (hd) root.append(inline(hd[2], h('h4')));
    else root.append(inline(line, h('p')));
  }
  return root;
}

// Карточки релизов, на которые сослался помощник
function releaseCards(text) {
  const ids = [...new Set([...String(text).matchAll(/anixart:\/\/release\/(\d+)/g)].map((x) => Number(x[1])))];
  if (!ids.length) return null;
  const row = h('div', { class: 'hscroll ai-cards' });
  for (const id of ids.slice(0, 12)) {
    const card = h('div', { class: 'release-card ai-card', onclick: () => openRelease(releaseCache.get(id) || { id }) });
    const fill = (r) => card.replaceChildren(h('div', { class: 'poster' }, img(r.image)), h('div', { class: 't clamp2' }, r.title_ru || r.title || '—'),
      h('div', { class: 'meta' }, [r.year, r.vote_count > 50 ? `★ ${gradeText(r.grade)}` : ''].filter(Boolean).join(' • ')));
    const c = releaseCache.get(id);
    if (c && c.image) fill(c);
    else {
      card.append(h('div', { class: 'poster sk' }), h('div', { class: 'sk sk-line', style: { width: '80%' } }));
      A.release(id, false).then((r) => { if (r.release) { releaseCache.set(id, { ...(releaseCache.get(id) || {}), ...r.release }); fill(r.release); } else card.remove(); }).catch(() => card.remove());
    }
    row.append(card);
  }
  return row;
}

// Сообщение помощника обновляется на месте: при каждом куске ответа перерисовывается только изменившийся
// блок (последний абзац или статус инструмента) — без пересоздания пузыря и без анимации появления.
function paintTool(el, b) {
  const st = b.status === 'completed' ? 'done' : b.status === 'failed' ? 'failed' : 'run';
  const label = describeTool(b.name, b.args);
  if (el._st === st && el._label === label) return;
  el._st = st; el._label = label;
  el.className = `ai-tool ${st}`;
  el.replaceChildren(st === 'done' ? icon('ic_check', 'xs') : st === 'failed' ? icon('ic_close', 'xs') : h('span', { class: 'ai-spin' }), label);
}
function blockNode(b) {
  let el;
  if (b.kind === 'text') { el = markdown(b.text); el._text = b.text; } else if (b.kind === 'tool') { el = h('div'); paintTool(el, b); } else el = h('div', { class: 'ai-error' }, icon('ic_error', 'xs'), b.text);
  el.dataset.kind = b.kind;
  return el;
}
function syncBubble(bubble, m, live) {
  const kids = [...bubble.children].filter((k) => k.dataset.kind);
  const typing = bubble.querySelector('.ai-typing');
  m.blocks.forEach((b, i) => {
    const el = kids[i];
    if (!el || el.dataset.kind !== b.kind) {
      const n = blockNode(b);
      if (el) el.replaceWith(n); else bubble.insertBefore(n, typing);
      kids[i] = n;
    } else if (b.kind === 'text' && el._text !== b.text) {
      el._text = b.text; el.replaceChildren(...[...markdown(b.text).childNodes]);
    } else if (b.kind === 'tool') paintTool(el, b);
  });
  kids.slice(m.blocks.length).forEach((k) => k && k.remove());
  const needTyping = live && !m.blocks.some((b) => b.kind === 'text');
  if (needTyping && !typing) bubble.append(h('div', { class: 'ai-typing' }, h('span'), h('span'), h('span')));
  else if (!needTyping && typing) typing.remove();
}
function addCards(box, m) {
  if (box._cards) return;
  const cards = releaseCards(m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n'));
  if (cards) { box.append(cards); box._cards = cards; }
}
function renderMessage(m, live) {
  if (m.role === 'user') return h('div', { class: 'ai-msg user' }, h('div', { class: 'bubble selectable' }, m.text));
  const bubble = h('div', { class: 'bubble selectable' });
  const box = h('div', { class: 'ai-msg assistant' }, bubble);
  box._bubble = bubble;
  syncBubble(bubble, m, live);
  if (!live) addCards(box, m);
  return box;
}

// ---------- экраны-ступени ----------
function gate(ic, title, text, buttons) {
  return h('div', { class: 'empty ai-gate' }, h('div', { class: 'ai-gate-ic' }, icon(ic, 'big')), h('div', { class: 'empty-title', style: { fontSize: '22px' } }, title),
    h('div', { class: 'empty-sub', style: { maxWidth: '440px', whiteSpace: 'pre-line' } }, text), h('div', { class: 'col', style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '14px', alignItems: 'center' } }, buttons));
}
const toolbar = (actions = []) => h('div', { class: 'appbar' }, h('div', { class: 'title small' }, 'AI-помощник'), h('div', { class: 'actions' }, actions));

function claudeGate(onReady, info) {
  const status = h('div', { class: 'muted', style: { fontSize: '13px', minHeight: '18px' } }, info || '');
  let timer = null;
  const poll = (left) => {
    clearTimeout(timer);
    if (!status.isConnected && left < 60) return;
    timer = setTimeout(async () => {
      const st = await post('/ai/status').catch(() => null);
      if (st?.claude?.loggedIn) { onReady(); return; }
      if (left > 0) poll(left - 1); else status.textContent = 'Не дождались входа. Нажмите «Проверить» после входа в браузере.';
    }, 3000);
  };
  const start = (kind) => { post('/ai/login', { kind }).catch(() => {}); status.textContent = 'Откроется окно входа: завершите вход в браузере — приложение подхватит его само.'; poll(60); };
  return h('div', null, toolbar(), gate('ic_ai', 'Подключите Claude',
    'Помощник работает на Claude от Anthropic.\nВойдите в свой аккаунт Claude (подписка Pro или Max) — откроется окно входа.',
    [h('button', { class: 'btn btn-primary lg', onclick: () => start('claudeai') }, 'Войти в Claude'),
      h('button', { class: 'btn btn-text', onclick: () => start('console') }, 'Войти через Anthropic Console (оплата по API)'),
      h('button', { class: 'btn btn-tonal', onclick: async () => { status.textContent = 'Проверяем…'; const st = await post('/ai/status').catch(() => null); if (st?.claude?.loggedIn) onReady(); else status.textContent = 'Вход в Claude пока не выполнен.'; } }, 'Проверить'),
      status]));
}

const SUGGESTIONS = [
  'Что посмотреть сегодня вечером? Учитывай мою историю',
  'Подбери что-то похожее на последнее, что я смотрел',
  'Что из моего списка «В планах» стоит начать первым?',
  'Какие онгоинги сейчас самые обсуждаемые?',
  'Что нового выходит на этой неделе из моих списков?',
];

function chatView() {
  const list = h('div', { class: 'ai-list' });
  const scroller = h('div', { class: 'ai-scroll' }, list);
  const input = h('textarea', { class: 'input', rows: 1, placeholder: 'Спросите, что посмотреть…' });
  const sendBtn = h('button', { class: 'icon-btn ai-send', title: 'Отправить', 'aria-label': 'Отправить' }, icon('ic_send'));
  const stopBtn = h('button', { class: 'icon-btn ai-send', title: 'Остановить', 'aria-label': 'Остановить' }, icon('ic_close'));
  const sub = h('div', { class: 'muted ai-sub' }, configLabel());
  const view = h('div', { class: 'ai-chat' },
    h('div', { class: 'appbar' }, h('div', { class: 'grow' }, h('div', { class: 'title small' }, 'AI-помощник'), sub),
      h('div', { class: 'actions' }, iconButton('ic_history', 'История бесед', () => historyDialog()), iconButton('ic_checklist', 'Память помощника', () => memoryDialog()), iconButton('ic_plus', 'Новый чат', () => newChat()))),
    scroller,
    h('div', { class: 'comment-input ai-composer' }, input, sendBtn, stopBtn));
  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(160, input.scrollHeight + 2)}px`; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
  const go = () => { const v = input.value; if (!v.trim() || state.running) return; input.value = ''; autosize(); send(v); };
  sendBtn.onclick = go;
  stopBtn.onclick = cancelTurn;

  // Сообщения прокручиваются в своей области, поле ввода закреплено внизу.
  // Автопрокрутка вниз — только если пользователь и так внизу (не отмотал историю вверх).
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const scrollDown = () => { scroller.scrollTop = scroller.scrollHeight; };
  const els = [];
  const isLive = (i) => state.running && i === state.messages.length - 1 && state.messages[i].role === 'assistant';
  const hello = () => h('div', { class: 'ai-hello' }, h('div', { class: 'ai-gate-ic' }, icon('ic_ai', 'big')),
    h('div', { class: 'empty-title' }, `Привет${auth.profile?.login ? `, ${auth.profile.login}` : ''}!`),
    h('div', { class: 'muted' }, 'Я вижу ваши списки, историю и оценки в Anixart и помогу выбрать, что посмотреть. Могу сам менять закладки и оценки и собирать коллекции — просто попросите.'),
    h('div', { class: 'ai-suggest' }, SUGGESTIONS.map((s) => h('button', { class: 'chip', onclick: () => send(s) }, s))));
  const full = () => {
    list.replaceChildren(); els.length = 0;
    if (!state.messages.length) list.append(hello());
    state.messages.forEach((m, i) => { const el = renderMessage(m, isLive(i)); el.classList.add('static'); els[i] = el; list.append(el); });
    requestAnimationFrame(scrollDown);
  };
  const appendNew = () => {
    list.querySelector('.ai-hello')?.remove();
    for (let i = els.length; i < state.messages.length; i++) { els[i] = renderMessage(state.messages[i], isLive(i)); list.append(els[i]); }
  };
  const paint = (what) => {
    sendBtn.style.display = state.running ? 'none' : ''; stopBtn.style.display = state.running ? '' : 'none';
    sub.textContent = configLabel();
    if (what === 'reset') return full();
    if (what === 'auth') return;
    const stick = atBottom() || what === 'send';
    appendNew();
    const i = state.messages.length - 1; const m = state.messages[i];
    if (m && m.role === 'assistant' && els[i]?._bubble) {
      syncBubble(els[i]._bubble, m, isLive(i));
      if (!isLive(i)) addCards(els[i], m);
    }
    if (stick) requestAnimationFrame(scrollDown);
  };
  let raf = 0;
  // Отрисовка идёт и когда чат не на экране (помощник открыл релиз или пользователь ушёл на другую вкладку):
  // иначе ответ доходит до конца, а после возврата экран остаётся в состоянии «ждёт». Не рисует только закрытый чат.
  let disposed = false;
  const onState = (what) => { if (disposed) return; if (what === 'update') { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => paint('update')); } else { cancelAnimationFrame(raf); paint(what); } };
  state.listeners.add(onState);
  paint('reset');
  setTimeout(() => input.focus(), 50);
  // Экран снимается со страницы при переходе (например, на релиз из ответа), и браузер обнуляет прокрутку
  // внутренней области. Запоминаем позицию и восстанавливаем при возврате; если были внизу — снова в конец.
  let saved = { top: 0, bottom: true };
  scroller.addEventListener('scroll', () => { if (scroller.isConnected && scroller.clientHeight) saved = { top: scroller.scrollTop, bottom: atBottom() }; }, { passive: true });
  const restore = () => { if (saved.bottom) scrollDown(); else scroller.scrollTop = saved.top; };
  view.restoreScroll = () => { restore(); requestAnimationFrame(restore); };
  // карточки релизов и картинки догружаются и растят ленту — если пользователь внизу, держим низ
  new ResizeObserver(() => { if (scroller.isConnected && saved.bottom) scrollDown(); }).observe(list);
  list.addEventListener('load', () => { if (scroller.isConnected && saved.bottom) scrollDown(); }, true); // постеры карточек
  view.dispose = () => { disposed = true; state.listeners.delete(onState); };
  return view;
}

registerScreen('tab:ai', (_p, ctx) => {
  const root = h('div', { class: 'ai-root' });
  let chat = null;
  let seq = 0;
  // quiet — при возврате на вкладку: прежний экран остаётся, пока не придёт ответ /ai/status
  const show = async ({ quiet = false } = {}) => {
    const my = ++seq;
    chat?.dispose?.(); chat = null;
    if (!auth.loggedIn) {
      root.replaceChildren(toolbar(), gate('ic_ai', 'Сначала войдите в Anixart',
        'Помощник подбирает аниме по вашим спискам, истории просмотров и оценкам и может менять закладки — для этого нужен аккаунт Anixart.',
        [h('button', { class: 'btn btn-primary lg', onclick: () => navigate('auth') }, 'Войти в Anixart')]));
      return;
    }
    if (!quiet) root.replaceChildren(toolbar(), h('div', { class: 'empty load-reveal' }, h('div', { class: 'ai-typing' }, h('span'), h('span'), h('span')), h('div', { class: 'muted' }, 'Проверяем подключение к Claude…')));
    const st = await post('/ai/status').catch((e) => ({ error: e.message }));
    await skeletonSettled(root);
    if (my !== seq) return;
    if (st.error || !st.available) {
      root.replaceChildren(toolbar(), gate('ic_error', 'Помощник недоступен', st.error ? `Не удалось связаться с сервером приложения: ${st.error}` : 'В этой сборке нет компонентов Claude.', [h('button', { class: 'btn btn-tonal', onclick: show }, 'Повторить')]));
      return;
    }
    if (!st.claude?.loggedIn) { root.replaceChildren(claudeGate(show)); return; }
    state.authLabel = st.authStatus?.label || (st.claude.subscriptionType ? `Claude ${st.claude.subscriptionType[0].toUpperCase()}${st.claude.subscriptionType.slice(1)}` : '');
    restore(); connect();
    chat = chatView();
    root.replaceChildren(chat);
  };
  show();
  ctx.setOnShow(({ returning }) => {
    if (!returning) return;
    if (!chat) show({ quiet: true }); else if (state.needLogin) { state.needLogin = false; show(); } else chat.restoreScroll?.();
  });
  ctx.setDispose(() => chat?.dispose?.());
  return root;
});

window.addEventListener('auth-changed', () => { stopRunning(); state.profileId = -1; state.chatId = null; });
