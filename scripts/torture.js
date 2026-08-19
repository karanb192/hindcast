// Solidity battery: throw malformed / edge-case transcripts at every code path
// and assert nothing throws or hangs. Run: node scripts/torture.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSession, extractMeta, foldSubagentUsage, claimSessionSkills, BUILTIN_COMMANDS } = require('../lib/scanner');
const { search } = require('../lib/search');
const { exportSession } = require('../lib/export');
const { costOf, priceFor } = require('../lib/pricing');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hindcast-torture-'));
let pass = 0, fail = 0;
const results = [];

function j(...objs) { return objs.map((o) => JSON.stringify(o)).join('\n'); }
function writeFixture(name, content) {
  const p = path.join(DIR, name + '.jsonl');
  fs.writeFileSync(p, content);
  return p;
}
async function check(name, fn) {
  try {
    await fn();
    pass++; results.push(`  ok   ${name}`);
  } catch (e) {
    fail++; results.push(`  FAIL ${name}: ${e && e.stack ? e.stack.split('\n').slice(0,3).join(' | ') : e}`);
  }
}

// ---------- fixtures ----------
const LONG_SKILL_NAME = 'skill-' + 'x'.repeat(20000);
const FIXTURES = {
  empty: '',
  whitespace: '\n\n   \n\t\n',
  allInvalid: 'not json\n{ broken\n]]]\n',
  onlyMeta: j({ type: 'mode', mode: 'normal' }, { type: 'permission-mode', permissionMode: 'x' }),
  noUsage: j({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'hi' }] } }),
  nullContent: j({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-4-8', content: null } }),
  syntheticModel: j({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: '<synthetic>', usage: { output_tokens: 5 }, content: [{ type: 'text', text: 'x' }] } }),
  noTimestamp: j({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'x' }] } }),
  badTimestamp: j({ type: 'assistant', uuid: 'a1', timestamp: 'not-a-date', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { output_tokens: 5 }, content: [] } }),
  unknownBlocks: j({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'weird_block', foo: 1 }, { type: 'text', text: 'ok' }] } }),
  unknownLineType: j({ type: 'quantum-flux', uuid: 'z1', payload: { nested: [1, 2, 3] } }, { type: 'user', uuid: 'u1', message: { role: 'user', content: 'real' } }),
  hugeToolInput: j({ type: 'assistant', uuid: 'a1', timestamp: new Date(2026, 0, 1).toISOString(), message: { role: 'assistant', model: 'claude-opus-4-8', usage: { output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x'.repeat(200000) } }] } }),
  hugeResult: j(
    { type: 'assistant', uuid: 'a1', timestamp: new Date(2026, 0, 1).toISOString(), message: { role: 'assistant', model: 'claude-opus-4-8', usage: { output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(500000) }] } }
  ),
  orphanToolResult: j({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nonexistent', content: 'r' }] } }),
  cyclicParent: j(
    { type: 'user', uuid: 'A', parentUuid: 'B', message: { role: 'user', content: 'a' } },
    { type: 'assistant', uuid: 'B', parentUuid: 'A', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { output_tokens: 1 }, content: [{ type: 'text', text: 'b' }] } }
  ),
  staleLeafPointer: j(
    { type: 'last-prompt', leafUuid: 'ghost-does-not-exist' },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { output_tokens: 3 }, content: [{ type: 'text', text: 'hi' }] } }
  ),
  emoji: j({ type: 'user', uuid: 'u1', message: { role: 'user', content: '日本語 🎉 \u0000 null-byte and <script>alert(1)</script>' } }),
  dupMessageIds: j(
    { type: 'assistant', uuid: 'a1', timestamp: new Date(2026, 0, 1).toISOString(), message: { role: 'assistant', id: 'msg_same', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: 'part1' }] } },
    { type: 'assistant', uuid: 'a2', timestamp: new Date(2026, 0, 1).toISOString(), message: { role: 'assistant', id: 'msg_same', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }
  ),
  imageBlocks: j({ type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'see' }] } }),
  // Skill extraction: hostile Skill tool_use shapes; only s6 is well-formed.
  malformedSkillBlocks: j(
    { type: 'assistant', uuid: 'sa1', timestamp: new Date(2026, 0, 1).toISOString(), message: { role: 'assistant', id: 'msg_sk1', model: 'claude-opus-4-8', usage: { output_tokens: 1 }, content: [
      { type: 'tool_use', id: 's1', name: 'Skill', input: null },
      { type: 'tool_use', id: 's2', name: 'Skill', input: {} },
      { type: 'tool_use', id: 's3', name: 'Skill', input: { skill: 42 } },
      { type: 'tool_use', id: 's4', name: 'Skill', input: { skill: '   ' } },
      { type: 'tool_use', id: 's5', name: 'Skill' },
      { type: 'tool_use', id: 's6', name: 'Skill', input: { skill: 'real-skill' } },
    ] } },
    { type: 'assistant', uuid: 'sa2', message: { role: 'assistant', id: 'msg_sk2', model: 'claude-opus-4-8', usage: { output_tokens: 1 }, content: [
      { type: 'tool_use', id: 's7', name: 'Skill', input: { skill: 'no-timestamp-skipped' } },
    ] } }
  ),
  // Skill extraction: lines that quote or wrap command names. isMeta,
  // sidechain, compaction-summary, and mid-text quotes never count; typed
  // builtins, local_command builtins, and hostile names are recorded and
  // left to classification at aggregation time.
  skillFalsePositives: j(
    { type: 'user', uuid: 'sc1', isCompactSummary: true, timestamp: new Date(2026, 0, 2).toISOString(), message: { role: 'user', content: '<command-name>/humanizer</command-name>\n<command-message>humanizer</command-message>' } },
    { type: 'user', uuid: 'sc2', isMeta: true, timestamp: new Date(2026, 0, 2).toISOString(), message: { role: 'user', content: '<command-name>/humanizer</command-name>' } },
    { type: 'user', uuid: 'sc3', timestamp: new Date(2026, 0, 2).toISOString(), message: { role: 'user', content: 'the transcript shows <command-name>/humanizer</command-name> mid-text' } },
    { type: 'user', uuid: 'sc4', timestamp: new Date(2026, 0, 2).toISOString(), message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>fable</command-args>' } },
    { type: 'user', uuid: 'sc5', isSidechain: true, timestamp: new Date(2026, 0, 2).toISOString(), message: { role: 'user', content: '<command-name>/humanizer</command-name>' } },
    { type: 'assistant', uuid: 'sc6', isSidechain: true, timestamp: new Date(2026, 0, 2).toISOString(), message: { role: 'assistant', id: 'msg_sc6', model: 'claude-opus-4-8', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', id: 'sct1', name: 'Skill', input: { skill: 'from-a-sidechain' } }] } },
    { type: 'user', uuid: 'sc7', timestamp: new Date(2026, 0, 2).toISOString(), message: { role: 'user', content: '<command-name>(.*?)</command-name>' } },
    { type: 'user', uuid: 'u-real', timestamp: new Date(2026, 0, 2).toISOString(), message: { role: 'user', content: '<command-name>/blog-review</command-name>\n<command-message>blog-review</command-message>\n<command-args>the draft</command-args>' } },
    { type: 'user', uuid: 'u-real2', timestamp: new Date(2026, 0, 2).toISOString(), message: { role: 'user', content: '<command-message>job-apply</command-message>\n<command-name>/job-apply</command-name>' } },
    { type: 'system', subtype: 'local_command', isMeta: false, uuid: 'sc8', timestamp: new Date(2026, 0, 2).toISOString(), content: '<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>billi</command-args>' },
    { type: 'system', subtype: 'local_command', isMeta: false, uuid: 'sc9', timestamp: new Date(2026, 0, 2).toISOString(), content: '<local-command-stdout>Session renamed to: billi</local-command-stdout>' }
  ),
  // Skill extraction: a typed invocation as it lands on disk. The carrier
  // (newer writers put <command-message> FIRST) counts; the followers never
  // do: the realistic isMeta expansion, a drift-shaped isMeta line quoting
  // the wrapper verbatim, and a compaction summary quoting it mid-text.
  skillCarrierPair: j(
    { type: 'user', uuid: 'cp1', timestamp: new Date(2026, 0, 4).toISOString(), message: { role: 'user', content: '<command-message>humanizer</command-message>\n<command-name>/humanizer</command-name>' } },
    { type: 'user', uuid: 'cp2', isMeta: true, timestamp: new Date(2026, 0, 4).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /Users/x/.claude/skills/humanizer\n\n# Humanizer\nScrub outbound text.' }] } },
    { type: 'user', uuid: 'cp3', isMeta: true, timestamp: new Date(2026, 0, 4).toISOString(), message: { role: 'user', content: '<command-message>humanizer</command-message>\n<command-name>/humanizer</command-name>' } },
    { type: 'user', uuid: 'cp4', isCompactSummary: true, timestamp: new Date(2026, 0, 4).toISOString(), message: { role: 'user', content: 'This session is being continued from a previous conversation. The user ran <command-name>/humanizer</command-name> before compaction.' } }
  ),
  // Skill extraction: hostile names must stay inert data. Typed names cannot
  // carry spaces or angle brackets (the tag regex stops at both), so the
  // typed probe is scheme-shaped; the Skill tool path takes input.skill
  // verbatim, so it gets the markup, unicode, and length payloads.
  hostileSkillNames: j(
    { type: 'assistant', uuid: 'h1', timestamp: new Date(2026, 0, 5).toISOString(), message: { role: 'assistant', id: 'msg_h1', model: 'claude-opus-4-8', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', id: 'ht1', name: 'Skill', input: { skill: '<img src=x onerror=alert(1)>' } }] } },
    { type: 'assistant', uuid: 'h2', timestamp: new Date(2026, 0, 5).toISOString(), message: { role: 'assistant', id: 'msg_h2', model: 'claude-opus-4-8', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', id: 'ht2', name: 'Skill', input: { skill: '日本語スキル🎉\u0000null-byte' } }] } },
    { type: 'assistant', uuid: 'h3', timestamp: new Date(2026, 0, 5).toISOString(), message: { role: 'assistant', id: 'msg_h3', model: 'claude-opus-4-8', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', id: 'ht3', name: 'Skill', input: { skill: LONG_SKILL_NAME } }] } },
    { type: 'user', uuid: 'h4', timestamp: new Date(2026, 0, 5).toISOString(), message: { role: 'user', content: '<command-name>/javascript:alert(1)</command-name>\n<command-message>x</command-message>' } }
  ),
};

// A fork copies its parent's history verbatim (same uuids, same tool_use ids)
// and then adds new work. Used by the global-claim check below.
const SKILL_PARENT = j(
  { type: 'user', uuid: 'fu1', timestamp: new Date(2026, 0, 1).toISOString(), message: { role: 'user', content: '<command-name>/humanizer</command-name>\n<command-args></command-args>' } },
  { type: 'assistant', uuid: 'fa1', parentUuid: 'fu1', timestamp: new Date(2026, 0, 1, 1).toISOString(), message: { role: 'assistant', id: 'msg_f1', model: 'claude-opus-4-8', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', id: 'toolu_fork1', name: 'Skill', input: { skill: 'oss-launch' } }] } }
);
const SKILL_FORK = SKILL_PARENT + '\n' + j(
  { type: 'assistant', uuid: 'fb2', parentUuid: 'fa1', timestamp: new Date(2026, 0, 3).toISOString(), message: { role: 'assistant', id: 'msg_f2', model: 'claude-opus-4-8', usage: { output_tokens: 1 }, content: [{ type: 'tool_use', id: 'toolu_fork2', name: 'Skill', input: { skill: 'oss-launch' } }] } }
);

(async () => {
  // ---- parseSession + extractMeta on every fixture ----
  for (const [name, content] of Object.entries(FIXTURES)) {
    const p = writeFixture(name, content);
    await check(`parseSession(${name})`, async () => {
      const r = await parseSession(p);
      if (!r || !Array.isArray(r.events)) throw new Error('bad shape');
    });
    await check(`extractMeta(${name})`, async () => {
      const m = await extractMeta(p);
      await foldSubagentUsage(p, m);
      const { aggregateRecords } = require('../lib/scanner');
      aggregateRecords(m.usageRecords || []);
      if (typeof m.title !== 'string') throw new Error('title not string');
    });
  }

  // ---- dedup correctness: same message id counted once ----
  await check('dedup: split message id counted once', async () => {
    const m = await extractMeta(writeFixture('dup2', FIXTURES.dupMessageIds));
    const { aggregateRecords } = require('../lib/scanner');
    const agg = aggregateRecords(m.usageRecords);
    if (agg.tokens.output !== 50) throw new Error('expected 50 output (deduped), got ' + agg.tokens.output);
  });

  // ---- skill extraction ----
  await check('skills: malformed Skill blocks yield exactly one record', async () => {
    const m = await extractMeta(writeFixture('skillsMalformed', FIXTURES.malformedSkillBlocks));
    const recs = m.skillRecords || [];
    if (recs.length !== 1) throw new Error('expected 1 record, got ' + recs.length);
    if (recs[0].n !== 'real-skill' || recs[0].t !== 'claude' || recs[0].u !== 'sa1') {
      throw new Error('wrong record: ' + JSON.stringify(recs[0]));
    }
  });
  await check('skills: meta/sidechain/compaction/mid-text never count; builtins split off', async () => {
    const m = await extractMeta(writeFixture('skillsFalsePos', FIXTURES.skillFalsePositives));
    const got = (m.skillRecords || []).map((r) => r.n + '|' + r.t + '|' + r.u).join(', ');
    const want = [
      'model|user|sc4',         // typed builtin: recorded, classified at aggregation
      '(.*?)|user|sc7',         // hostile name passes through as inert data
      'blog-review|user|u-real',
      'job-apply|user|u-real2', // message-first wrapper order
      'rename|builtin|sc8',     // local_command carrier; the stdout twin sc9 must not count
    ].join(', ');
    if (got !== want) throw new Error('records mismatch:\n    got  ' + got + '\n    want ' + want);
    claimSessionSkills(m, new Set());
    if (m.skills.length !== 4 || m.builtins.rename !== 1) {
      throw new Error('claim split wrong: ' + JSON.stringify({ skills: m.skills, builtins: m.builtins }));
    }
  });
  await check('skills: forked session copies count once (global claim)', async () => {
    const parent = await extractMeta(writeFixture('skillFork1', SKILL_PARENT));
    const fork = await extractMeta(writeFixture('skillFork2', SKILL_FORK));
    if (parent.skillRecords.length !== 2) throw new Error('parent should see 2, got ' + parent.skillRecords.length);
    if (fork.skillRecords.length !== 3) throw new Error('fork should see 3 pre-claim, got ' + fork.skillRecords.length);
    const claimed = new Set();
    claimSessionSkills(parent, claimed); // oldest first, as the byAge loop walks
    claimSessionSkills(fork, claimed);
    if (parent.skills.length !== 2 || fork.skills.length !== 1 || fork.skills[0].u !== 'fb2') {
      throw new Error('fork must keep only its new invocation: ' + JSON.stringify(fork.skills));
    }
    if (fork.skillRecords !== undefined) throw new Error('raw skillRecords must not ship');
  });
  await check('skills: carrier counts once, its followers never', async () => {
    const m = await extractMeta(writeFixture('skillCarrier2', FIXTURES.skillCarrierPair));
    const recs = m.skillRecords || [];
    if (recs.length !== 1 || recs[0].n !== 'humanizer' || recs[0].t !== 'user' || recs[0].u !== 'cp1') {
      throw new Error('expected one carrier record from cp1, got ' + JSON.stringify(recs));
    }
  });
  await check('skills: hostile names pass through unmutated and claim cleanly', async () => {
    const m = await extractMeta(writeFixture('skillHostile2', FIXTURES.hostileSkillNames));
    const names = (m.skillRecords || []).map((r) => r.n);
    const want = ['<img src=x onerror=alert(1)>', '日本語スキル🎉 null-byte', LONG_SKILL_NAME, 'javascript:alert(1)'];
    if (JSON.stringify(names) !== JSON.stringify(want)) {
      throw new Error('names mutated: ' + JSON.stringify(names.map((n) => n.slice(0, 40))));
    }
    claimSessionSkills(m, new Set());
    if (m.skills.length !== 4 || m.skills[2].n.length !== LONG_SKILL_NAME.length) {
      throw new Error('claim mangled hostile names');
    }
  });
  await check('skills: duplicated line inside one file claims once', async () => {
    // Crash recovery can rewrite a line verbatim; the claim set, not the
    // per-file scan, is what keeps the count at one.
    const line = j({ type: 'user', uuid: 'dupline1', timestamp: new Date(2026, 0, 6).toISOString(), message: { role: 'user', content: '<command-name>/blog-review</command-name>\n<command-message>blog-review</command-message>' } });
    const m = await extractMeta(writeFixture('skillDupLine', line + '\n' + line));
    if ((m.skillRecords || []).length !== 2) throw new Error('both raw lines should record');
    claimSessionSkills(m, new Set());
    if (m.skills.length !== 1) throw new Error('duplicate uuid must claim once, got ' + m.skills.length);
  });
  await check('skills: global claim is a pure function of the file set', async () => {
    // Mirrors the byAge walk in buildIndex: firstTs, then filePath. A fork
    // copies its parent verbatim so both files share firstTs, and only the
    // filePath tiebreak keeps attribution identical run to run.
    const pPath = writeFixture('skillOrderB-parent', SKILL_PARENT);
    const fPath = writeFixture('skillOrderA-fork', SKILL_FORK);
    const claimAll = async (paths) => {
      const metas = [];
      for (const fp of paths) {
        const m = await extractMeta(fp);
        m.filePath = fp;
        metas.push(m);
      }
      metas.sort((a, b) =>
        ((a.firstTs || Infinity) - (b.firstTs || Infinity)) || a.filePath.localeCompare(b.filePath));
      const claimed = new Set();
      const out = {};
      for (const m of metas) {
        claimSessionSkills(m, claimed);
        out[path.basename(m.filePath, '.jsonl')] = m.skills.map((r) => r.u);
      }
      return out;
    };
    const run1 = await claimAll([pPath, fPath]);
    const run2 = await claimAll([fPath, pPath]);
    if (JSON.stringify(run1) !== JSON.stringify(run2)) {
      throw new Error('attribution depends on walk order:\n    ' + JSON.stringify(run1) + '\n    ' + JSON.stringify(run2));
    }
    const all = Object.values(run1).flat();
    if (all.length !== 3 || new Set(all).size !== 3) {
      throw new Error('each invocation must be claimed exactly once: ' + JSON.stringify(run1));
    }
  });
  await check('skills: builtins never land in s.skills; typed spellings stay classifiable', async () => {
    const m = await extractMeta(writeFixture('builtinPair', j(
      { type: 'system', subtype: 'local_command', isMeta: false, uuid: 'bp1', timestamp: new Date(2026, 0, 7).toISOString(), content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>' },
      { type: 'system', subtype: 'local_command', isMeta: false, uuid: 'bp2', timestamp: new Date(2026, 0, 7).toISOString(), content: '<local-command-stdout>Compacted</local-command-stdout>' }
    )));
    claimSessionSkills(m, new Set());
    if (m.skills.length !== 0 || m.builtins.compact !== 1) {
      throw new Error('local_command must land only in s.builtins: ' + JSON.stringify({ skills: m.skills, builtins: m.builtins }));
    }
    // Builtins the real archive delivered as plain user lines ship on
    // s.skills undistinguished; BUILTIN_COMMANDS membership is the only
    // fence keeping them out of the renderer's skill table.
    for (const n of ['model', 'compact', 'effort', 'plugin', 'login', 'context', 'mcp', 'add-dir',
      'rename', 'workflows', 'fork', 'skills', 'remote-control', 'reload-skills', 'reload-plugins']) {
      if (!BUILTIN_COMMANDS.has(n)) throw new Error('BUILTIN_COMMANDS lost "' + n + '"');
    }
  });
  await check('skills: typed command stays a visible reel event (tape jump target)', async () => {
    const r = await parseSession(writeFixture('skillTyped', SKILL_PARENT));
    const ev = r.events.find((e) => e.uuid === 'fu1');
    if (!ev || ev.kind !== 'user') throw new Error('typed command event missing from reel');
    if (ev.text !== '/humanizer') throw new Error('expected "/humanizer", got ' + JSON.stringify(ev.text));
  });

  // ---- export on adversarial events (XSS, fences, </details>, images) ----
  const advEvents = [
    { kind: 'user', ts: Date.now(), text: '<img src=x onerror=alert(1)> [x](javascript:alert(2)) **b**', images: [{ mediaType: 'image/png', data: 'AAAA' }] },
    { kind: 'assistant', ts: Date.now(), text: 'a <script>evil</script> `c` ```js\n<div>\n```' },
    { kind: 'thinking', ts: Date.now(), text: '</details> and ``` fence and <script>x</script>' },
    { kind: 'tool', ts: Date.now(), toolName: 'Bash', toolSummary: 's', input: '{"a":1}', result: 'r with ``` inside and </details>', isError: false },
    { kind: 'compact', ts: Date.now() },
    { kind: 'system', ts: Date.now(), text: 'sys\nmultiline' },
  ];
  const advMeta = { title: '<script>t</script>', id: 'abcd1234', firstTs: Date.now(), models: { 'claude-fable-5': 1 }, daily: {} };
  await check('export(md) adversarial', async () => {
    const r = exportSession(advMeta, advEvents, 'md');
    if (!r.content.includes('````')) throw new Error('long fence not used for ``` content');
  });
  await check('export(html) adversarial: no LIVE script/tag/handler/js-href', async () => {
    const h = exportSession(advMeta, advEvents, 'html').content;
    const body = h.replace(/<style>[\s\S]*?<\/style>/, ''); // ignore our own stylesheet
    // Live-danger checks only — inert escaped text like &lt;img onerror=…&gt; is safe.
    if (/<script|<iframe|<object|<embed|<svg/i.test(body)) throw new Error('live dangerous tag leaked');
    if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(body)) throw new Error('live event handler on a tag');
    if (/href=["']?\s*javascript:/i.test(body)) throw new Error('live javascript: href');
    // our own images are always safe data:image URIs; any other <img is suspicious
    if (/<img(?![^>]*\bsrc="data:image\/)/i.test(body)) throw new Error('non-data-uri <img> leaked');
  });
  await check('export empty events', async () => { exportSession(advMeta, [], 'md'); exportSession(advMeta, [], 'html'); });

  // ---- pricing edge cases ----
  await check('pricing edge cases', async () => {
    const assert = (c, msg) => { if (!c) throw new Error(msg); };
    assert(costOf('claude-opus-4-8', { in: 1e6, out: 0, cr: 0, w5: 0, w1: 0 }) === 5, 'opus input');
    assert(costOf('claude-fable-5', { in: 0, out: 1e6, cr: 0, w5: 0, w1: 0 }) === 50, 'fable output');
    assert(Math.abs(costOf('claude-opus-4-8', { in: 0, out: 0, cr: 1e6, w5: 0, w1: 0 }) - 0.5) < 1e-9, 'cache read 0.1x');
    assert(priceFor('us.anthropic.claude-opus-4-8-v1:0').input === 5, 'bedrock prefix');
    assert(priceFor('claude-3-7-sonnet-20250219').input === 3, 'legacy 3.7');
    assert(costOf('totally-unknown-model', { in: 1e6, out: 1e6, cr: 0, w5: 0, w1: 0 }) === null, 'unknown → null');
    assert(costOf('claude-opus-4-8', null) === null, 'null usage → null');
    assert(priceFor(null) === null && priceFor('') === null, 'null/empty id');
  });

  // ---- search snippet helpers via the search module against a fixture dir ----
  await check('search: 2-char guard + no-match', async () => {
    const byId = new Map();
    const r0 = await search('x', byId); // <2 chars
    if (r0.length !== 0) throw new Error('short query should return []');
    const r1 = await search('zzznomatchzzz' + Date.now(), byId);
    if (!Array.isArray(r1)) throw new Error('search must return array');
  });

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
