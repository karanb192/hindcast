// Solidity battery: throw malformed / edge-case transcripts at every code path
// and assert nothing throws or hangs. Run: node scripts/torture.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSession, extractMeta, foldSubagentUsage } = require('../lib/scanner');
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
};

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
