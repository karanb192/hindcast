// Scans ~/.claude/projects for session transcripts, extracts metadata,
// and parses full sessions on demand. Metadata is cached by (mtime, size).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// ---------- helpers ----------

function decodeProjectDir(name) {
  // "-Users-jane-code" -> "/Users/jane/code" (best effort; real cwd is read
  // from messages when available and overrides this).
  return name.replace(/-/g, '/');
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

function cleanPrompt(text) {
  if (!text) return '';
  let t = text;
  // Strip command wrappers and system-reminder blocks
  t = t.replace(/<command-name>[\s\S]*?<\/command-name>/g, '');
  t = t.replace(/<command-message>[\s\S]*?<\/command-message>/g, '');
  t = t.replace(/<command-args>([\s\S]*?)<\/command-args>/g, '$1');
  t = t.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  t = t.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  t = t.replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, '$ $1');
  t = t.replace(/<bash-stdout>[\s\S]*?<\/bash-stdout>/g, '');
  t = t.replace(/<bash-stderr>[\s\S]*?<\/bash-stderr>/g, '');
  return t.trim();
}

function isRealUserMessage(obj) {
  if (obj.type !== 'user' || obj.isMeta) return false;
  if (obj.isSidechain) return false;
  const c = obj.message && obj.message.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return c.some((b) => b && b.type === 'text');
  return false;
}

// ---------- skill invocations ----------

// A command carrier line holds ONLY <command-*> wrappers: <command-name>
// plus <command-message> in either order (newer Claude Code writes the
// message tag FIRST, so nothing here may anchor to the string start),
// optionally <command-args>. Requiring nothing else on the line keeps
// prompts that merely quote the tags mid-text from counting. The name
// sheds one leading slash and keeps the plugin:skill colon form; hostile
// names pass through as inert data for the renderer to escape.
const CMD_NAME_TAG_RE = /<command-name>\s*\/?([^<\s]+?)\s*<\/command-name>/;
const CMD_ARGS_TAG_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const CMD_WRAPPER_RE = /<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g;

function parseTypedCommand(rawText) {
  if (!rawText || !rawText.includes('<command-name>')) return null;
  const m = CMD_NAME_TAG_RE.exec(rawText);
  if (!m || rawText.replace(CMD_WRAPPER_RE, '').trim()) return null;
  const a = CMD_ARGS_TAG_RE.exec(rawText);
  return { name: m[1], args: a ? a[1].trim() : '' };
}

// Classification happens at aggregation time in the renderer, which shares
// this set through lib/builtin-commands.js (dependency-free, so esbuild can
// bundle it). Re-exported below for scripts that already import it from here.
const { BUILTIN_COMMANDS } = require('./builtin-commands');

// Compact per-file record: n name, t trigger ('claude' | 'user' |
// 'builtin'), u line uuid, ts epoch ms. The uuid is both the global claim
// id in buildIndex and the tape-jump target; a line missing its uuid or a
// parseable timestamp can be neither claimed nor placed in time, so it is
// dropped, the same rule pushUsageRecord applies.
function pushSkillRecord(meta, n, t, obj) {
  if (!n || !obj.uuid || !obj.timestamp) return;
  const ts = Date.parse(obj.timestamp);
  if (Number.isNaN(ts)) return;
  meta.skillRecords.push({ n, t, u: obj.uuid, ts });
}

// One session's share of the global skill claim (the byAge loop in
// buildIndex): forked and resumed files copy history verbatim, so the same
// line uuid appears in several files and the oldest session claims it.
// Builtin triggers roll into a count map; everything else ships on
// s.skills. The raw list is deleted like usageRecords; cached meta keeps
// its own full copy.
function claimSessionSkills(s, claimed) {
  const skills = [];
  const builtins = {};
  for (const r of (s.skillRecords || [])) {
    if (!r || !r.u || claimed.has(r.u)) continue;
    claimed.add(r.u);
    if (r.t === 'builtin') builtins[r.n] = (builtins[r.n] || 0) + 1;
    else skills.push(r);
  }
  s.skills = skills;
  s.builtins = builtins;
  delete s.skillRecords;
}

// Read-only inventory of installed skills, [{ name, source }]. User skills:
// entries under ~/.claude/skills/ holding a SKILL.md. Most entries are
// symlinks and dirent types describe the link itself, so the SKILL.md probe
// (which follows symlinks and absorbs broken links, stray files, and bare
// dirs) is the only reliable filter. Plugin skills: resolved through the
// installed-plugins manifest ONLY; the cache tree keeps stale versions and
// uninstalled plugins side by side and is never walked wholesale. Plugin
// commands surface through the Skill tool under the same plugin:name
// spelling, so they join the inventory too. Any unreadable entry skips
// only itself; never throws, never writes under ~/.claude/.
function listSkillInventory() {
  const out = [];
  const seen = new Set();
  const add = (name, source) => {
    if (name && !seen.has(name)) { seen.add(name); out.push({ name, source }); }
  };
  const home = os.homedir();
  const skillsDir = path.join(home, '.claude', 'skills');
  let names = [];
  try { names = fs.readdirSync(skillsDir); } catch {}
  for (const name of names) {
    if (fs.existsSync(path.join(skillsDir, name, 'SKILL.md'))) add(name, 'user');
  }
  try {
    const manifestPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const plugins = (manifest && typeof manifest.plugins === 'object' && manifest.plugins) || {};
    for (const key of Object.keys(plugins)) {
      const pluginName = String(key).split('@')[0];
      if (!pluginName || !Array.isArray(plugins[key])) continue;
      // Every install record: a plugin can be installed at several scopes.
      for (const install of plugins[key]) {
        if (!install || typeof install.installPath !== 'string' || !install.installPath) continue;
        const skillsRoot = path.join(install.installPath, 'skills');
        let subs = [];
        try { subs = fs.readdirSync(skillsRoot); } catch {}
        for (const sub of subs) {
          if (fs.existsSync(path.join(skillsRoot, sub, 'SKILL.md'))) add(pluginName + ':' + sub, 'plugin');
        }
        const commandsRoot = path.join(install.installPath, 'commands');
        let cmds = [];
        try { cmds = fs.readdirSync(commandsRoot); } catch {}
        for (const f of cmds) {
          if (f.endsWith('.md')) add(pluginName + ':' + f.slice(0, -3), 'plugin');
        }
      }
    }
  } catch {}
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------- metadata indexing ----------

// Bump when extractMeta/parseSession output shape changes, to invalidate cache.
const CACHE_V = 8;

function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Emit one compact per-message usage record onto target.usageRecords. Records
// (not pre-summed daily totals) are the cached unit so a later GLOBAL dedup
// pass can drop message ids that resumed/forked session files copy verbatim —
// the same fix ccusage applies by deduping across every file.
function pushUsageRecord(target, msgId, model, usage, timestamp) {
  if (!usage || !model || model === '<synthetic>') return;
  const day = timestamp ? dayKey(timestamp) : null;
  if (!day) return; // no timestamp → can't place it on a day; skip (rare)
  const cw = usage.cache_creation;
  const w5 = cw && (cw.ephemeral_5m_input_tokens || cw.ephemeral_1h_input_tokens)
    ? (cw.ephemeral_5m_input_tokens || 0)
    : (usage.cache_creation_input_tokens || 0);
  const w1 = cw ? (cw.ephemeral_1h_input_tokens || 0) : 0;
  target.usageRecords.push({
    id: msgId, m: model, d: day,
    in: usage.input_tokens || 0,
    out: usage.output_tokens || 0,
    cr: usage.cache_read_input_tokens || 0,
    w5, w1,
  });
}

// Roll a list of usage records into { tokens, daily } (assumes already deduped).
function aggregateRecords(records) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const daily = {};
  for (const r of records) {
    tokens.input += r.in; tokens.output += r.out;
    tokens.cacheRead += r.cr; tokens.cacheWrite += r.w5 + r.w1;
    const day = daily[r.d] || (daily[r.d] = {});
    const mu = day[r.m] || (day[r.m] = { in: 0, out: 0, cr: 0, w5: 0, w1: 0 });
    mu.in += r.in; mu.out += r.out; mu.cr += r.cr; mu.w5 += r.w5; mu.w1 += r.w1;
  }
  return { tokens, daily };
}

// Stream a subagent transcript and emit its assistant usage records into
// `target`, deduping by message id via the shared `seen` set.
async function collectFileUsage(filePath, target, seen) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'assistant' || !obj.message) continue;
    const m = obj.message;
    const mid = m.id || obj.requestId || obj.uuid;
    if (seen.has(mid)) continue;
    seen.add(mid);
    pushUsageRecord(target, mid, m.model, m.usage, obj.timestamp);
  }
}

// Recursively find agent-*.jsonl under <sessionDir>/subagents (incl. workflows/)
async function walkSubagentFiles(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...await walkSubagentFiles(p));
    else if (e.isFile() && /^agent-[a-z0-9]+\.jsonl$/.test(e.name)) files.push(p);
  }
  return files;
}

async function extractMeta(filePath) {
  let aiTitle = '', customTitle = '', firstPrompt = '';
  // One API response is written as several assistant lines (one content block
  // each), all carrying the same message id AND the same usage object — count
  // usage/models/messages once per message id or tokens double-count.
  const seenMsgIds = new Set();
  const meta = {
    title: '',
    firstTs: null,
    lastTs: null,
    cwd: null,
    gitBranch: null,
    version: null,
    models: {},          // model -> assistant message count
    userTurns: 0,
    assistantMsgs: 0,
    toolCalls: 0,
    tools: {},           // tool name -> count
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 'YYYY-MM-DD' -> modelId -> {in, out, cr, w5, w1} — feeds the Ledger.
    // Filled by the global dedup assembly in buildIndex, not inline.
    daily: {},
    // per-message usage, deduped within this session; global dedup happens later
    usageRecords: [],
    // skill invocations seen in this file: { n, t, u, ts } per
    // pushSkillRecord. Builtins are recorded, never filtered, so the cached
    // meta stays classification-free. Deduped globally in buildIndex,
    // exactly like usageRecords.
    skillRecords: [],
    sidechainEvents: 0,
    events: 0,
  };

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    meta.events++;

    // Claude Code writes explicit titles: user-set custom-title wins over ai-title.
    if (obj.type === 'custom-title' && obj.customTitle) customTitle = obj.customTitle;
    else if (obj.type === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle;
    else if (obj.type === 'summary' && obj.summary && !aiTitle) aiTitle = obj.summary;

    if (obj.timestamp) {
      const ts = Date.parse(obj.timestamp);
      if (!Number.isNaN(ts)) {
        if (meta.firstTs === null || ts < meta.firstTs) meta.firstTs = ts;
        if (meta.lastTs === null || ts > meta.lastTs) meta.lastTs = ts;
      }
    }
    if (!meta.cwd && obj.cwd) meta.cwd = obj.cwd;
    if (!meta.gitBranch && obj.gitBranch) meta.gitBranch = obj.gitBranch;
    if (!meta.version && obj.version) meta.version = obj.version;

    // Inline (old-style) subagent events: count their usage/models for cost,
    // but not toward the main thread's prompt/tool/message stats.
    if (obj.isSidechain) {
      meta.sidechainEvents++;
      if (obj.type === 'assistant' && obj.message) {
        const m = obj.message;
        const mid = m.id || obj.requestId || obj.uuid;
        if (!seenMsgIds.has(mid)) {
          seenMsgIds.add(mid);
          if (m.model && m.model !== '<synthetic>' && m.usage) {
            meta.models[m.model] = (meta.models[m.model] || 0) + 1;
            pushUsageRecord(meta, mid, m.model, m.usage, obj.timestamp);
          }
        }
      }
      continue;
    }

    if (isRealUserMessage(obj)) {
      const raw = textOfContent(obj.message.content);
      // Typed invocation, read off the RAW text: cleanPrompt strips the
      // wrappers. Compaction summaries quote conversation text verbatim
      // and must never count.
      if (!obj.isCompactSummary) {
        const cmd = parseTypedCommand(raw);
        if (cmd) pushSkillRecord(meta, cmd.name, 'user', obj);
      }
      const text = cleanPrompt(raw);
      if (text) {
        meta.userTurns++;
        if (!firstPrompt) firstPrompt = text.slice(0, 200);
      }
    } else if (obj.type === 'assistant' && obj.message) {
      const m = obj.message;
      const mid = m.id || obj.requestId || obj.uuid;
      if (!seenMsgIds.has(mid)) {
        seenMsgIds.add(mid);
        meta.assistantMsgs++;
        if (m.model && m.model !== '<synthetic>') {
          meta.models[m.model] = (meta.models[m.model] || 0) + 1;
        }
        pushUsageRecord(meta, mid, m.model, m.usage, obj.timestamp);
      }
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block && block.type === 'tool_use') {
            meta.toolCalls++;
            const name = block.name || 'unknown';
            meta.tools[name] = (meta.tools[name] || 0) + 1;
            // Claude-invoked skill. Sidechain lines never reach this branch
            // (the isSidechain block above continues first), so subagent
            // invocations are excluded by construction. Deliberately NOT
            // under the seenMsgIds guard: tool_use blocks land one per
            // line, and dedup is global by line uuid in buildIndex.
            if (name === 'Skill') {
              const skill = block.input && typeof block.input.skill === 'string'
                ? block.input.skill.trim() : '';
              pushSkillRecord(meta, skill, 'claude', obj);
            }
          }
        }
      }
    } else if (obj.type === 'system' && obj.subtype === 'local_command'
        && typeof obj.content === 'string') {
      // Builtin command. Each one writes a PAIR of local_command lines; the
      // stdout twin carries <local-command-stdout> and no <command-name>,
      // so the carrier test keeps it from double-counting.
      const cmd = parseTypedCommand(obj.content);
      if (cmd) pushSkillRecord(meta, cmd.name, 'builtin', obj);
    }
  }

  // Separate-file subagents (workflow-orchestrated): fold their spend in too.
  meta._seen = seenMsgIds; // shared with the subagent pass in buildIndex
  meta.title = customTitle || aiTitle || firstPrompt;
  return meta;
}

// Add subagent-transcript usage to a session's meta (main thread already counted)
async function foldSubagentUsage(sessionFilePath, meta) {
  const subDir = path.join(sessionFilePath.replace(/\.jsonl$/, ''), 'subagents');
  const files = await walkSubagentFiles(subDir);
  const seen = meta._seen || new Set();
  for (const f of files) {
    try { await collectFileUsage(f, meta, seen); } catch {}
  }
  meta.subagentFiles = files.length;
  delete meta._seen;
}

async function buildIndex(cache, onProgress) {
  // Installed-skill inventory: read-only, once per build, rides the index
  // payload so the Skills panel renders with zero file IO.
  const skillInventory = listSkillInventory();
  let dirents;
  try {
    dirents = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { projects: [], sessions: [], skillInventory };
  }

  const files = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const projDir = path.join(PROJECTS_DIR, d.name);
    let inner;
    try { inner = await fsp.readdir(projDir, { withFileTypes: true }); } catch { continue; }
    for (const f of inner) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        files.push({ project: d.name, filePath: path.join(projDir, f.name) });
      }
    }
  }

  const sessions = [];
  let done = 0;
  let parsed = 0; // cache misses actually re-parsed; lets the caller tell a routine rescan from a bulk one
  const CONCURRENCY = 8;
  let cursor = 0;

  async function worker() {
    while (cursor < files.length) {
      const i = cursor++;
      const { project, filePath } = files[i];
      let stat;
      try { stat = await fsp.stat(filePath); } catch { done++; continue; }
      const key = filePath;
      const cached = cache.entries[key];
      let meta;
      if (cached && cached.v === CACHE_V && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
        meta = cached.meta;
      } else {
        parsed++;
        try {
          meta = await extractMeta(filePath);
          await foldSubagentUsage(filePath, meta);
        } catch { done++; continue; }
        cache.entries[key] = { mtime: stat.mtimeMs, size: stat.size, v: CACHE_V, meta };
        cache.dirty = true;
      }
      done++;
      if (meta.events > 0 && (meta.userTurns > 0 || meta.assistantMsgs > 0)) {
        sessions.push({
          id: path.basename(filePath, '.jsonl'),
          filePath,
          project,
          projectPath: meta.cwd || decodeProjectDir(project),
          ...meta,
          // stat fields last so no future meta key (or poisoned cache entry)
          // can shadow the values the quiet-rescan signature depends on
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      }
      if (onProgress && (done % 40 === 0 || done === files.length)) {
        onProgress({ done, total: files.length, parsed });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ── Global usage dedup ────────────────────────────────────────────────
  // A resumed/forked session file copies its parent's history verbatim — same
  // assistant message ids, same usage. Counting each session's records in
  // isolation double-counts that shared prefix. Walk sessions oldest-first so
  // the original owns each message id; a fork then contributes only its NEW
  // work. Daily/Ledger totals are attribution-independent (each message keeps
  // its own timestamp), so this makes cost correct regardless of order.
  const claimedMsgIds = new Set();
  // Skill invocations ride the same walk with their own claimed set, keyed
  // by line uuid: forks copy the invocation lines verbatim too.
  const claimedSkillUuids = new Set();
  // filePath tiebreak: forked sessions copy history verbatim and share an
  // identical firstTs with their parent, and JS stable sort would otherwise
  // fall back to insertion order, which is the completion order of concurrent
  // parse workers and jitters run to run. Dedup claiming must be a pure
  // function of the file set or the quiet-rescan signature in main.js lies.
  const byAge = [...sessions].sort((a, b) =>
    ((a.firstTs || Infinity) - (b.firstTs || Infinity)) || a.filePath.localeCompare(b.filePath));
  for (const s of byAge) {
    const kept = [];
    for (const r of (s.usageRecords || [])) {
      if (claimedMsgIds.has(r.id)) continue;
      claimedMsgIds.add(r.id);
      kept.push(r);
    }
    const { tokens, daily } = aggregateRecords(kept);
    s.tokens = tokens;
    s.daily = daily;
    delete s.usageRecords; // don't ship raw records to the renderer
    claimSessionSkills(s, claimedSkillUuids);
  }

  sessions.sort((a, b) => ((b.lastTs || 0) - (a.lastTs || 0)) || a.filePath.localeCompare(b.filePath));

  const projMap = new Map();
  for (const s of sessions) {
    const key = s.project;
    if (!projMap.has(key)) {
      projMap.set(key, {
        id: key,
        path: s.projectPath,
        name: path.basename(s.projectPath || key) || key,
        sessions: 0, lastTs: 0, tokens: 0,
      });
    }
    const p = projMap.get(key);
    p.sessions++;
    p.lastTs = Math.max(p.lastTs, s.lastTs || 0);
    p.tokens += (s.tokens.output || 0);
  }
  const projects = [...projMap.values()].sort((a, b) => b.lastTs - a.lastTs);

  // Disambiguate duplicate basenames ("test" vs "trip-planning/test")
  const nameCount = {};
  for (const p of projects) nameCount[p.name] = (nameCount[p.name] || 0) + 1;
  for (const p of projects) {
    if (nameCount[p.name] > 1) {
      const parts = (p.path || '').split('/').filter(Boolean);
      if (parts.length >= 2) p.name = parts.slice(-2).join('/');
    }
  }

  return { projects, sessions, skillInventory };
}

// ---------- full session parsing ----------

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Bash': return input.description || input.command || '';
    case 'Read': return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Edit': return input.file_path || '';
    case 'Glob': case 'Grep': return input.pattern || '';
    case 'Agent': case 'Task': return input.description || '';
    case 'WebFetch': case 'WebSearch': return input.url || input.query || '';
    case 'Skill': return input.skill || '';
    default: {
      const firstStr = Object.values(input).find((v) => typeof v === 'string');
      return firstStr ? String(firstStr).slice(0, 200) : '';
    }
  }
}

function extractResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!c) return '';
        if (c.type === 'text') return c.text;
        if (c.type === 'tool_reference') return `⟨tool: ${c.tool_name || 'unknown'}⟩`;
        if (c.type === 'document') return '⟨attached document⟩';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const MAX_IMAGES = 8;
function extractImages(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (b && b.type === 'image' && b.source && b.source.type === 'base64' && b.source.data) {
      if (out.length < MAX_IMAGES) {
        out.push({ mediaType: b.source.media_type || 'image/png', data: b.source.data });
      }
    }
  }
  return out;
}

const RESULT_CAP = 16000;
const INPUT_CAP = 16000;

async function parseSession(filePath, opts = {}) {
  const includeSidechain = !!opts.includeSidechain; // subagent files are all-sidechain
  const events = [];
  const toolIndexById = new Map();
  let sidechainCount = 0;
  let abandonedCount = 0;

  // Pass 1: read all lines. Transcripts are trees (rewinds fork branches via
  // parentUuid); the live conversation is the chain from the last message up
  // to the root. Everything off that chain is an abandoned branch.
  const objs = [];
  {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try { objs.push(JSON.parse(line)); } catch {}
    }
  }

  const parentOf = new Map();
  let leaf = null;
  let declaredLeaf = null; // last-prompt lines carry leafUuid, the official branch tip
  for (const o of objs) {
    if (o.type === 'last-prompt' && o.leafUuid) declaredLeaf = o.leafUuid;
    if ((o.isSidechain && !includeSidechain) || !o.uuid) continue;
    parentOf.set(o.uuid, o.parentUuid || null);
    if (o.type === 'user' || o.type === 'assistant' || o.type === 'system' || o.type === 'attachment') {
      leaf = o.uuid;
    }
  }
  // Prefer the declared tip when it points at a message we actually have —
  // but only if it is not an ancestor of the fallback leaf (a stale marker
  // from before the latest turns would truncate the live conversation).
  if (declaredLeaf && parentOf.has(declaredLeaf)) {
    let isAncestorOfLeaf = false;
    const seen = new Set();
    for (let u = parentOf.get(leaf); u != null && !seen.has(u); u = parentOf.get(u)) {
      seen.add(u);
      if (u === declaredLeaf) { isAncestorOfLeaf = true; break; }
    }
    if (!isAncestorOfLeaf) leaf = declaredLeaf;
  }
  const onChain = new Set();
  for (let u = leaf; u != null && !onChain.has(u); u = parentOf.get(u)) onChain.add(u);

  for (const obj of objs) {
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;

    if (obj.isSidechain && !includeSidechain) { sidechainCount++; continue; }
    if (obj.uuid && (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'system') && !onChain.has(obj.uuid)) {
      abandonedCount++;
      continue;
    }

    if (obj.type === 'user' && obj.message) {
      const c = obj.message.content;
      // Tool results arrive as user messages
      if (Array.isArray(c)) {
        for (const block of c) {
          if (block && block.type === 'tool_result') {
            const idx = toolIndexById.get(block.tool_use_id);
            if (idx !== undefined) {
              const raw = extractResultText(block.content);
              events[idx].result = raw.length > RESULT_CAP
                ? raw.slice(0, RESULT_CAP) + `\n… [${(raw.length - RESULT_CAP).toLocaleString()} more chars]`
                : raw;
              events[idx].resultImages = extractImages(block.content);
              events[idx].isError = !!block.is_error;
              events[idx].resultUuid = obj.uuid; // search hits inside results carry this line's uuid
              if (ts && events[idx].ts) events[idx].durationMs = ts - events[idx].ts;
            }
          }
        }
      }
      if (obj.isMeta) continue;
      const raw = textOfContent(c);
      // Typed slash commands: show them as "/name args" instead of letting
      // cleanPrompt strip the wrapper to nothing. This keeps the invocation
      // event on the reel, which the Skills panel's tape jump lands on.
      let text;
      const cmd = obj.isCompactSummary ? null : parseTypedCommand(raw);
      if (cmd) {
        text = '/' + cmd.name + (cmd.args ? ' ' + cmd.args : '');
      } else {
        text = cleanPrompt(raw);
      }
      const images = extractImages(c);
      if (text || images.length) {
        events.push({ kind: 'user', ts, uuid: obj.uuid, text, images });
      }
    } else if (obj.type === 'assistant' && obj.message) {
      const m = obj.message;
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (!block) continue;
        if (block.type === 'thinking' && block.thinking) {
          events.push({ kind: 'thinking', ts, uuid: obj.uuid, text: String(block.thinking).slice(0, RESULT_CAP) });
        } else if (block.type === 'text' && block.text && block.text.trim()) {
          events.push({
            kind: 'assistant', ts, uuid: obj.uuid, text: block.text,
            model: m.model !== '<synthetic>' ? m.model : null,
            outputTokens: m.usage ? m.usage.output_tokens : null,
          });
        } else if (block.type === 'tool_use') {
          let inputStr = '';
          try { inputStr = JSON.stringify(block.input, null, 2); } catch {}
          if (inputStr.length > INPUT_CAP) inputStr = inputStr.slice(0, INPUT_CAP) + '\n…';
          events.push({
            kind: 'tool', ts, uuid: obj.uuid,
            toolName: block.name || 'unknown',
            toolSummary: summarizeToolInput(block.name, block.input),
            input: inputStr,
            result: null, isError: false,
          });
          toolIndexById.set(block.id, events.length - 1);
        } else if (block.type === 'fallback' && block.from && block.to) {
          events.push({
            kind: 'system', ts, uuid: obj.uuid,
            text: `model fallback: ${block.from.model} → ${block.to.model}`, level: 'warning',
          });
        }
      }
    } else if (obj.type === 'system' && !obj.isMeta) {
      if (obj.subtype === 'compact_boundary') {
        events.push({ kind: 'compact', ts, uuid: obj.uuid });
        continue;
      }
      if (obj.subtype === 'turn_duration') continue; // bookkeeping noise
      const text = typeof obj.content === 'string' ? obj.content : '';
      if (text && obj.level !== 'suppressed') {
        const level = obj.subtype === 'api_error' ? 'error' : (obj.level || 'info');
        events.push({ kind: 'system', ts, uuid: obj.uuid, text: text.slice(0, 4000), level });
      }
    }
  }

  const subagents = opts.skipSubagents ? [] : await listSubagents(filePath);
  return { events, sidechainCount, abandonedCount, subagents };
}

// Subagent transcripts live in <sessionDir>/subagents/agent-<id>.jsonl and,
// for workflow-orchestrated runs, in <sessionDir>/subagents/workflows/wf_*/agent-<id>.jsonl
const MAX_SUBAGENT_TITLE_READS = 300; // cap the per-file title reads for huge workflow sessions
async function listSubagents(sessionFilePath) {
  const dir = path.join(sessionFilePath.replace(/\.jsonl$/, ''), 'subagents');
  const files = await walkSubagentFiles(dir);
  const out = [];
  // Read titles for the newest N so a 2000-agent session stays responsive.
  const stats = await Promise.all(files.map(async (fp) => {
    try { const st = await fsp.stat(fp); return { fp, mtime: st.mtimeMs, size: st.size }; }
    catch { return null; }
  }));
  const valid = stats.filter(Boolean).sort((a, b) => a.mtime - b.mtime);
  const titled = valid.slice(-MAX_SUBAGENT_TITLE_READS);
  const readTitle = new Set(titled.map((s) => s.fp));

  for (const s of valid) {
    const m = path.basename(s.fp).match(/^agent-([a-z0-9]+)\.jsonl$/);
    if (!m) continue;
    const wf = s.fp.match(/\/workflows\/(wf_[a-z0-9-]+)\//);
    let title = '';
    if (readTitle.has(s.fp)) {
      try {
        const fd = await fsp.open(s.fp, 'r');
        const { buffer, bytesRead } = await fd.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
        await fd.close();
        for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
          try {
            const o = JSON.parse(line);
            if (o.type === 'user' && o.message) {
              title = cleanPrompt(textOfContent(o.message.content)).slice(0, 140);
              if (title) break;
            }
          } catch {}
        }
      } catch {}
    }
    out.push({ id: m[1], filePath: s.fp, title, workflow: wf ? wf[1] : null, size: s.size, mtime: s.mtime });
  }
  return out;
}

module.exports = {
  PROJECTS_DIR, buildIndex, parseSession, listSubagents, cleanPrompt,
  extractMeta, foldSubagentUsage, aggregateRecords,
  claimSessionSkills, listSkillInventory, parseTypedCommand, BUILTIN_COMMANDS,
};
