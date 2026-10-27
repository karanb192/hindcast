// OpenAI Codex rollouts. Codex (CLI, IDE extension, and the desktop app)
// writes one JSONL file per thread under ~/.codex/sessions/YYYY/MM/DD/,
// compresses older ones to .jsonl.zst, and moves archived threads to
// ~/.codex/archived_sessions/. Subagent and auto-review threads get rollouts
// of their own whose session_meta names the root thread; buildIndex folds
// them into that session the way Claude subagent transcripts fold into
// theirs. Same contract as the Claude side: read-only, tolerant of unknown
// line and item types, never fatal. Nothing here writes under ~/.codex.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_SESSION_DIRS = ['sessions', 'archived_sessions'].map((d) => path.join(CODEX_HOME, d));
const CODEX_INDEX_FILE = path.join(CODEX_HOME, 'session_index.jsonl');
const ROLLOUT_RE = /^rollout-.+\.jsonl(\.zst)?$/;
const THREAD_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/;

// Bump when extractCodexMeta output shape changes. A string, so it can never
// collide with the Claude side's numeric CACHE_V in the shared cache file.
const CODEX_CACHE_V = 'cx3';

// ---------- binaries ----------

// A Finder-launched app inherits launchd's PATH, which has no Homebrew, so
// look in the usual install dirs first.
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH || '').split(':')];

function findBin(name) {
  for (const dir of BIN_DIRS) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

let zstdPath; // undefined until looked up; null when not installed
function zstdBin() {
  if (zstdPath === undefined) zstdPath = findBin('zstd');
  return zstdPath;
}

// ---------- line reading ----------

// Longest line handed to a caller. A longer one (a corrupt or hostile
// rollout) is skipped whole but still counted, so line numbers stay aligned
// with ripgrep's.
const MAX_LINE_BYTES = 64 * 1024 * 1024;

// Call onLine(buf, lineNo) for every line of a rollout, plain or zstd.
// Lines arrive as Buffers so callers can sniff a line's head and skip the
// rest without decoding it: Codex lines carry base instructions, encrypted
// reasoning, and full tool output, and most of those bytes are never read.
// onLine returning true stops the read early. Line numbers count the way
// ripgrep counts them, so search hits and the tape agree.
function scanLines(filePath, onLine) {
  return new Promise((resolve, reject) => {
    let child = null;
    let input;
    if (filePath.endsWith('.zst')) {
      const bin = zstdBin();
      if (!bin) { reject(new Error('zstd not found')); return; }
      child = spawn(bin, ['-dcq', '--', filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
      input = child.stdout;
    } else {
      input = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    }
    let pending = [];
    let pendingBytes = 0;
    let oversized = false; // dropping the current line through its newline
    let n = 0;
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      input.destroy();
      if (child) child.kill();
      if (err) reject(err); else resolve();
    };
    const emit = (buf) => {
      n++;
      let stop;
      try { stop = onLine(buf, n); } catch (e) { finish(e); return; }
      if (stop === true) finish();
    };
    const hold = (piece) => {
      if (oversized) return;
      pendingBytes += piece.length;
      if (pendingBytes > MAX_LINE_BYTES) { oversized = true; pending = []; pendingBytes = 0; return; }
      pending.push(piece);
    };
    const lineEnd = (tail) => {
      hold(tail);
      if (oversized) { oversized = false; n++; return; }
      const line = pending.length === 1 ? pending[0] : Buffer.concat(pending);
      pending = []; pendingBytes = 0;
      emit(line);
    };
    // Listener exceptions would otherwise escape the promise and reach the
    // main process as uncaught.
    input.on('data', (chunk) => {
      try {
        let start = 0;
        let nl;
        while (!finished && (nl = chunk.indexOf(10, start)) !== -1) {
          lineEnd(chunk.subarray(start, nl));
          start = nl + 1;
        }
        if (!finished && start < chunk.length) hold(chunk.subarray(start));
      } catch (e) { finish(e); }
    });
    input.on('end', () => {
      try { if (!finished && (pending.length || oversized)) lineEnd(Buffer.alloc(0)); } catch (e) { finish(e); return; }
      finish();
    });
    input.on('error', (e) => finish(e));
    if (child) child.on('error', (e) => finish(e));
  });
}

// { lineNo -> text } for the wanted lines, stopping at the last one.
async function readLinesAt(filePath, wantedLines) {
  const wanted = new Set(wantedLines);
  const maxLine = Math.max(...wantedLines);
  const out = new Map();
  await scanLines(filePath, (buf, n) => {
    if (wanted.has(n)) out.set(n, buf.toString('utf8'));
    return n >= maxLine;
  });
  return out;
}

// Every line opens with the same envelope, in this key order:
//   {"timestamp":"…","ordinal":N,"type":"response_item","payload":{"type":"message",…
// (ordinal is newer). Reading the head is enough to route a line.
const HEAD_RE = /^\{"timestamp":"([^"]*)",(?:"ordinal":\d+,)?"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)")?/;
const ROLE_RE = /"role":"([a-z]+)"/;
const NAME_RE = /"name":"([^"\\]+)"/;
const NAMESPACE_RE = /"namespace":"([^"\\]+)"/;
const HEAD_BYTES = 640;

function sniff(head) {
  const m = HEAD_RE.exec(head);
  return m ? { ts: m[1], type: m[2], ptype: m[3] || '' } : null;
}

// Rollouts from before the envelope put items at the top level. Return the
// item a line carries, whichever shape it has.
const ITEM_TYPES = new Set([
  'message', 'reasoning', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output', 'local_shell_call',
  'local_shell_call_output', 'web_search_call', 'tool_search_call',
  'tool_search_output', 'image_generation_call', 'agent_message',
]);
function itemOf(obj) {
  if (obj.type === 'response_item') return obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  return ITEM_TYPES.has(obj.type) ? obj : null;
}

// ---------- helpers ----------

// Epoch ms, or NaN for anything that is not a parseable string: valid JSON
// can carry an object here, and Date.parse would throw converting it.
const tsOf = (v) => (typeof v === 'string' ? Date.parse(v) : NaN);

// Same local 'YYYY-MM-DD' convention as scanner.js dayKey.
function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Codex injects context as user-role messages: AGENTS.md, the environment
// block, plugin and app lists. Its context tags are snake_case
// (<environment_context>, <user_instructions>, <recommended_plugins>), so a
// block that is one whole element of such a tag is context the user never
// typed; a prompt the user wrapped in <request> or <div> is not.
const CONTEXT_TAG = '[a-z][a-z0-9]*(?:_[a-z0-9]+)+';
const CONTEXT_OPEN_RE = new RegExp('^<(' + CONTEXT_TAG + ')(?:\\s[^>]*)?>');
function isInjectedText(text) {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith('# AGENTS.md instructions')) return true;
  const m = CONTEXT_OPEN_RE.exec(t);
  return !!(m && t.endsWith('</' + m[1] + '>'));
}

function userTextOf(content) {
  if (typeof content === 'string') return isInjectedText(content) ? '' : content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'input_text' || b.type === 'text') && typeof b.text === 'string' && !isInjectedText(b.text))
    .map((b) => b.text.trim())
    .join('\n');
}

// The desktop app wraps attachments around the prompt; the title wants the
// prompt itself.
function promptForTitle(text) {
  const i = text.indexOf('## My request for Codex:');
  return (i >= 0 ? text.slice(i + 24) : text).trim();
}

function outputTextOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b.type === 'output_text' || b.type === 'input_text' || b.type === 'text' || b.type === 'refusal'))
    .map((b) => (typeof b.text === 'string' ? b.text : typeof b.refusal === 'string' ? b.refusal : ''))
    .filter(Boolean)
    .join('\n');
}

const MAX_IMAGES = 8;
function imagesOf(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (out.length >= MAX_IMAGES) break;
    const url = b && b.type === 'input_image' && typeof b.image_url === 'string' ? b.image_url : '';
    const m = /^data:([^;,]+);base64,/.exec(url);
    if (m) out.push({ mediaType: m[1], data: url.slice(m[0].length) });
  }
  return out;
}

function reasoningTextOf(item) {
  const pick = (arr, type) => (Array.isArray(arr) ? arr : [])
    .filter((b) => b && b.type === type && typeof b.text === 'string' && b.text.trim())
    .map((b) => b.text.trim())
    .join('\n\n');
  // Raw reasoning when the rollout kept it, else the summary; encrypted-only
  // reasoning has neither and stays off the tape.
  return pick(item.content, 'reasoning_text') || pick(item.summary, 'summary_text');
}

// Claude spells MCP tools mcp__server__tool; Codex keeps the server as a
// namespace. Join them the same way so the Instruments panel reads alike.
function toolNameOf(item) {
  switch (item.type) {
    case 'local_shell_call': return 'shell';
    case 'web_search_call': return 'web_search';
    case 'tool_search_call': return 'tool_search';
    case 'image_generation_call': return 'image_generation';
  }
  const name = typeof item.name === 'string' && item.name ? item.name : 'unknown';
  const ns = typeof item.namespace === 'string' ? item.namespace : '';
  if (!ns) return name;
  return ns.startsWith('mcp__') ? ns + '__' + name : ns + '.' + name;
}

const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call', 'tool_search_call', 'image_generation_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output', 'tool_search_output']);

function callArgsOf(item) {
  if (item.type === 'local_shell_call' || item.type === 'web_search_call') return item.action || null;
  if (item.type === 'custom_tool_call') return typeof item.input === 'string' ? item.input : null;
  const raw = item.arguments;
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : null;
  try { return JSON.parse(raw); } catch { return raw; }
}

const SUMMARY_KEYS = ['title', 'description', 'cmd', 'command', 'query', 'path', 'file_path', 'url', 'target', 'task_name', 'message'];
function summarizeCall(args) {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const k of SUMMARY_KEYS) {
      const v = args[k];
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v.join(' ').slice(0, 200);
    }
    const firstStr = Object.values(args).find((v) => typeof v === 'string' && v.trim());
    return firstStr ? firstStr.trim().slice(0, 200) : '';
  }
  if (typeof args === 'string') {
    // The exec tool takes a JavaScript program: surface the first shell
    // command it runs, else its first line.
    const m = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/.exec(args);
    if (m) { try { return JSON.parse(m[1]).slice(0, 200); } catch {} }
    const first = args.split('\n').find((l) => l.trim());
    return first ? first.trim().slice(0, 200) : '';
  }
  return '';
}

// Tool output comes as a plain string, a JSON string with exit metadata
// (older shell tools), a content array, or { content, success }.
function readOutput(out) {
  if (typeof out === 'string') {
    if (out.startsWith('{')) {
      try {
        const o = JSON.parse(out);
        if (o && typeof o.output === 'string') {
          const code = o.metadata && o.metadata.exit_code;
          return { text: o.output, images: [], isError: typeof code === 'number' && code !== 0 };
        }
      } catch {}
    }
    return { text: out, images: [], isError: false };
  }
  if (Array.isArray(out)) {
    const text = outputTextOf(out);
    // The exec tool reports a thrown script this way.
    return { text, images: imagesOf(out), isError: /^Script (failed|error)/.test(text) };
  }
  if (out && typeof out === 'object') {
    const inner = readOutput(out.content != null ? out.content : '');
    return { ...inner, isError: inner.isError || out.success === false };
  }
  return { text: '', images: [], isError: false };
}

// Usage as Codex reports it: input_tokens includes the cached and
// cache-written tokens, output_tokens includes reasoning. Split into the
// same {in, out, cr, w5, w1} record the Claude side ships.
function usageRecord(id, model, u, timestamp) {
  if (!u || typeof u !== 'object' || !model) return null;
  const ts = tsOf(timestamp);
  const day = Number.isNaN(ts) ? null : dayKey(ts);
  if (!day) return null;
  const input = Number(u.input_tokens) || 0;
  const cached = Number(u.cached_input_tokens) || 0;
  const written = Number(u.cache_write_input_tokens) || 0;
  return {
    id, m: model, d: day,
    in: Math.max(0, input - cached - written),
    out: Number(u.output_tokens) || 0,
    cr: cached,
    w5: written,
    w1: 0,
  };
}

function modelOfTurnContext(p) {
  if (typeof p.model === 'string' && p.model) return p.model;
  const s = p.collaboration_mode && p.collaboration_mode.settings;
  return s && typeof s.model === 'string' && s.model ? s.model : null;
}

function subagentOf(p) {
  const sub = p.source && typeof p.source === 'object' ? p.source.subagent : null;
  if (!sub && p.thread_source !== 'subagent') return null;
  const spawnInfo = sub && typeof sub === 'object' && sub.thread_spawn && typeof sub.thread_spawn === 'object'
    ? sub.thread_spawn : null;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return {
    kind: spawnInfo ? 'spawn' : typeof sub === 'string' ? sub
      : (sub && typeof sub.other === 'string' ? sub.other : 'subagent'),
    nickname: str(p.agent_nickname) || (spawnInfo && str(spawnInfo.agent_nickname)),
    role: str(p.agent_role) || (spawnInfo && str(spawnInfo.agent_role)),
    agentPath: str(p.agent_path) || (spawnInfo && str(spawnInfo.agent_path)),
    parentId: str(p.parent_thread_id) || (spawnInfo && str(spawnInfo.parent_thread_id)),
  };
}

// ---------- metadata ----------

async function extractCodexMeta(filePath) {
  let firstPrompt = '';
  const meta = {
    title: '',
    firstTs: null,
    lastTs: null,
    cwd: null,
    gitBranch: null,
    version: null,
    originator: null,
    models: {},
    userTurns: 0,
    assistantMsgs: 0,
    toolCalls: 0,
    tools: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    daily: {},
    usageRecords: [],
    skillRecords: [], // Codex has no skill carrier to read; kept for shape parity
    sidechainEvents: 0,
    events: 0,
    threadId: null,
    rootId: null,
    subagent: null,
  };
  const turnModel = new Map();
  let curModel = null;
  let curTurn = null;
  const assistantByModel = {};
  // Newer rollouts write one token_usage_record per API response, keyed by
  // response id. Older ones only have token_count events, which repeat: the
  // cumulative total only moves when a new response lands. A turn that has
  // records uses them and ignores its token_count lines.
  const recordTurns = new Set();
  const countRecs = [];
  let lastTotal = null;
  // Some subagent and fork rollouts open by replaying part of the parent's
  // thread, usage lines included, all stamped with the instant the child was
  // created. No real response completes in that same millisecond, so usage
  // carrying it is the parent's and is left to the parent.
  let bornAt = null;

  const handle = (obj) => {
    const p = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : '';
    switch (obj.type) {
      case 'session_meta': {
        if (meta.threadId) return; // a fork can carry its parent's meta line after its own
        meta.threadId = typeof p.id === 'string' ? p.id : null;
        meta.rootId = typeof p.session_id === 'string' ? p.session_id : null;
        if (typeof p.cwd === 'string') meta.cwd = p.cwd;
        if (p.git && typeof p.git.branch === 'string') meta.gitBranch = p.git.branch;
        if (typeof p.cli_version === 'string') meta.version = p.cli_version;
        if (typeof p.originator === 'string') meta.originator = p.originator;
        meta.subagent = subagentOf(p);
        if ((meta.subagent || p.forked_from_id) && ts) bornAt = ts;
        return;
      }
      case 'turn_context': {
        const m = modelOfTurnContext(p);
        if (m) { curModel = m; if (p.turn_id) turnModel.set(p.turn_id, m); }
        if (p.turn_id) curTurn = p.turn_id;
        if (!meta.cwd && typeof p.cwd === 'string') meta.cwd = p.cwd;
        return;
      }
      case 'token_usage_record': {
        if (bornAt && ts === bornAt) return;
        const id = p.response_id ? 'cx:' + p.response_id : null;
        const model = (p.turn_id && turnModel.get(p.turn_id)) || curModel;
        const rec = id && usageRecord(id, model, p.usage, ts);
        if (rec) { meta.usageRecords.push(rec); if (p.turn_id) recordTurns.add(p.turn_id); }
        return;
      }
      case 'event_msg': {
        if (p.type === 'task_started' && p.turn_id) curTurn = p.turn_id;
        // A token_count before any turn restates the previous context
        // window's last response (a compacted continuation opens with one).
        else if (p.type === 'token_count' && curTurn && ts !== bornAt && p.info && typeof p.info === 'object') {
          const total = p.info.total_token_usage && p.info.total_token_usage.total_tokens;
          if (typeof total !== 'number' || total === lastTotal) return;
          lastTotal = total;
          // Keyed by timestamp and running total: unique per response, and
          // identical if a later rollout ever copies the line verbatim.
          const rec = usageRecord('cxtc:' + ts + ':' + total, curModel, p.info.last_token_usage, ts);
          if (rec) countRecs.push({ rec, turn: curTurn });
        }
        return;
      }
    }
    const item = itemOf(obj);
    if (!item) {
      // Pre-envelope rollouts open with a bare { id, timestamp, instructions } line.
      if (!obj.type && typeof obj.id === 'string' && !meta.threadId) meta.threadId = obj.id;
      return;
    }
    if (item.type === 'message') {
      if (item.role === 'user') {
        const text = userTextOf(item.content);
        if (text) {
          meta.userTurns++;
          if (!firstPrompt) firstPrompt = promptForTitle(text).slice(0, 200);
        }
      } else if (item.role === 'assistant') {
        meta.assistantMsgs++;
        if (curModel) assistantByModel[curModel] = (assistantByModel[curModel] || 0) + 1;
      }
    } else if (CALL_TYPES.has(item.type)) {
      meta.toolCalls++;
      const name = toolNameOf(item);
      meta.tools[name] = (meta.tools[name] || 0) + 1;
    }
  };

  await scanLines(filePath, (buf) => {
    if (!buf.length) return;
    meta.events++;
    const head = buf.toString('utf8', 0, Math.min(buf.length, HEAD_BYTES));
    const h = sniff(head);
    if (h) {
      const ts = Date.parse(h.ts);
      if (!Number.isNaN(ts)) {
        if (meta.firstTs === null || ts < meta.firstTs) meta.firstTs = ts;
        if (meta.lastTs === null || ts > meta.lastTs) meta.lastTs = ts;
      }
      // Route on the head and skip the heavy lines without decoding them.
      if (h.type === 'response_item') {
        if (h.ptype === 'message') {
          const role = ROLE_RE.exec(head);
          if (role && role[1] === 'assistant') {
            meta.assistantMsgs++;
            if (curModel) assistantByModel[curModel] = (assistantByModel[curModel] || 0) + 1;
            return;
          }
          if (role && role[1] !== 'user') return;
        } else if (CALL_TYPES.has(h.ptype)) {
          const nm = NAME_RE.exec(head);
          if (nm || h.ptype !== 'function_call' && h.ptype !== 'custom_tool_call') {
            const ns = NAMESPACE_RE.exec(head);
            meta.toolCalls++;
            const name = toolNameOf({ type: h.ptype, name: nm ? nm[1] : '', namespace: ns ? ns[1] : '' });
            meta.tools[name] = (meta.tools[name] || 0) + 1;
            return;
          }
        } else {
          return; // reasoning, tool output, agent messages: nothing the index needs
        }
      } else if (h.type === 'event_msg') {
        if (h.ptype !== 'token_count' && h.ptype !== 'task_started') return;
      } else if (h.type !== 'session_meta' && h.type !== 'turn_context' && h.type !== 'token_usage_record') {
        return; // world_state, compacted, and future envelope types
      }
    }
    let obj;
    try { obj = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    if (!h && obj.timestamp) {
      const ts = tsOf(obj.timestamp);
      if (!Number.isNaN(ts)) {
        if (meta.firstTs === null || ts < meta.firstTs) meta.firstTs = ts;
        if (meta.lastTs === null || ts > meta.lastTs) meta.lastTs = ts;
      }
    }
    handle(obj);
  });

  for (const { rec, turn } of countRecs) {
    if (!turn || !recordTurns.has(turn)) meta.usageRecords.push(rec);
  }
  if (!meta.threadId) {
    const m = THREAD_ID_RE.exec(path.basename(filePath));
    if (m) meta.threadId = m[1];
  }
  // Rollouts never copy another thread's responses (a fork points at its
  // parent by offset, and the one usage line a compacted window restates is
  // skipped above), so the global dedup in buildIndex has nothing to catch
  // across files. Per-response records would only bloat the index cache:
  // dedupe within the file, then ship one record per day and model.
  const seen = new Set();
  const byDayModel = new Map();
  for (const r of meta.usageRecords) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    // models counts API responses per model, like assistant messages on
    // the Claude side
    meta.models[r.m] = (meta.models[r.m] || 0) + 1;
    const key = r.d + '|' + r.m;
    const acc = byDayModel.get(key);
    if (!acc) { byDayModel.set(key, { ...r, id: 'cx:' + meta.threadId + ':' + key }); continue; }
    acc.in += r.in; acc.out += r.out; acc.cr += r.cr; acc.w5 += r.w5; acc.w1 += r.w1;
  }
  meta.usageRecords = [...byDayModel.values()];
  // a rollout with no usage at all falls back to counting messages
  if (!seen.size) Object.assign(meta.models, assistantByModel);
  meta.title = firstPrompt;
  return meta;
}

async function listRolloutFiles() {
  const out = [];
  const canZst = !!zstdBin();
  async function walk(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) await walk(p, depth + 1); }
      else if (e.isFile() && ROLLOUT_RE.test(e.name) && (canZst || !e.name.endsWith('.zst'))) out.push(p);
    }
  }
  for (const d of CODEX_SESSION_DIRS) await walk(d, 0);
  return out;
}

// thread id -> name, from the append-only session_index.jsonl Codex keeps
// for renamed and auto-titled threads. Later lines win.
function readThreadNames() {
  const names = new Map();
  let text = '';
  try { text = fs.readFileSync(CODEX_INDEX_FILE, 'utf8'); } catch { return names; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o.id === 'string' && typeof o.thread_name === 'string' && o.thread_name.trim()) {
        names.set(o.id, o.thread_name.trim());
      }
    } catch {}
  }
  return names;
}

// Claude Code names project dirs this way ("/Users/jane/my.app" ->
// "-Users-jane-my-app"), so a repo used with both agents is one project.
function projectKey(cwd) {
  return cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : '-codex';
}

// Turn per-file metas into sessions. entries: [{ filePath, meta, size,
// mtime }]. Returns the sessions plus two main-process-only maps: each
// session's subagent threads, and filePath -> { id, isMain } for search.
function assembleCodexSessions(entries, names) {
  // One thread can surface twice: archiving moves a rollout, compression
  // rewrites it as .zst. Keep the most recently written copy.
  const byThread = new Map();
  for (const e of entries) {
    const id = e.meta && e.meta.threadId;
    if (!id || !(e.meta.userTurns > 0 || e.meta.assistantMsgs > 0)) continue;
    const prev = byThread.get(id);
    if (!prev || e.mtime > prev.mtime || (e.mtime === prev.mtime && e.filePath < prev.filePath)) {
      byThread.set(id, { ...e, id });
    }
  }

  // A subagent folds into its root thread (session_meta.session_id names
  // it), else its nearest indexed ancestor. One whose ancestors are all gone
  // stays a session of its own rather than vanishing.
  const isTop = (e) => !e.meta.subagent;
  const rootOf = (e) => {
    const root = e.meta.rootId && byThread.get(e.meta.rootId);
    if (root && isTop(root)) return root;
    let cur = e;
    for (let hops = 0; hops < 16 && cur && !isTop(cur); hops++) {
      cur = cur.meta.subagent.parentId ? byThread.get(cur.meta.subagent.parentId) : null;
    }
    return cur && isTop(cur) ? cur : null;
  };

  const toSession = (e) => {
    const { threadId, rootId, subagent, ...rest } = e.meta;
    return {
      id: e.id,
      filePath: e.filePath,
      project: projectKey(e.meta.cwd),
      projectPath: e.meta.cwd || '',
      agent: 'codex',
      ...rest,
      title: names.get(e.id) || e.meta.title,
      subagentFiles: 0,
      size: e.size,
      mtime: e.mtime,
    };
  };

  const sessions = new Map();
  const children = new Map();
  const owners = new Map();
  for (const e of byThread.values()) {
    if (isTop(e)) { sessions.set(e.id, toSession(e)); owners.set(e.filePath, { id: e.id, isMain: true }); }
  }
  for (const e of byThread.values()) {
    if (isTop(e)) continue;
    const root = rootOf(e);
    const s = root && sessions.get(root.id);
    if (!s) {
      sessions.set(e.id, toSession(e));
      owners.set(e.filePath, { id: e.id, isMain: true });
      continue;
    }
    // concat, never push: s.usageRecords is the cached meta's own array
    s.usageRecords = s.usageRecords.concat(e.meta.usageRecords || []);
    s.subagentFiles++;
    owners.set(e.filePath, { id: s.id, isMain: false });
    const sub = e.meta.subagent;
    const list = children.get(s.id) || [];
    list.push({
      id: e.id,
      filePath: e.filePath,
      // Auto-review threads all open with the same reviewer boilerplate,
      // and spawned agents often get their task over an encrypted channel,
      // so the prompt is a poor label for either.
      title: names.get(e.id) || (sub.kind === 'guardian' ? 'auto-review' : '') ||
        e.meta.title || sub.agentPath || sub.nickname || '',
      workflow: null,
      agent: 'codex',
      nickname: sub.nickname,
      role: sub.role,
      kind: sub.kind,
      size: e.size,
      mtime: e.mtime,
    });
    children.set(s.id, list);
  }
  for (const list of children.values()) list.sort((a, b) => (a.mtime - b.mtime) || a.filePath.localeCompare(b.filePath));
  return { sessions: [...sessions.values()], children, owners };
}

// ---------- full session parsing ----------

const RESULT_CAP = 16000;
const INPUT_CAP = 16000;
const capResult = (raw) => raw.length > RESULT_CAP
  ? raw.slice(0, RESULT_CAP) + `\n… [${(raw.length - RESULT_CAP).toLocaleString()} more chars]`
  : raw;

// Lines the tape never draws: snapshots of workspace state, settings,
// usage, and the UI's own echo of every item (item_completed), which
// duplicates the response items the tape is built from.
const SKIP_ON_TAPE = new Set(['world_state', 'token_usage_record', 'session_meta', 'inter_agent_communication_metadata']);
const EVENTS_ON_TAPE = new Set(['turn_aborted', 'error', 'stream_error', 'thread_goal_updated']);

async function parseCodexSession(filePath) {
  const events = [];
  const callIndex = new Map();
  let curModel = null;

  await scanLines(filePath, (buf, n) => {
    if (!buf.length) return;
    const head = buf.toString('utf8', 0, Math.min(buf.length, HEAD_BYTES));
    const h = sniff(head);
    if (h) {
      if (SKIP_ON_TAPE.has(h.type)) return;
      if (h.type === 'event_msg' && !EVENTS_ON_TAPE.has(h.ptype)) return;
      if (h.type === 'response_item' && h.ptype === 'message') {
        const role = ROLE_RE.exec(head);
        if (role && role[1] !== 'user' && role[1] !== 'assistant') return;
      }
    }
    let obj;
    try { obj = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!obj || typeof obj !== 'object') return;
    const parsedTs = tsOf(obj.timestamp);
    const ts = Number.isNaN(parsedTs) ? null : parsedTs;
    const uuid = 'L' + n;
    const p = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};

    if (obj.type === 'turn_context') { curModel = modelOfTurnContext(p) || curModel; return; }
    if (obj.type === 'compacted') { events.push({ kind: 'compact', ts, uuid }); return; }
    if (obj.type === 'event_msg') {
      if (p.type === 'turn_aborted') {
        events.push({ kind: 'system', ts, uuid, text: 'turn aborted' + (p.reason ? ': ' + p.reason : ''), level: 'warning' });
      } else if (p.type === 'error' || p.type === 'stream_error') {
        const msg = typeof p.message === 'string' ? p.message : '';
        if (msg) events.push({ kind: 'system', ts, uuid, text: msg.slice(0, 4000), level: 'error' });
      } else if (p.type === 'thread_goal_updated' && p.goal && typeof p.goal.objective === 'string') {
        events.push({ kind: 'system', ts, uuid, text: 'goal: ' + p.goal.objective.slice(0, 4000), level: 'info' });
      }
      return;
    }

    const item = itemOf(obj);
    if (!item) return;
    if (item.type === 'message') {
      if (item.role === 'user') {
        const text = userTextOf(item.content);
        const images = imagesOf(item.content);
        if (text || images.length) events.push({ kind: 'user', ts, uuid, text, images });
      } else if (item.role === 'assistant') {
        const text = outputTextOf(item.content);
        if (text.trim()) events.push({ kind: 'assistant', ts, uuid, text, model: curModel, outputTokens: null });
      }
    } else if (item.type === 'reasoning') {
      const text = reasoningTextOf(item);
      if (text) events.push({ kind: 'thinking', ts, uuid, text: text.slice(0, RESULT_CAP) });
    } else if (CALL_TYPES.has(item.type)) {
      const args = callArgsOf(item);
      let input = '';
      if (typeof args === 'string') input = args;
      else { try { input = JSON.stringify(args, null, 2) || ''; } catch {} }
      if (input.length > INPUT_CAP) input = input.slice(0, INPUT_CAP) + '\n…';
      events.push({
        kind: 'tool', ts, uuid,
        toolName: toolNameOf(item),
        toolSummary: summarizeCall(args),
        input,
        result: null, isError: item.status === 'failed',
      });
      const callId = item.call_id || item.id;
      if (callId) callIndex.set(callId, events.length - 1);
    } else if (OUTPUT_TYPES.has(item.type)) {
      const idx = callIndex.get(item.call_id);
      if (idx === undefined) return;
      const ev = events[idx];
      const out = readOutput(item.output);
      ev.result = capResult(out.text);
      ev.resultImages = out.images;
      ev.isError = ev.isError || out.isError;
      ev.resultUuid = uuid;
      if (ts && ev.ts) ev.durationMs = ts - ev.ts;
    } else if (item.type === 'agent_message') {
      const text = outputTextOf(item.content).trim();
      const route = [item.author, item.recipient].filter((x) => typeof x === 'string' && x).join(' → ');
      if (text || route) {
        events.push({ kind: 'system', ts, uuid, text: ((route ? route + ': ' : '') + text).slice(0, 4000), level: 'info' });
      }
    }
  });

  return { events, sidechainCount: 0, abandonedCount: 0, subagents: [] };
}

// ---------- search ----------

// Search admits a ripgrep hit only from lines a person would read; the
// rest (base instructions, injected AGENTS.md, workspace snapshots, the
// UI's item echo) match common words in every rollout and would bury the
// real hits. `head` is the start of the raw line.
const SEARCHABLE_ITEMS = new Set([...CALL_TYPES, ...OUTPUT_TYPES, 'message', 'reasoning', 'agent_message']);
function isSearchableHead(head) {
  const h = sniff(head);
  if (!h) return true; // pre-envelope rollouts: let the snippet pass decide
  if (h.type !== 'response_item') return false;
  if (!SEARCHABLE_ITEMS.has(h.ptype)) return false;
  if (h.ptype === 'message') {
    const role = ROLE_RE.exec(head);
    if (!role || (role[1] !== 'user' && role[1] !== 'assistant')) return false;
    // The head holds only the first block's opening, so this is the
    // prefix half of isInjectedText; the snippet pass applies all of it.
    const first = /"content":\[\{"type":"input_text","text":"([^"]{0,80})/.exec(head);
    if (role[1] === 'user' && first && (first[1].startsWith('# AGENTS.md') || CONTEXT_OPEN_RE.test(first[1]))) return false;
  }
  return true;
}

// The human-readable text of one rollout line, for search snippets.
function displayableText(obj) {
  const item = itemOf(obj);
  if (!item) return null;
  if (item.type === 'message') {
    if (item.role === 'user') return { role: 'user', text: userTextOf(item.content) };
    if (item.role === 'assistant') return { role: 'assistant', text: outputTextOf(item.content) };
    return null;
  }
  if (item.type === 'reasoning') return { role: 'thinking', text: reasoningTextOf(item) };
  if (CALL_TYPES.has(item.type)) {
    const args = callArgsOf(item);
    let text = typeof args === 'string' ? args : '';
    if (!text) { try { text = JSON.stringify(args) || ''; } catch {} }
    return { role: toolNameOf(item), text };
  }
  if (OUTPUT_TYPES.has(item.type)) return { role: 'tool result', text: readOutput(item.output).text };
  if (item.type === 'agent_message') return { role: 'agent message', text: outputTextOf(item.content) };
  return null;
}

module.exports = {
  CODEX_HOME, CODEX_SESSION_DIRS, CODEX_INDEX_FILE, CODEX_CACHE_V,
  zstdBin, scanLines, readLinesAt, listRolloutFiles, readThreadNames,
  extractCodexMeta, assembleCodexSessions, parseCodexSession,
  isSearchableHead, displayableText, isInjectedText, projectKey,
};
