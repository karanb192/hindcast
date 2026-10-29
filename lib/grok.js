// Reads Grok sessions under ~/.grok/sessions/<percent-encoded cwd>/<id>/.
// costUsdTicks is not shown as dollars. The tick scale is not confirmed.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { forEachLine } = require('./lines');
const { projectKeyFromCwd } = require('./project-key');
const { SESSION_ID_RE } = require('./codex');

const GROK_CACHE_V = 1;
const SESSIONS_DIR = path.join(os.homedir(), '.grok', 'sessions');
const TEXT_CAP = 16000;

function clip(text) {
  const s = String(text || '');
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + `\n… [${(s.length - TEXT_CAP).toLocaleString()} more chars]` : s;
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

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function grokText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string' && c.type !== 'image')
      .map((c) => c.text)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function reasoningText(obj) {
  const s = obj.summary;
  if (typeof s === 'string') return s;
  if (Array.isArray(s)) {
    return s.map((part) => (typeof part === 'string' ? part : (part && part.text) || '')).join('\n');
  }
  return '';
}

// Search and the reel share this. Synthetic user lines and encrypted
// reasoning are not something a person typed or read.
function grokDisplayText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.synthetic_reason) return null;
  if (obj.type === 'user') {
    const text = grokText(obj.content);
    return text ? { role: 'user', text } : null;
  }
  if (obj.type === 'assistant') {
    const text = grokText(obj.content);
    return text ? { role: 'assistant', text } : null;
  }
  if (obj.type === 'reasoning') {
    const text = reasoningText(obj);
    return text ? { role: 'thinking', text } : null;
  }
  if (obj.type === 'tool_result') {
    const text = grokText(obj.content);
    return text ? { role: 'tool result', text } : null;
  }
  return null;
}

async function listGrokSessions() {
  const out = [];
  let parents;
  try { parents = await fsp.readdir(SESSIONS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const parent of parents) {
    if (!parent.isDirectory()) continue;
    let cwd = null;
    try { cwd = decodeURIComponent(parent.name); } catch { cwd = null; }
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) continue;
    const parentPath = path.join(SESSIONS_DIR, parent.name);
    let kids;
    try { kids = await fsp.readdir(parentPath, { withFileTypes: true }); } catch { continue; }
    for (const kid of kids) {
      if (!kid.isDirectory() || !SESSION_ID_RE.test(kid.name)) continue;
      const dir = path.join(parentPath, kid.name);
      out.push({
        id: kid.name.toLowerCase(),
        dir,
        chatPath: path.join(dir, 'chat_history.jsonl'),
        summaryPath: path.join(dir, 'summary.json'),
        usagePath: path.join(dir, 'usage.json'),
        project: projectKeyFromCwd(cwd),
        projectPath: cwd,
      });
    }
  }
  return out;
}

function usageRecord(id, model, sessionUsage, ms) {
  const day = dayKey(ms);
  if (!day || !sessionUsage) return null;
  // inputTokens already includes cachedReadTokens. Checked on a real
  // usage.json: input + output equals totalTokens, with cached inside input.
  const cr = sessionUsage.cachedReadTokens || 0;
  const rawIn = sessionUsage.inputTokens || 0;
  if (!rawIn && !sessionUsage.outputTokens && !cr && !sessionUsage.cacheCreationTokens) return null;
  return {
    id: 'grok:' + id,
    m: model || 'grok',
    d: day,
    in: Math.max(0, rawIn - cr),
    out: sessionUsage.outputTokens || 0,
    cr,
    w5: sessionUsage.cacheCreationTokens || 0,
    w1: 0,
  };
}

async function countChat(chatPath) {
  const counts = { userTurns: 0, assistantMsgs: 0, toolCalls: 0, events: 0 };
  try {
    await forEachLine(chatPath, (line) => {
      if (line.length > 2_000_000) {
        if (line.includes('"type":"tool_result"') || line.includes('"type": "tool_result"')) counts.toolCalls++;
        else if ((line.includes('"type":"assistant"') || line.includes('"type": "assistant"'))) counts.assistantMsgs++;
        else if ((line.includes('"type":"user"') || line.includes('"type": "user"')) && !line.includes('synthetic_reason')) counts.userTurns++;
        counts.events++;
        return;
      }
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const shown = grokDisplayText(obj);
      if (!shown) return;
      counts.events++;
      if (shown.role === 'user') counts.userTurns++;
      else if (shown.role === 'assistant') counts.assistantMsgs++;
      else if (shown.role === 'tool result') counts.toolCalls++;
    });
  } catch {}
  return counts;
}

async function extractGrokMeta(entry) {
  const summary = readJson(entry.summaryPath) || {};
  const usage = readJson(entry.usagePath) || {};
  const info = summary.info || {};
  const sessionUsage = usage.session || {};
  const model = sessionUsage.primaryModelId || summary.current_model_id || 'grok';
  const created = epoch(summary.created_at);
  const updated = epoch(summary.updated_at || summary.last_active_at || usage.updatedAt);
  const counts = await countChat(entry.chatPath);
  const rec = usageRecord(entry.id, model, sessionUsage, updated || created);
  const meta = {
    title: summary.generated_title || summary.session_summary || '',
    firstTs: created,
    lastTs: updated || created,
    cwd: info.cwd || entry.projectPath,
    gitBranch: null,
    version: null,
    models: counts.assistantMsgs > 0 || rec ? { [model]: Math.max(counts.assistantMsgs, rec ? 1 : 0) } : {},
    userTurns: counts.userTurns,
    assistantMsgs: counts.assistantMsgs,
    toolCalls: counts.toolCalls,
    tools: counts.toolCalls ? { tool: counts.toolCalls } : {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    daily: {},
    usageRecords: rec ? [rec] : [],
    skillRecords: [],
    sidechainEvents: 0,
    events: counts.events,
    threadId: entry.id,
    subagent: null,
  };
  if (!meta.title && (meta.events > 0 || rec)) {
    meta.title = 'Grok session ' + entry.id.slice(0, 8);
  }
  return meta;
}

async function parseGrokSession(filePath) {
  const events = [];
  await forEachLine(filePath, (line) => {
    if (line[0] !== '{') return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    const shown = grokDisplayText(obj);
    if (!shown) return;
    const ts = 0;
    if (shown.role === 'user') events.push({ kind: 'user', ts, text: clip(shown.text) });
    else if (shown.role === 'assistant') events.push({ kind: 'assistant', ts, text: clip(shown.text) });
    else if (shown.role === 'thinking') events.push({ kind: 'thinking', ts, text: clip(shown.text) });
    else events.push({
      kind: 'tool', ts, toolName: 'tool',
      toolSummary: clip(shown.text).slice(0, 180),
      input: '', result: clip(shown.text),
    });
  });
  return { events, sidechainCount: 0, abandonedCount: 0, subagents: [] };
}

module.exports = {
  GROK_CACHE_V, SESSIONS_DIR, grokDisplayText, listGrokSessions,
  extractGrokMeta, parseGrokSession,
};
