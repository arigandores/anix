'use strict';
// Вкладка «AI»: чат с Claude через Agent Client Protocol (адаптер @agentclientprotocol/claude-agent-acp).
//
//  фронтенд ── /ai/* (POST) + /ai/events (SSE) ──► этот модуль ── ACP по stdio ──► claude-agent-acp ──► claude.exe
//  claude.exe ── MCP (HTTP) ──► /mcp/<ключ> ── ретрансляция через SSE ──► фронтенд выполняет инструмент (js/ai-tools.js)
//
// Инструменты Anixart выполняются во фронтенде: там есть токен, готовые вызовы API, локальная история серий
// и навигация. Сервер только передаёт вызовы и ответы. Встроенные инструменты Claude Code отключены, кроме
// поиска в интернете; настройки пользователя из ~/.claude не подключаются (settingSources: []).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable, Writable } = require('stream');
const memory = require('./ai-memory');

// В собранном приложении пакеты лежат в app.asar.unpacked (asarUnpack): бинарник нельзя запустить из архива
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const NM = unpacked(path.join(__dirname, '..', 'node_modules'));
const ACP_ENTRY = path.join(NM, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js');
// Нативный Claude Code из платформенного пакета SDK: npm кладёт его рядом, electron-builder — внутрь claude-agent-sdk
const CLAUDE_PKG = path.join('@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
const CLAUDE_EXE = [path.join(NM, CLAUDE_PKG), path.join(NM, '@anthropic-ai', 'claude-agent-sdk', 'node_modules', CLAUDE_PKG)].find((p) => fs.existsSync(p)) || '';
const WORK_DIR = path.join(os.homedir(), '.anixart-desktop', 'ai'); // пустая рабочая папка агента
memory.init(WORK_DIR);

let acp = null; // ESM-модуль SDK (динамический import из CommonJS)
let proc = null; let conn = null; let initResult = null; let starting = null;
let authStatus = null; // из уведомления _auth/status_update
const clients = new Set(); // открытые SSE-потоки
const pendingPermissions = new Map(); // id → resolve
const pendingTools = new Map(); // id → { resolve, timer }
const sessions = new Map(); // sessionId → { mcpKey }
const mcpKeys = new Map(); // ключ MCP-эндпоинта → { tools }
let serverPort = 0;
let log = [];

function emit(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}
function note(line) { log.push(`${new Date().toISOString()} ${line}`); if (log.length > 300) log = log.slice(-300); }

function agentEnv() {
  // Electron как Node: без него для запуска адаптера понадобился бы установленный Node.js
  return { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_ENTRYPOINT: 'anix-desktop' };
}

async function ensureAgent() {
  if (conn && proc && proc.exitCode === null) return;
  if (starting) return starting;
  starting = (async () => {
    // /unstable — полный ACP v1, как в SDK 1.x: адаптер присылает и нестабильные обновления сессии
    acp = acp || await import('@agentclientprotocol/sdk/unstable');
    fs.mkdirSync(WORK_DIR, { recursive: true });
    proc = spawn(process.execPath, [ACP_ENTRY], { cwd: WORK_DIR, env: agentEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc.stderr.on('data', (d) => note(`[agent] ${String(d).trim().slice(0, 500)}`));
    proc.on('exit', (code) => {
      note(`agent exited ${code}`);
      conn = null; proc = null; initResult = null;
      for (const [, p] of pendingPermissions) p({ outcome: { outcome: 'cancelled' } });
      pendingPermissions.clear();
      emit({ type: 'agent_exit', code });
    });
    const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
    const M = acp.methods;
    // файловая система и терминал клиенту не нужны — агент работает только через инструменты Anixart
    // (их обработчиков нет: агент получит Method Not Found)
    const { agent, close } = acp.client()
      .onNotification(M.client.session.update, ({ params }) => emit({ type: 'update', sessionId: params.sessionId, update: params.update }))
      .onRequest(M.client.session.requestPermission, ({ params }) => new Promise((resolve) => {
        const id = crypto.randomUUID();
        pendingPermissions.set(id, resolve);
        emit({ type: 'permission', id, sessionId: params.sessionId, toolCall: params.toolCall, options: params.options });
      }))
      .onNotification('*', ({ method, params }) => {
        if (method === '_auth/status_update' && params && params.authStatus) { authStatus = params.authStatus; emit({ type: 'auth', authStatus }); }
      })
      .onRequest('*', () => ({}))
      .connect(stream);
    proc.on('exit', () => close());
    // прежние имена вызовов поверх запросов SDK
    conn = {
      initialize: (p) => agent.request(M.agent.initialize, p),
      newSession: (p) => agent.request(M.agent.session.new, p),
      loadSession: (p) => agent.request(M.agent.session.load, p),
      setSessionMode: (p) => agent.request(M.agent.session.setMode, p),
      setSessionConfigOption: (p) => agent.request(M.agent.session.setConfigOption, p),
      prompt: (p) => agent.request(M.agent.session.prompt, p),
      cancel: (p) => agent.notify(M.agent.session.cancel, p),
    };
    initResult = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'anix-desktop', version: require('../package.json').version },
    });
    note(`initialized: ${JSON.stringify(initResult.agentCapabilities || {}).slice(0, 300)}`);
  })();
  try { await starting; } finally { starting = null; }
}

// Системный промпт: роль советника + данные аккаунта (подробности агент берёт инструментами)
function systemPrompt(profile) {
  const who = profile && profile.login
    ? `Пользователь вошёл в Anixart как «${profile.login}» (id ${profile.id}). Его списки, историю, оценки и статистику получай инструментами.`
    : 'Пользователь не вошёл в аккаунт Anixart: личные списки, история и действия со списками недоступны, остальное — работает.';
  return [
    'Ты — встроенный помощник приложения Anix — неофициального клиента Anixart для ПК (каталог аниме с онлайн-просмотром). Отвечай по-русски, дружелюбно и по делу.',
    'Помогаешь выбрать, что посмотреть: учитывай историю просмотров, списки («Смотрю», «В планах», «Просмотрено», «Отложено», «Брошено»), избранное и оценки пользователя, жанры, год, статус выхода, число серий.',
    who,
    'Инструменты mcp__anixart__* — это данные и действия приложения. Факты о релизах (названия, год, серии, рейтинг, жанры) бери только из них, ничего не выдумывай. Интернет (WebSearch/WebFetch) — для новостей, анонсов, отзывов и того, чего нет в каталоге.',
    'Когда упоминаешь релиз из каталога, давай ссылку в формате [Название](anixart://release/ID) — приложение покажет карточку с постером, по клику релиз откроется. Предлагай по 3–7 вариантов с короткой причиной, почему подходит.',
    'Действия — статус в закладках, избранное, оценка, коллекции (создать, переименовать, добавить или убрать релизы, удалить) — выполняй сразу, как только пользователь просит, без переспрашивания и без подтверждений. Сам, без просьбы, ничего не меняй. Удаляй коллекцию только по явной просьбе. После действия коротко скажи, что сделано. Открыть релиз, серии или коллекцию на экране — open_release / open_episodes / open_collection.',
    'Форматирование: короткие абзацы, списки, **жирный** для названий. Без таблиц и без заголовков крупнее ###.',
    [
      'Память (memories.md) — то, что ты сам запомнил о пользователе в прошлых беседах. Учитывай её в советах. Ведёшь её инструментами remember / update_memory / forget (без подтверждения, пользователю видно в разделе «Память»).',
      'Запоминай только устойчивое и полезное надолго: любимые и нелюбимые жанры, темы, студии, тон историй; формат (озвучка или субтитры, длина серий, сериалы или фильмы); явные просьбы «запомни». Одна короткая мысль на запись, по-русски.',
      'Не запоминай то, что и так есть в инструментах (списки, история, оценки), разовые настроения и сам факт разговора. Перед remember проверь память ниже: похожее — уточни через update_memory. Если память близка к лимиту — объединяй записи и удаляй устаревшие.',
      'Не сообщай пользователю о каждом сохранении отдельной фразой — достаточно отметки в чате.',
      `Текущая память:\n<memory>\n${memory.promptBlock(profile && profile.id)}\n</memory>`,
    ].join('\n'),
  ].join('\n\n');
}

// Список инструментов задаёт фронтенд (там же их реализация); read-only отмечены readOnly
function sessionParams({ profile, tools }) {
  const mcpKey = crypto.randomBytes(16).toString('hex');
  const all = [...(tools || []), ...memory.TOOLS];
  mcpKeys.set(mcpKey, { tools: all, profileId: profile && profile.id });
  // все инструменты приложения — без подтверждения: просьба пользователя и есть разрешение
  const allowed = all.map((t) => `mcp__anixart__${t.name}`);
  const params = {
    cwd: WORK_DIR,
    mcpServers: [{ type: 'http', name: 'anixart', url: `http://127.0.0.1:${serverPort}/mcp/${mcpKey}`, headers: [] }],
    _meta: {
      systemPrompt: systemPrompt(profile),
      claudeCode: {
        options: {
          tools: ['WebSearch', 'WebFetch'], // из встроенных — только интернет
          allowedTools: ['WebSearch', 'WebFetch', ...allowed],
          disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Task', 'Agent', 'TodoWrite', 'Skill'],
          settingSources: [], // не подтягивать ~/.claude (CLAUDE.md, хуки, MCP, разрешения пользователя)
          allowDangerouslySkipPermissions: false, // вне списка allowedTools (на всякий случай) — спросит
          strictMcpConfig: true,
          pathToClaudeCodeExecutable: CLAUDE_EXE || undefined,
        },
      },
    },
  };
  return { params, mcpKey };
}

// Ручной режим: инструменты Anixart и поиск разрешены списком allowedTools, всё прочее (если агент
// попробует) — через диалог подтверждения. Режим «auto» адаптера одобрял бы любые действия сам.
// Модель и effort из настроек приложения (по умолчанию Sonnet 5.5 / medium) — session/set_config_option.
// Применяются при создании/восстановлении сессии и перед запросом, если пользователь поменял их в настройках.
const MODELS = ['sonnet', 'opus', 'haiku', 'fable'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
async function applyConfig(sessionId, { model, effort } = {}) {
  const sess = sessions.get(sessionId);
  if (!sess) return;
  const want = { model: MODELS.includes(model) ? model : 'sonnet', effort: EFFORTS.includes(effort) ? effort : 'medium' };
  for (const key of ['model', 'effort']) {
    if (sess[key] === want[key]) continue;
    try { await conn.setSessionConfigOption({ sessionId, configId: key, value: want[key] }); sess[key] = want[key]; note(`config ${key}=${want[key]}`); } catch (e) { note(`set ${key}: ${errText(e)}`); }
  }
}

const setManualMode = (sessionId) => conn.setSessionMode({ sessionId, modeId: 'default' }).catch((e) => note(`setSessionMode: ${errText(e)}`));

async function newSession(body) {
  await ensureAgent();
  const { params, mcpKey } = sessionParams(body);
  const r = await conn.newSession(params);
  sessions.set(r.sessionId, { mcpKey });
  await setManualMode(r.sessionId);
  await applyConfig(r.sessionId, body);
  return { sessionId: r.sessionId };
}

// Продолжить беседу после перезапуска приложения (история сообщений хранится во фронтенде;
// повтор истории, который присылает агент, фронтенд пропускает)
async function loadSession(body) {
  await ensureAgent();
  if (!initResult?.agentCapabilities?.loadSession) throw new Error('load not supported');
  const { params, mcpKey } = sessionParams(body);
  await conn.loadSession({ ...params, sessionId: body.sessionId });
  sessions.set(body.sessionId, { mcpKey });
  await setManualMode(body.sessionId);
  await applyConfig(body.sessionId, body);
  return { sessionId: body.sessionId };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const errText = (e) => (e && (e.message || (e.data && e.data.message))) || String(e);

// Вход в Claude: окно консоли с `claude auth login` (OAuth в браузере); логин общий с Claude Code
function login(kind) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const exe = CLAUDE_EXE || 'claude';
  const flag = kind === 'console' ? '--console' : '--claudeai';
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '"Вход в Claude"', 'cmd', '/k', `"${exe}" auth login ${flag}`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, cwd: WORK_DIR }).unref();
  } else {
    spawn(exe, ['auth', 'login', flag], { detached: true, stdio: 'ignore' }).unref();
  }
}

// Статус входа без запуска сессии: `claude auth status --json`
function probeAuth() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  return new Promise((resolve) => {
    const exe = CLAUDE_EXE || 'claude';
    let out = '';
    let p;
    try { p = spawn(exe, ['auth', 'status', '--json'], { cwd: WORK_DIR, windowsHide: true }); } catch { return resolve(null); }
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(null); }, 8000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('exit', () => { clearTimeout(timer); try { resolve(JSON.parse(out)); } catch { resolve(null); } });
  });
}

async function handleAi(req, res, url) {
  const p = url.pathname;
  if (p === '/ai/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello', authStatus })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (p === '/ai/log') return json(res, 200, log);
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const body = await readJson(req).catch(() => ({}));
  try {
    switch (p) {
      case '/ai/status': {
        const st = await probeAuth();
        return json(res, 200, { available: fs.existsSync(ACP_ENTRY), claude: st, authStatus });
      }
      case '/ai/login': login(body.kind); return json(res, 200, { ok: true });
      case '/ai/memory': {
        const pid = body.profileId;
        if (body.op === 'delete') return json(res, 200, memory.remove(pid, body.id));
        if (body.op === 'clear') return json(res, 200, memory.clear(pid));
        return json(res, 200, memory.list(pid));
      }
      case '/ai/session': return json(res, 200, await newSession(body));
      case '/ai/load': return json(res, 200, await loadSession(body));
      case '/ai/prompt': {
        await ensureAgent();
        if (!sessions.has(body.sessionId)) return json(res, 409, { error: 'session_lost' });
        await applyConfig(body.sessionId, body);
        json(res, 200, { ok: true }); // ответ приходит потоком событий
        conn.prompt({ sessionId: body.sessionId, prompt: [{ type: 'text', text: String(body.text || '') }] })
          .then((r) => emit({ type: 'done', sessionId: body.sessionId, stopReason: r.stopReason }))
          .catch((e) => emit({ type: 'error', sessionId: body.sessionId, error: errText(e), code: e && e.code }));
        return;
      }
      case '/ai/cancel': if (conn) await conn.cancel({ sessionId: body.sessionId }); return json(res, 200, { ok: true });
      case '/ai/permission': {
        const resolve = pendingPermissions.get(body.id);
        pendingPermissions.delete(body.id);
        if (resolve) resolve(body.optionId ? { outcome: { outcome: 'selected', optionId: body.optionId } } : { outcome: { outcome: 'cancelled' } });
        return json(res, 200, { ok: !!resolve });
      }
      case '/ai/tool-result': {
        const t = pendingTools.get(body.id);
        pendingTools.delete(body.id);
        if (t) { clearTimeout(t.timer); t.resolve(body); }
        return json(res, 200, { ok: !!t });
      }
      default: return json(res, 404, { error: 'unknown' });
    }
  } catch (e) {
    note(`error ${p}: ${errText(e)}`);
    return json(res, 500, { error: errText(e), code: e && e.code });
  }
}

// ---- MCP (Streamable HTTP, ответы JSON): tools/list и tools/call ретранслируются во фронтенд ----
function callTool(name, args) {
  return new Promise((resolve) => {
    if (!clients.size) return resolve({ error: 'Приложение закрыто' });
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pendingTools.delete(id); resolve({ error: 'Истекло время выполнения инструмента' }); }, 60000);
    pendingTools.set(id, { resolve, timer });
    emit({ type: 'tool', id, name, args });
  });
}

async function handleMcp(req, res, url) {
  const key = url.pathname.split('/')[2];
  const entry = mcpKeys.get(key);
  if (!entry) return json(res, 404, { error: 'unknown mcp endpoint' });
  if (req.method === 'GET') { res.writeHead(405); return res.end(); } // без серверного SSE-потока
  if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
  const msg = await readJson(req).catch(() => null);
  if (!msg) return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  const handle = async (m) => {
    const reply = (result) => ({ jsonrpc: '2.0', id: m.id, result });
    switch (m.method) {
      case 'initialize':
        return reply({ protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'anixart', version: '1.0.0' } });
      case 'ping': return reply({});
      case 'tools/list':
        return reply({ tools: entry.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.readOnly ? { readOnlyHint: true } : { destructiveHint: false } })) });
      case 'tools/call': {
        const { name, arguments: args } = m.params || {};
        if (memory.NAMES.has(name)) {
          try {
            const text = memory.call(entry.profileId, name, args || {});
            emit({ type: 'memory', profileId: entry.profileId });
            return reply({ content: [{ type: 'text', text }] });
          } catch (e) { return reply({ content: [{ type: 'text', text: errText(e) }], isError: true }); }
        }
        const r = await callTool(name, args || {});
        if (r.error) return reply({ content: [{ type: 'text', text: String(r.error) }], isError: true });
        return reply({ content: [{ type: 'text', text: typeof r.result === 'string' ? r.result : JSON.stringify(r.result) }] });
      }
      default:
        if (m.id === undefined) return null; // уведомление
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  };
  const out = Array.isArray(msg) ? (await Promise.all(msg.map(handle))).filter(Boolean) : await handle(msg);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  return json(res, 200, out);
}

function setPort(port) { serverPort = port; }
function shutdown() { try { if (proc) proc.kill(); } catch { /* ignore */ } }

module.exports = { handleAi, handleMcp, setPort, shutdown };
process.on('exit', shutdown);
