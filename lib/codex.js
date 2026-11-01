// Reads Codex rollouts under ~/.codex/sessions and ~/.codex/archived_sessions
// into the same session shape Hindcast already uses for Claude Code.
// A rollout the user did not write (base instructions, encrypted reasoning,
// workspace snapshots) is never turned into a title, a search hit, or a
// usage row.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { forEachLine, zstdBin } = require('./lines');
const { projectKeyFromCwd } = require('./project-key');

const CODEX_CACHE_V = 1;
const SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const ARCHIVED_DIR = path.join(os.homedir(), '.codex', 'archived_sessions');
const TEXT_CAP = 16000;
// 8-4-4-4-12 hex. Codex and Grok both use this shape. A value that is not
// this shape is not a session id, even when the file claims it is.
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_ID_RE = /rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function acceptSessionId(raw, filePath) {
  if (typeof raw === 'string' && SESSION_ID_RE.test(raw)) return raw.toLowerCase();
  const m = FILE_ID_RE.exec(path.basename(filePath || ''));
  return m ? m[1].toLowerCase() : null;
}

function epoch(ts) {
  if (typeof ts !== 'string' && typeof ts !== 'number') return null;
  const n = typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function dayKey(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function clip(text) {
  const s = String(text || '');
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + `\n… [${(s.length - TEXT_CAP).toLocaleString()} more chars]` : s;
}

// A block wholly wrapped in a snake_case tag is Codex's injected context.
// <request> and <div> are things a person can type, and stay prompts.
function isInjected(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.startsWith('# AGENTS.md')) return true;
  const m = t.match(/^<([a-z]+_[a-z0-9_]*)>[\s\S]*<\/\1>\s*$/);
  return !!m;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const bits = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'input_image' || c.type === 'image' || c.image_url) continue;
    if (typeof c.text === 'string') bits.push(c.text);
  }
  return bits.join('\n');
}

function reasoningText(item) {
  if (!item || typeof item !== 'object') return '';
  const s = item.summary;
  if (typeof s === 'string') return s;
  if (Array.isArray(s)) {
    return s.map((part) => (typeof part === 'string' ? part : (part && part.text) || '')).join('\n');
  }
  if (typeof item.text === 'string' && item.type !== 'encrypted') return item.text;
  return '';
}

function itemOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') return obj.payload;
  if (obj.type === 'message') return obj;
  return null;
}

// Text a person could have read. Encrypted reasoning and image payloads are
// not text, so a query cannot match them.
function codexDisplayText(obj) {
  const item = itemOf(obj);
  if (!item) return null;
  if (item.type === 'message') {
    if (item.role !== 'user' && item.role !== 'assistant') return null;
    const text = textOf(item.content);
    if (!text || (item.role === 'user' && isInjected(text))) return null;
    return { role: item.role === 'user' ? 'user' : 'assistant', text };
  }
  if (item.type === 'reasoning') {
    const text = reasoningText(item);
    return text ? { role: 'thinking', text } : null;
  }
  if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call') {
    const args = item.arguments || item.input || item.command || '';
    const text = typeof args === 'string' ? args : JSON.stringify(args);
    return { role: item.name || item.tool || 'tool', text };
  }
  return null;
}

function blankMeta() {
  return {
    title: '',
    firstTs: null,
    lastTs: null,
    cwd: null,
    gitBranch: null,
    version: null,
    models: {},
    userTurns: 0,
    assistantMsgs: 0,
    toolCalls: 0,
    tools: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    daily: {},
    usageRecords: [],
    skillRecords: [],
    sidechainEvents: 0,
    events: 0,
    threadId: null,
    subagent: null,
  };
}

function noteTime(meta, ms) {
  if (ms == null) return;
  if (meta.firstTs === null || ms < meta.firstTs) meta.firstTs = ms;
  if (meta.lastTs === null || ms > meta.lastTs) meta.lastTs = ms;
}

function usageNums(u) {
  if (!u || typeof u !== 'object') return null;
  // input_tokens already includes the cached and written prompt tokens.
  const cr = u.cached_input_tokens || u.cache_read_input_tokens || 0;
  const w = u.cache_write_input_tokens || 0;
  return {
    in: Math.max(0, (u.input_tokens || 0) - cr - w),
    out: u.output_tokens || 0,
    cr,
    w,
  };
}

function pushUsage(meta, id, model, nums, ms) {
  const day = dayKey(ms);
  if (!day || !nums) return;
  meta.usageRecords.push({
    id, m: model || 'codex', d: day,
    in: nums.in, out: nums.out, cr: nums.cr, w5: nums.w, w1: 0,
  });
  meta.models[model || 'codex'] = (meta.models[model || 'codex'] || 0) + 1;
}

// One walk. Usage rules, in order:
// - A token_usage_record is the response. Once any exists, token_count lines
//   are not added (they repeat the same response).
// - A line stamped with the child's creation instant is the parent's usage.
//   It is not added, but its cumulative total is remembered, so a later
//   restatement is not counted as new work.
// - A token_count line counts even when it has no turn id.
async function extractCodexMeta(filePath) {
  const meta = blankMeta();
  let curModel = null;
  let bornAt = null;
  let hasRecords = false;
  let lastTotalOut = null;
  let title = '';

  const onTokenCount = (info, ts, ms) => {
    const total = info && info.total_token_usage;
    const last = info && info.last_token_usage;
    const prev = lastTotalOut;
    if (total && typeof total.output_tokens === 'number') lastTotalOut = total.output_tokens;
    if (hasRecords) return;
    if (bornAt && ts && ts === bornAt) return;
    if (prev != null && lastTotalOut === prev) return;
    const nums = usageNums(last);
    if (!nums) return;
    pushUsage(meta, 'cx:count:' + (ts || meta.usageRecords.length), curModel, nums, ms);
  };

  await forEachLine(filePath, (line) => {
    if (line[0] !== '{') return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    const ms = epoch(ts);
    const p = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
    noteTime(meta, ms);

    if (obj.type === 'session_meta') {
      if (!meta.threadId) {
        meta.threadId = acceptSessionId(p.id || p.session_id, filePath);
        if (typeof p.cwd === 'string') meta.cwd = p.cwd;
        if (p.git && typeof p.git.branch === 'string') meta.gitBranch = p.git.branch;
        if (typeof p.cli_version === 'string') meta.version = p.cli_version;
        meta.subagent = subagentOf(p);
        if (meta.subagent || p.forked_from_id) bornAt = ts || null;
      }
      return;
    }
    if (obj.type === 'turn_context') {
      if (typeof p.model === 'string' && p.model) curModel = p.model;
      if (!meta.cwd && typeof p.cwd === 'string') meta.cwd = p.cwd;
      return;
    }
    if (obj.type === 'token_usage_record') {
      hasRecords = true;
      const inherited = bornAt && ts && ts === bornAt;
      const thread = usageNums(p.thread_token_usage);
      if (thread) lastTotalOut = thread.out;
      if (inherited) return;
      const nums = usageNums(p.usage) || usageNums(p.turn_token_usage);
      const id = p.response_id ? 'cx:' + p.response_id : 'cx:rec:' + (ts || meta.usageRecords.length);
      const model = curModel;
      pushUsage(meta, id, model, nums, ms);
      return;
    }
    if (obj.type === 'event_msg' && p.type === 'token_count') {
      onTokenCount(p.info, ts, ms);
      return;
    }

    const shown = codexDisplayText(obj);
    if (!shown) return;
    meta.events++;
    if (shown.role === 'user') {
      meta.userTurns++;
      if (!title) title = shown.text.replace(/\s+/g, ' ').trim().slice(0, 140);
    } else if (shown.role === 'assistant') {
      meta.assistantMsgs++;
    } else if (shown.role === 'thinking') {
      // thinking is not a tool and not a prompt
    } else {
      meta.toolCalls++;
      meta.tools[shown.role] = (meta.tools[shown.role] || 0) + 1;
    }
  });

  if (!meta.threadId) meta.threadId = acceptSessionId(null, filePath);
  meta.title = title;
  return meta;
}

function subagentOf(p) {
  const src = p.source && typeof p.source === 'object' ? p.source : null;
  const sub = src && src.subagent;
  if (p.thread_source !== 'subagent' && !sub) return null;
  const spawn = sub && typeof sub === 'object' && sub.thread_spawn && typeof sub.thread_spawn === 'object'
    ? sub.thread_spawn : null;
  const parent = (spawn && spawn.parent_thread_id) || p.parent_thread_id || null;
  return {
    parentId: typeof parent === 'string' ? parent.toLowerCase() : null,
    nickname: (spawn && spawn.agent_nickname) || p.agent_nickname || null,
    role: (spawn && spawn.agent_role) || p.agent_role || null,
  };
}

async function parseCodexSession(filePath) {
  const events = [];
  let pending = null;
  const flush = () => {
    if (!pending) return;
    events.push(pending);
    pending = null;
  };
  await forEachLine(filePath, (line) => {
    if (line[0] !== '{') return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    const ms = epoch(obj.timestamp) || 0;
    const shown = codexDisplayText(obj);
    if (!shown) return;
    if (shown.role === 'user') {
      flush();
      events.push({ kind: 'user', ts: ms, text: clip(shown.text) });
    } else if (shown.role === 'assistant') {
      flush();
      events.push({ kind: 'assistant', ts: ms, text: clip(shown.text) });
    } else if (shown.role === 'thinking') {
      flush();
      events.push({ kind: 'thinking', ts: ms, text: clip(shown.text) });
    } else {
      flush();
      pending = {
        kind: 'tool', ts: ms, toolName: shown.role,
        toolSummary: clip(shown.text).slice(0, 180),
        input: clip(shown.text), result: null,
      };
    }
  });
  flush();
  return { events, sidechainCount: 0, abandonedCount: 0, subagents: [] };
}

async function walk(dir, out) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

async function listRolloutFiles() {
  const found = [];
  await walk(SESSIONS_DIR, found);
  await walk(ARCHIVED_DIR, found);
  const files = [];
  let skippedZstd = 0;
  const canZstd = !!zstdBin();
  for (const file of found) {
    const base = path.basename(file);
    if (!base.startsWith('rollout-')) continue;
    if (base.endsWith('.jsonl')) files.push(file);
    else if (base.endsWith('.jsonl.zst')) {
      if (canZstd) files.push(file);
      else skippedZstd++;
    }
  }
  return { files, skippedZstd };
}

// Walk to the session a person sees. A grandchild must not fold into a child
// that is itself about to disappear.
function topEntry(byId, startId) {
  let current = byId.get(startId);
  const seen = new Set();
  while (current && current.meta.subagent && current.meta.subagent.parentId) {
    if (seen.has(current.meta.threadId)) break;
    seen.add(current.meta.threadId);
    const up = byId.get(current.meta.subagent.parentId);
    if (!up) break;
    current = up;
  }
  return current;
}

// Children fold into the top session that is actually in this batch. A child
// whose parent is absent stays a session of its own. Newest mtime wins an id;
// filePath breaks the tie so the winner does not depend on worker order.
function assembleCodexSessions(entries) {
  const ordered = [...entries].sort((a, b) =>
    ((b.mtime || 0) - (a.mtime || 0)) || String(a.filePath).localeCompare(String(b.filePath)));
  const byId = new Map();
  const roots = [];
  const children = [];
  for (const e of ordered) {
    const id = e.meta && e.meta.threadId;
    if (!id || byId.has(id)) continue;
    byId.set(id, e);
    if (e.meta.subagent && e.meta.subagent.parentId) children.push(e);
    else roots.push(e);
  }
  const consumed = new Set();
  for (const child of children) {
    const parent = topEntry(byId, child.meta.subagent.parentId);
    if (!parent || parent === child) continue;
    consumed.add(child.meta.threadId);
    // Copy. The meta object is the scanner cache, and a push would stick.
    const parentRecords = parent.meta.usageRecords || [];
    const childRecords = child.meta.usageRecords || [];
    parent.meta = {
      ...parent.meta,
      usageRecords: parentRecords.concat(childRecords),
    };
    parent.subagents = parent.subagents || [];
    parent.subagents.push({
      id: child.meta.threadId,
      filePath: child.filePath,
      title: child.meta.title || child.meta.subagent.nickname || child.meta.threadId.slice(0, 8),
      agent: 'codex',
    });
  }
  const sessions = [];
  const emit = (e) => {
    const key = projectKeyFromCwd(e.meta.cwd) || 'codex';
    sessions.push({
      id: e.meta.threadId,
      filePath: e.filePath,
      project: key,
      projectPath: e.meta.cwd || '',
      agent: 'codex',
      ...e.meta,
      subagents: e.subagents || [],
      size: e.size,
      mtime: e.mtime,
    });
  };
  for (const e of roots) emit(e);
  for (const e of children) if (!consumed.has(e.meta.threadId)) emit(e);
  return sessions;
}

module.exports = {
  CODEX_CACHE_V, SESSIONS_DIR, ARCHIVED_DIR, SESSION_ID_RE,
  acceptSessionId, codexDisplayText, extractCodexMeta, parseCodexSession,
  listRolloutFiles, assembleCodexSessions, projectKeyFromCwd,
};
