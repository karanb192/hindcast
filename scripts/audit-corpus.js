// Empirical audit: scan EVERY transcript line in ~/.claude/projects and report
// everything the parser might not handle. Usage: node scripts/audit-corpus.js
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const ROOT = path.join(os.homedir(), '.claude', 'projects');

const stats = {
  files: 0, lines: 0, badJson: 0,
  types: {},                 // line type -> count
  userContentShapes: {},     // string | array | other
  userBlockTypes: {},        // block types inside user content arrays
  assistantBlockTypes: {},   // block types inside assistant content arrays
  attachmentKinds: {},
  systemSubtypes: {},
  systemLevels: {},
  toolResultContentShapes: {}, // string | array | missing
  toolResultBlockTypes: {},    // block types inside tool_result content arrays
  orphanToolResults: 0,        // tool_result with no prior tool_use id (per file)
  unresolvedToolUses: 0,       // tool_use never answered (per file)
  summaryLines: 0,
  sidechainLines: 0,
  extraTopKeys: {},            // keys seen on message-bearing lines beyond known set
  samples: {},                 // first raw sample of each unknown thing (truncated)
};

const KNOWN_KEYS = new Set([
  'parentUuid','isSidechain','userType','cwd','sessionId','version','gitBranch',
  'type','message','uuid','timestamp','isMeta','requestId','toolUseResult',
  'attachment','snapshot','messageId','isSnapshotUpdate','leafUuid','summary',
  'mode','permissionMode','content','level','subtype','durationMs','isCompactSummary',
  'promptId','stopReason','preventedContinuation','attributionPlugin','attributionSkill',
  'hookCount','hookErrors','hookInfos','hookAdditionalContext','hasOutput','messageCount',
  'toolUseID','session_id','isApiErrorMessage','wasReset','thinkingMetadata','todos',
  'compactMetadata','logicalParentUuid','sourceToolUseID','sourceToolAgentId','slashCommand',
]);

function bump(obj, key) { obj[key] = (obj[key] || 0) + 1; }
function sample(key, raw) {
  if (!stats.samples[key]) stats.samples[key] = String(raw).slice(0, 500);
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

(async () => {
  for (const file of walk(ROOT)) {
    stats.files++;
    const toolUses = new Set();
    const answered = new Set();
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      stats.lines++;
      let o;
      try { o = JSON.parse(line); } catch { stats.badJson++; sample('badJson', line); continue; }
      bump(stats.types, o.type || '(none)');
      if (o.isSidechain) stats.sidechainLines++;
      if (o.type === 'summary') stats.summaryLines++;

      for (const k of Object.keys(o)) {
        if (!KNOWN_KEYS.has(k)) { bump(stats.extraTopKeys, k); sample('key:' + k, line); }
      }

      if (o.type === 'attachment' && o.attachment) bump(stats.attachmentKinds, o.attachment.type || '(none)');
      if (o.type === 'system') {
        bump(stats.systemSubtypes, o.subtype || '(none)');
        bump(stats.systemLevels, o.level || '(none)');
      }

      const m = o.message;
      if (o.type === 'user' && m) {
        const c = m.content;
        bump(stats.userContentShapes, typeof c === 'string' ? 'string' : Array.isArray(c) ? 'array' : typeof c);
        if (Array.isArray(c)) {
          for (const b of c) {
            const bt = (b && b.type) || '(none)';
            bump(stats.userBlockTypes, bt);
            if (bt !== 'text' && bt !== 'tool_result') sample('userBlock:' + bt, JSON.stringify(b));
            if (bt === 'tool_result') {
              const rc = b.content;
              bump(stats.toolResultContentShapes,
                rc === undefined ? 'missing' : typeof rc === 'string' ? 'string' : Array.isArray(rc) ? 'array' : typeof rc);
              if (Array.isArray(rc)) for (const rb of rc) {
                const rbt = (rb && rb.type) || '(none)';
                bump(stats.toolResultBlockTypes, rbt);
                if (rbt !== 'text') sample('resultBlock:' + rbt, JSON.stringify(rb).slice(0, 300));
              }
              if (b.tool_use_id && !toolUses.has(b.tool_use_id)) stats.orphanToolResults++;
              if (b.tool_use_id) answered.add(b.tool_use_id);
            }
          }
        }
      }
      if (o.type === 'assistant' && m && Array.isArray(m.content)) {
        for (const b of m.content) {
          const bt = (b && b.type) || '(none)';
          bump(stats.assistantBlockTypes, bt);
          if (!['text','thinking','tool_use'].includes(bt)) sample('asstBlock:' + bt, JSON.stringify(b).slice(0, 300));
          if (bt === 'tool_use' && b.id) toolUses.add(b.id);
        }
      }
    }
    for (const id of toolUses) if (!answered.has(id)) stats.unresolvedToolUses++;
  }
  console.log(JSON.stringify(stats, null, 1));
})();
