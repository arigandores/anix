'use strict';
// Память AI-помощника: memories.md на каждый аккаунт Anixart (~/.anixart-desktop/ai/memories/<id>.md).
//
// Как не съесть контекст: файл целиком подставляется в системный промпт в начале беседы, поэтому он
// жёстко ограничен — MAX_ENTRIES записей по MAX_ENTRY символов и не больше MAX_TOTAL символов всего.
// При переполнении remember отказывает и просит помощника сначала объединить или удалить записи
// (update_memory / forget) — память сжимается самим помощником, а не растёт бесконечно.
//
// Формат — обычный Markdown, его можно править руками:
//   ## Нравится
//   - [m3] Любит спортивные сёнены про бокс (2026-10-11)
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 40;
const MAX_ENTRY = 200;
const MAX_TOTAL = 4000;
const SECTIONS = { likes: 'Нравится', dislikes: 'Не нравится', habits: 'Привычки и формат', other: 'Прочее' };
const BY_TITLE = Object.fromEntries(Object.entries(SECTIONS).map(([k, v]) => [v.toLowerCase(), k]));

let baseDir = '';
function init(dir) { baseDir = path.join(dir, 'memories'); }
const fileOf = (profileId) => path.join(baseDir, `${Number(profileId) || 0}.md`);
const today = () => new Date().toISOString().slice(0, 10);

function parse(text) {
  const entries = [];
  let section = 'other';
  let maxId = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const hd = /^##\s+(.+?)\s*$/.exec(raw);
    if (hd) { section = BY_TITLE[hd[1].toLowerCase()] || 'other'; continue; }
    const m = /^\s*[-*]\s+(?:\[m(\d+)\]\s*)?(.+?)\s*(?:\((\d{4}-\d{2}-\d{2})\))?\s*$/.exec(raw);
    if (!m || !m[2].trim()) continue;
    const id = m[1] ? Number(m[1]) : 0;
    maxId = Math.max(maxId, id);
    entries.push({ id, section, text: m[2].trim().slice(0, MAX_ENTRY), date: m[3] || today() });
  }
  for (const e of entries) if (!e.id) e.id = ++maxId; // записи, добавленные вручную без id
  return entries;
}

function render(entries) {
  const out = ['# Память AI-помощника Anixart', '', '<!-- Пишет и читает помощник. Можно править вручную: одна запись — одна строка «- [mN] текст (дата)». -->'];
  for (const [key, title] of Object.entries(SECTIONS)) {
    const list = entries.filter((e) => e.section === key);
    if (!list.length) continue;
    out.push('', `## ${title}`, ...list.map((e) => `- [m${e.id}] ${e.text} (${e.date})`));
  }
  return `${out.join('\n')}\n`;
}

function load(profileId) {
  try { return parse(fs.readFileSync(fileOf(profileId), 'utf8')); } catch { return []; }
}
function save(profileId, entries) {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(fileOf(profileId), render(entries), 'utf8');
}
const totalLen = (entries) => entries.reduce((a, e) => a + e.text.length + 8, 0);
const usage = (entries) => `${entries.length}/${MAX_ENTRIES} записей, ${totalLen(entries)}/${MAX_TOTAL} символов`;

// Текст для системного промпта (компактно, с id — чтобы помощник мог обновлять/удалять записи)
function promptBlock(profileId) {
  const entries = load(profileId);
  if (!entries.length) return `Память пуста (${usage(entries)}).`;
  const lines = [];
  for (const [key, title] of Object.entries(SECTIONS)) {
    const list = entries.filter((e) => e.section === key);
    if (list.length) lines.push(`${title}:`, ...list.map((e) => `- [m${e.id}] ${e.text}`));
  }
  return `${lines.join('\n')}\n(${usage(entries)})`;
}

const SECTION_ENUM = Object.keys(SECTIONS);
const TOOLS = [
  {
    name: 'remember', readOnly: true,
    description: `Запомнить устойчивое предпочтение пользователя (одна короткая мысль, до ${MAX_ENTRY} символов). Сначала проверь память в системном промпте: если похожая запись есть — используй update_memory, не дублируй.`,
    inputSchema: { type: 'object', properties: { section: { type: 'string', enum: SECTION_ENUM, description: 'likes — нравится, dislikes — не нравится, habits — привычки и формат просмотра, other — прочее' }, text: { type: 'string' } }, required: ['section', 'text'] },
  },
  {
    name: 'update_memory', readOnly: true,
    description: 'Переписать запись памяти по id (уточнить, объединить несколько в одну — остальные затем удалить через forget).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'например m3' }, text: { type: 'string' }, section: { type: 'string', enum: SECTION_ENUM } }, required: ['id', 'text'] },
  },
  {
    name: 'forget', readOnly: true,
    description: 'Удалить запись памяти по id (устарела, неверна, или пользователь попросил забыть).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
const num = (id) => Number(String(id || '').replace(/^m/i, ''));

function call(profileId, name, args = {}) {
  const entries = load(profileId);
  const text = String(args.text || '').replace(/\s+/g, ' ').trim();
  if (name === 'remember') {
    if (!text) throw new Error('Пустая запись');
    if (text.length > MAX_ENTRY) throw new Error(`Слишком длинно (${text.length} > ${MAX_ENTRY}). Сформулируй короче.`);
    if (entries.some((e) => e.text.toLowerCase() === text.toLowerCase())) return `Уже есть в памяти (${usage(entries)})`;
    if (entries.length >= MAX_ENTRIES || totalLen(entries) + text.length + 8 > MAX_TOTAL) {
      throw new Error(`Память заполнена (${usage(entries)}). Сначала объедини похожие записи (update_memory) или удали устаревшие (forget), потом повтори remember. Текущая память:\n${promptBlock(profileId)}`);
    }
    const id = entries.reduce((a, e) => Math.max(a, e.id), 0) + 1;
    entries.push({ id, section: SECTIONS[args.section] ? args.section : 'other', text, date: today() });
    save(profileId, entries);
    return `Запомнено как m${id} (${usage(entries)})`;
  }
  if (name === 'update_memory') {
    const e = entries.find((x) => x.id === num(args.id));
    if (!e) throw new Error(`Нет записи ${args.id}`);
    if (!text || text.length > MAX_ENTRY) throw new Error(`Текст должен быть от 1 до ${MAX_ENTRY} символов`);
    e.text = text; e.date = today(); if (SECTIONS[args.section]) e.section = args.section;
    save(profileId, entries);
    return `Обновлено m${e.id} (${usage(entries)})`;
  }
  if (name === 'forget') {
    const rest = entries.filter((x) => x.id !== num(args.id));
    if (rest.length === entries.length) throw new Error(`Нет записи ${args.id}`);
    save(profileId, rest);
    return `Удалено ${args.id} (${usage(rest)})`;
  }
  throw new Error(`Неизвестный инструмент ${name}`);
}

// Для окна «Память» в приложении
function list(profileId) { const e = load(profileId); return { entries: e, sections: SECTIONS, usage: usage(e), limits: { MAX_ENTRIES, MAX_ENTRY, MAX_TOTAL } }; }
function remove(profileId, id) { save(profileId, load(profileId).filter((e) => e.id !== num(id))); return list(profileId); }
function clear(profileId) { try { fs.unlinkSync(fileOf(profileId)); } catch { /* нет файла */ } return list(profileId); }

module.exports = { init, TOOLS, NAMES, call, promptBlock, list, remove, clear, MAX_ENTRIES };
