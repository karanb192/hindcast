// Full-text search across all transcripts, powered by ripgrep.
// Three layers, merged: instant title/project matches from the index; content
// matches in main session files; content matches in subagent/workflow files,
// attributed to their parent session. Claude transcripts and Codex rollouts
// are searched by two concurrent ripgrep runs. Sessions are never dropped
// just because a clean snippet couldn't be extracted.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { PROJECTS_DIR, cleanPrompt } = require('./scanner');
const codex = require('./codex');

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

// Read path, line number, and the head of the matched line out of one rg
// --json event without parsing it whole: rg prints every matched line in
// full, and a Codex line can run to megabytes. Returns null for non-match
// events and for lines rg could only print as bytes.
function peekMatch(raw) {
  if (!raw.startsWith('{"type":"match"')) return null;
  const p0 = raw.indexOf('"path":{"text":"');
  if (p0 < 0) return null;
  let i = p0 + 15;
  for (let j = i + 1; j < raw.length; j++) {
    if (raw[j] === '\\') { j++; continue; }
    if (raw[j] === '"') { i = j; break; }
  }
  let file;
  try { file = JSON.parse(raw.slice(p0 + 15, i + 1)); } catch { return null; }
  // Keys after the line text are rg's own, and any quote inside the text is
  // escaped, so the last unescaped "line_number" key is the real one.
  const ln = raw.lastIndexOf('"line_number":');
  const lineNumber = ln < 0 ? NaN : parseInt(raw.slice(ln + 14, ln + 30), 10);
  if (!Number.isFinite(lineNumber)) return null;
  const t0 = raw.indexOf('"lines":{"text":"', i);
  const head = t0 < 0 ? '' : raw.slice(t0 + 17, t0 + 17 + 700).replace(/\\"/g, '"');
  return { file, lineNumber, head };
}

// Collect matches keyed by session id. Unmappable files never consume the
// cap, and neither do lines `admit` rejects.
// opts: { roots, globs, maxCount, zip, locate(file) -> {id, isMain}|null, admit(head) }
function runRg(query, opts, isKnownSession, maxSessions) {
  return new Promise((resolve) => {
    const bySession = new Map(); // sid -> { main: {file, lines[]}|null, subs: Map(file -> lines[]) }
    const roots = opts.roots.filter((r) => { try { return fs.existsSync(r); } catch { return false; } });
    if (!roots.length) { resolve(bySession); return; }
    const args = [
      '--json', '--ignore-case', '--fixed-strings',
      '--max-count', String(opts.maxCount),
      '--no-ignore', '--hidden',
    ];
    for (const g of opts.globs) args.push('--glob', g);
    if (opts.zip) args.push('--search-zip');
    args.push('-e', query);
    // Raw lines are JSON, so quotes/backslashes/newlines in the query only
    // match in their escaped form: search for that spelling too.
    const jsonForm = JSON.stringify(query).slice(1, -1);
    if (jsonForm !== query) args.push('-e', jsonForm);
    args.push(...roots);

    // rg runs zstd itself for --search-zip and finds it on PATH, which a
    // Finder-launched app does not have Homebrew on.
    const env = { ...process.env };
    const zstd = opts.zip ? codex.zstdBin() : null;
    if (zstd) env.PATH = path.dirname(zstd) + ':' + (env.PATH || '');
    const child = spawn(findRg(), args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    let done = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (done) return;
      buf += d;
      let start = 0;
      let nl;
      while (!done && (nl = buf.indexOf('\n', start)) >= 0) {
        const line = buf.slice(start, nl);
        start = nl + 1;
        const hit = line && peekMatch(line);
        if (!hit) continue;
        const at = opts.locate(hit.file);
        if (!at || !isKnownSession(at.id)) continue;
        if (opts.admit && !opts.admit(hit.head)) continue;
        let entry = bySession.get(at.id);
        if (!entry) {
          if (bySession.size >= maxSessions) { done = true; child.kill(); break; }
          entry = { main: null, subs: new Map() };
          bySession.set(at.id, entry);
        }
        if (at.isMain) {
          if (!entry.main) entry.main = { file: hit.file, lines: [] };
          if (entry.main.lines.length < 8) entry.main.lines.push(hit.lineNumber);
        } else {
          if (!entry.subs.has(hit.file) && entry.subs.size >= 3) continue;
          const lines = entry.subs.get(hit.file) || [];
          if (lines.length < 4) lines.push(hit.lineNumber);
          entry.subs.set(hit.file, lines);
        }
      }
      buf = done ? '' : buf.slice(start);
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

async function snippetsFromFile(filePath, lineNumbers, query, { subagent, isCodex } = {}) {
  const snippets = [];
  let lines;
  try {
    lines = isCodex ? await codex.readLinesAt(filePath, lineNumbers) : await readLinesAt(filePath, lineNumbers);
  } catch { return snippets; }
  for (const [n, raw] of lines) {
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    const d = isCodex ? codex.displayableText(obj) : displayableTextFromLine(obj);
    if (!d || !d.text) continue;
    const snip = makeSnippet(d.text, query);
    if (snip) {
      // Codex lines carry no uuid; the tape keys their events by line number.
      const uuid = isCodex ? 'L' + n : (obj.uuid || null);
      snippets.push({
        role: subagent ? `subagent · ${d.role}` : d.role,
        snippet: snip,
        uuid: subagent ? null : uuid,
      });
    }
    if (snippets.length >= 2) break;
  }
  return snippets;
}

// codexOwners: Map(filePath -> { id, isMain }) from buildIndex. Codex
// subagent rollouts are named for their own thread, not their session.
async function search(query, sessionsById, codexOwners = new Map(), maxSessions = 50) {
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
  const isKnown = (sid) => sessionsById.has(sid);
  const [claudeHits, codexHits] = await Promise.all([
    runRg(q, {
      roots: [PROJECTS_DIR], globs: ['*.jsonl'], maxCount: 8, zip: false,
      locate: sessionIdFromPath,
    }, isKnown, maxSessions),
    // A higher per-file cap: the first matches in a rollout are often the
    // injected context admit() throws away. rg applies the cap before
    // admission, so a rollout whose first 40 matches are all metadata (a
    // model name in every turn_context) can still hide a later real hit;
    // without a cap, a word found only in injected context makes rg stream
    // every copy of it from every rollout.
    runRg(q, {
      roots: codex.CODEX_SESSION_DIRS, globs: ['rollout-*.jsonl', 'rollout-*.jsonl.zst'], maxCount: 40,
      zip: !!codex.zstdBin(), locate: (f) => codexOwners.get(f) || null, admit: codex.isSearchableHead,
    }, isKnown, maxSessions),
  ]);
  const hits = [...claudeHits.entries()].map(([sid, entry]) => [sid, entry, false])
    .concat([...codexHits.entries()].map(([sid, entry]) => [sid, entry, true]));
  for (const [sid, entry, isCodex] of hits) {
    let snips = [];
    if (entry.main) {
      snips = await snippetsFromFile(entry.main.file, entry.main.lines, q, { isCodex });
    }
    if (snips.length < 2 && entry.subs.size) {
      for (const [file, lines] of entry.subs) {
        const subSnips = await snippetsFromFile(file, lines, q, { subagent: true, isCodex });
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
