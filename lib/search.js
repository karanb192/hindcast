// Full-text search across all transcripts, powered by ripgrep.
// Three layers, merged: instant title/project matches from the index; content
// matches in main session files; content matches in subagent/workflow files,
// attributed to their parent session. Sessions are never dropped just because
// a clean snippet couldn't be extracted.
const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const { PROJECTS_DIR, cleanPrompt } = require('./scanner');

const RG_CANDIDATES = ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', 'rg'];

function findRg() {
  for (const p of RG_CANDIDATES) {
    try { if (p === 'rg' || fs.existsSync(p)) return p; } catch {}
  }
  return 'rg';
}

// Main file:  <proj>/<uuid>.jsonl
// Nested:     <proj>/<uuid>/subagents/..., <proj>/<uuid>/workflows/..., etc.
function sessionIdFromPath(filePath) {
  const m = filePath.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.jsonl$|\/)/);
  return m ? { id: m[1], isMain: m[2] === '.jsonl' } : null;
}

// Collect matches keyed by session id. Unmappable files never consume the cap.
function runRg(query, isKnownSession, maxSessions) {
  return new Promise((resolve) => {
    const args = [
      '--json', '--ignore-case', '--fixed-strings',
      '--max-count', '8',
      '--glob', '*.jsonl',
      '--no-ignore', '--hidden',
      '-e', query,
    ];
    // Raw lines are JSON, so quotes/backslashes/newlines in the query only
    // match in their escaped form: search for that spelling too.
    const jsonForm = JSON.stringify(query).slice(1, -1);
    if (jsonForm !== query) args.push('-e', jsonForm);
    args.push(PROJECTS_DIR);

    const child = spawn(findRg(), args);
    const bySession = new Map(); // sid -> { main: {file, lines[]}|null, subs: Map(file -> lines[]) }
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type !== 'match') continue;
        const file = obj.data.path.text;
        const at = sessionIdFromPath(file);
        if (!at || !isKnownSession(at.id)) continue;
        let entry = bySession.get(at.id);
        if (!entry) {
          if (bySession.size >= maxSessions) { child.kill(); continue; }
          entry = { main: null, subs: new Map() };
          bySession.set(at.id, entry);
        }
        if (at.isMain) {
          if (!entry.main) entry.main = { file, lines: [] };
          if (entry.main.lines.length < 8) entry.main.lines.push(obj.data.line_number);
        } else {
          if (!entry.subs.has(file) && entry.subs.size >= 3) continue;
          const lines = entry.subs.get(file) || [];
          if (lines.length < 4) lines.push(obj.data.line_number);
          entry.subs.set(file, lines);
        }
      }
    });
    child.on('close', () => resolve(bySession));
    child.on('error', () => resolve(bySession));
  });
}

function displayableTextFromLine(obj) {
  // Pull out only text a human saw: prompts, assistant text, thinking,
  // tool commands/results, titles.
  if (obj.type === 'ai-title' && obj.aiTitle) return { role: 'title', text: obj.aiTitle };
  if (obj.type === 'custom-title' && obj.customTitle) return { role: 'title', text: obj.customTitle };
  if (obj.type === 'summary' && obj.summary) return { role: 'title', text: obj.summary };
  if (obj.type === 'user' && obj.message && !obj.isMeta) {
    const c = obj.message.content;
    if (typeof c === 'string') return { role: 'user', text: cleanPrompt(c) };
    if (Array.isArray(c)) {
      const texts = c.filter((b) => b && b.type === 'text').map((b) => b.text);
      if (texts.length) return { role: 'user', text: cleanPrompt(texts.join('\n')) };
      const results = c.filter((b) => b && b.type === 'tool_result');
      if (results.length) {
        const t = results.map((b) => typeof b.content === 'string' ? b.content
          : Array.isArray(b.content) ? b.content.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '').join('\n');
        return { role: 'tool result', text: t };
      }
    }
  } else if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    for (const b of obj.message.content) {
      if (b && b.type === 'text' && b.text) return { role: 'assistant', text: b.text };
      if (b && b.type === 'thinking' && b.thinking) return { role: 'thinking', text: b.thinking };
      if (b && b.type === 'tool_use') {
        let s = '';
        try { s = JSON.stringify(b.input); } catch {}
        return { role: b.name || 'tool', text: s };
      }
    }
  }
  return null;
}

function makeSnippet(text, query, radius = 90) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  let snip = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snip = '…' + snip;
  if (end < text.length) snip = snip + '…';
  return snip;
}

async function readLinesAt(filePath, wantedLines) {
  const wanted = new Set(wantedLines);
  const out = new Map();
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  const maxLine = Math.max(...wantedLines);
  for await (const line of rl) {
    n++;
    if (wanted.has(n)) {
      out.set(n, line);
      if (n >= maxLine) break;
    }
  }
  rl.close();
  stream.destroy();
  return out;
}

async function snippetsFromFile(filePath, lineNumbers, query, { subagent } = {}) {
  const snippets = [];
  let lines;
  try { lines = await readLinesAt(filePath, lineNumbers); } catch { return snippets; }
  for (const [, raw] of lines) {
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    const d = displayableTextFromLine(obj);
    if (!d || !d.text) continue;
    const snip = makeSnippet(d.text, query);
    if (snip) {
      snippets.push({
        role: subagent ? `subagent · ${d.role}` : d.role,
        snippet: snip,
        uuid: subagent ? null : (obj.uuid || null),
      });
    }
    if (snippets.length >= 2) break;
  }
  return snippets;
}

async function search(query, sessionsById, maxSessions = 50) {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  const ql = q.toLowerCase();

  const results = new Map(); // sid -> { sessionId, snippets }
  const add = (sid, snips) => {
    const r = results.get(sid) || { sessionId: sid, snippets: [] };
    for (const s of snips) if (r.snippets.length < 3) r.snippets.push(s);
    results.set(sid, r);
  };

  // Layer 1: instant title / project matches from the index
  for (const [sid, s] of sessionsById) {
    if (results.size >= 20) break;
    const title = (s.title || '').toLowerCase();
    const proj = (s.projectPath || '').toLowerCase();
    if (title.includes(ql)) add(sid, [{ role: 'title', snippet: makeSnippet(s.title, q) || s.title, uuid: null }]);
    else if (proj.includes(ql)) add(sid, [{ role: 'project', snippet: s.projectPath, uuid: null }]);
  }

  // Layer 2 + 3: content matches (main files and subagent/workflow files)
  const hits = await runRg(q, (sid) => sessionsById.has(sid), maxSessions);
  for (const [sid, entry] of hits) {
    let snips = [];
    if (entry.main) {
      snips = await snippetsFromFile(entry.main.file, entry.main.lines, q);
    }
    if (snips.length < 2 && entry.subs.size) {
      for (const [file, lines] of entry.subs) {
        const subSnips = await snippetsFromFile(file, lines, q, { subagent: true });
        for (const s of subSnips) {
          if (snips.length >= 2) break;
          snips.push(s);
        }
        if (snips.length >= 2) break;
      }
    }
    if (!snips.length) {
      // The session genuinely matched: never drop it just because the match
      // sits in metadata we can't render.
      snips = [{
        role: entry.main ? 'match' : 'subagent',
        snippet: entry.main
          ? 'matches inside session data'
          : 'matches inside this session’s subagent transcripts',
        uuid: null,
      }];
    }
    add(sid, snips);
  }

  return [...results.values()].sort((a, b) => {
    const sa = sessionsById.get(a.sessionId), sb = sessionsById.get(b.sessionId);
    return ((sb && sb.lastTs) || 0) - ((sa && sa.lastTs) || 0);
  }).slice(0, 60);
}

module.exports = { search };
