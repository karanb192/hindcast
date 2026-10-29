// Codex and Grok readers. These assert the failures found in the outside
// Codex PR: flag-shaped session ids, double-counted usage, zero usage when
// a rollout has no turn id, and search hits inside encrypted reasoning.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CODEX_RESUME_TEMPLATE_DEFAULT, GROK_RESUME_TEMPLATE_DEFAULT, buildResumeCmd } = require('../lib/resume');
const {
  acceptSessionId, codexDisplayText, extractCodexMeta, assembleCodexSessions, projectKeyFromCwd,
} = require('../lib/codex');
const { grokDisplayText, extractGrokMeta } = require('../lib/grok');
const { claimSessionIds } = require('../lib/scanner');
const { search } = require('../lib/search');
const { exportSession } = require('../lib/export');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hindcast-agents-'));
let fail = 0;
function check(name, cond, extra) {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) fail++;
}
function write(name, lines) {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return p;
}
const UUID = '01a1299e-e451-7013-abb2-015473bbe9b8';
const UUID2 = '01a15e6c-d5ef-71e1-91f0-1e61f65dfb4e';

function env(type, payload, timestamp) {
  return { timestamp, type, payload };
}
function countLine(ts, lastOut, totalOut) {
  return env('event_msg', {
    type: 'token_count',
    info: {
      last_token_usage: { input_tokens: 1, output_tokens: lastOut, cached_input_tokens: 0 },
      total_token_usage: { input_tokens: 1, output_tokens: totalOut, cached_input_tokens: 0 },
    },
  }, ts);
}

(async () => {
  const id = '01a1299e-e451-7013-abb2-015473bbe9b8';
  check('project key matches Claude directory name',
    projectKeyFromCwd('/Users/karanbansal/100x-karan/open-source') === '-Users-karanbansal-100x-karan-open-source');
  check('flag-shaped id is rejected', acceptSessionId('--dangerously-bypass-approvals-and-sandbox', 'x') === null);
  check('filename id is used when the file claims a flag',
    acceptSessionId('--dangerously-bypass-approvals-and-sandbox',
      `rollout-2026-01-01T00-00-00-${id}.jsonl`) === id);
  check('codex resume puts -- before the id',
    buildResumeCmd(CODEX_RESUME_TEMPLATE_DEFAULT, '/tmp/x', id) === `cd -- '/tmp/x' && codex resume -- '${id}'`);
  check('grok resume quotes the id',
    buildResumeCmd(GROK_RESUME_TEMPLATE_DEFAULT, '/tmp/x', id) === `cd -- '/tmp/x' && grok --resume '${id}'`);

  const noTurn = write(`rollout-2026-01-02T00-00-00-${id}.jsonl`, [
    env('session_meta', { id, cwd: '/tmp/proj' }, '2026-01-02T00:00:00.000Z'),
    env('turn_context', { model: 'gpt-5.4', cwd: '/tmp/proj' }, '2026-01-02T00:00:01.000Z'),
    countLine('2026-01-02T00:00:02.000Z', 10, 10),
  ]);
  const meta1 = await extractCodexMeta(noTurn);
  const out1 = meta1.usageRecords.reduce((n, r) => n + r.out, 0);
  check('token_count without a turn id still counts', out1 === 10, String(out1));

  const doubled = write(`rollout-2026-01-03T00-00-00-${id}.jsonl`, [
    env('session_meta', { id, cwd: '/tmp/proj' }, '2026-01-03T00:00:00.000Z'),
    env('turn_context', { model: 'gpt-5.4' }, '2026-01-03T00:00:01.000Z'),
    env('token_usage_record', { response_id: 'resp-1', usage: { input_tokens: 3, output_tokens: 10, cached_input_tokens: 1 } }, '2026-01-03T00:00:02.000Z'),
    countLine('2026-01-03T00:00:02.000Z', 10, 10),
  ]);
  const meta2 = await extractCodexMeta(doubled);
  const out2 = meta2.usageRecords.reduce((n, r) => n + r.out, 0);
  check('a usage record suppresses the matching token_count', out2 === 10, String(out2));

  const withCache = write(`rollout-2026-01-06T00-00-00-${id}.jsonl`, [
    env('session_meta', { id, cwd: '/tmp/proj' }, '2026-01-06T00:00:00.000Z'),
    env('token_usage_record', {
      response_id: 'resp-c',
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 1 },
    }, '2026-01-06T00:00:01.000Z'),
  ]);
  const metaCache = await extractCodexMeta(withCache);
  check('cached prompt tokens are not also counted as input',
    metaCache.usageRecords[0].in === 6 && metaCache.usageRecords[0].cr === 4,
    JSON.stringify(metaCache.usageRecords[0]));

  const born = '2026-01-04T00:00:00.000Z';
  const child = write(`rollout-2026-01-04T00-00-00-${UUID2}.jsonl`, [
    env('session_meta', { id: UUID2, cwd: '/tmp/proj', forked_from_id: id }, born),
    env('turn_context', { model: 'gpt-5.4' }, born),
    countLine(born, 100, 100),
    countLine('2026-01-04T00:00:05.000Z', 5, 105),
  ]);
  const meta3 = await extractCodexMeta(child);
  const out3 = meta3.usageRecords.reduce((n, r) => n + r.out, 0);
  check('inherited usage is not counted again on a restatement', out3 === 5, String(out3));

  const hidden = {
    type: 'response_item',
    payload: { type: 'reasoning', encrypted_content: 'needle-secret', summary: [] },
  };
  const visible = {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'needle visible' }] },
  };
  const injected = {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\nneedle secret\n</environment_context>' }] },
  };
  check('encrypted reasoning is not searchable text', codexDisplayText(hidden) === null);
  check('a real prompt is searchable text', codexDisplayText(visible).text === 'needle visible');
  check('injected context is not a title', codexDisplayText(injected) === null);

  const titled = write(`rollout-2026-01-05T00-00-00-${id}.jsonl`, [
    env('session_meta', { id: '--dangerously-bypass-approvals-and-sandbox', cwd: '/Users/karanbansal/100x-karan/open-source' }, '2026-01-05T00:00:00.000Z'),
    injected,
    visible,
  ]);
  // session_meta id is hostile; the filename holds the real id. The visible
  // line above is not wrapped in an envelope timestamp, so rewrite the file.
  fs.writeFileSync(titled, [
    env('session_meta', { id: '--not-an-id', cwd: '/Users/karanbansal/100x-karan/open-source' }, '2026-01-05T00:00:00.000Z'),
    { timestamp: '2026-01-05T00:00:01.000Z', type: 'response_item', payload: injected.payload },
    { timestamp: '2026-01-05T00:00:02.000Z', type: 'response_item', payload: visible.payload },
  ].map((o) => JSON.stringify(o)).join('\n'));
  const meta4 = await extractCodexMeta(titled);
  check('hostile session_meta id falls back to the filename', meta4.threadId === id, meta4.threadId);
  check('title is the person prompt, not the injected block', meta4.title === 'needle visible', meta4.title);
  check('codex project key joins the Claude row', meta4.cwd && projectKeyFromCwd(meta4.cwd) === '-Users-karanbansal-100x-karan-open-source');

  const parent = {
    filePath: '/tmp/parent.jsonl', size: 1, mtime: 1,
    meta: { threadId: id, cwd: '/tmp/proj', usageRecords: [{ id: 'cx:same', out: 4 }], subagent: null, title: 'parent' },
  };
  const sub = {
    filePath: '/tmp/child.jsonl', size: 1, mtime: 2,
    meta: {
      threadId: UUID2, cwd: '/tmp/proj', title: 'child',
      usageRecords: [{ id: 'cx:same', out: 4 }, { id: 'cx:new', out: 1 }],
      subagent: { parentId: id, nickname: 'reviewer', role: 'review' },
    },
  };
  const cachedRecords = parent.meta.usageRecords;
  const folded = assembleCodexSessions([parent, sub]);
  check('a subagent folds into its parent', folded.length === 1 && folded[0].subagents.length === 1);
  check('folded usage keeps both records for the later dedup', folded[0].usageRecords.length === 3);
  check('folding does not append into the cached record list', cachedRecords.length === 1);

  const newer = assembleCodexSessions([
    { filePath: '/old.jsonl', mtime: 1, size: 1, meta: { threadId: id, cwd: '/tmp/proj', title: 'old', usageRecords: [], subagent: null } },
    { filePath: '/new.jsonl', mtime: 9, size: 1, meta: { threadId: id, cwd: '/tmp/proj', title: 'new', usageRecords: [], subagent: null } },
  ]);
  check('the newest file wins a duplicate thread id', newer.length === 1 && newer[0].title === 'new');

  const grandId = '01a1dd44-e451-7013-abb2-015473bbe9b8';
  const chain = assembleCodexSessions([
    { filePath: '/p.jsonl', mtime: 1, size: 1, meta: { threadId: id, cwd: '/tmp/proj', title: 'p', usageRecords: [{ id: 'cx:p', out: 1 }], subagent: null } },
    { filePath: '/mid.jsonl', mtime: 2, size: 1, meta: { threadId: UUID2, cwd: '/tmp/proj', title: 'mid', usageRecords: [{ id: 'cx:mid', out: 2 }], subagent: { parentId: id } } },
    { filePath: '/grand.jsonl', mtime: 3, size: 1, meta: { threadId: grandId, cwd: '/tmp/proj', title: 'grand', usageRecords: [{ id: 'cx:grand', out: 3 }], subagent: { parentId: UUID2 } } },
  ]);
  check('a grandchild folds into the top session', chain.length === 1 && chain[0].subagents.length === 2 && chain[0].usageRecords.length === 3);

  const grokDir = path.join(DIR, 'grok');
  const sid = UUID;
  const sessionDir = path.join(grokDir, sid);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'summary.json'), JSON.stringify({
    info: { id: sid, cwd: '/tmp/proj' },
    generated_title: 'Grok title',
    created_at: '2026-02-01T00:00:00.000Z',
    updated_at: '2026-02-01T01:00:00.000Z',
    current_model_id: 'grok-4.7',
  }));
  fs.writeFileSync(path.join(sessionDir, 'usage.json'), JSON.stringify({
    session: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 2, cacheCreationTokens: 0, costUsdTicks: 87376560000, primaryModelId: 'grok-4.7' },
  }));
  fs.writeFileSync(path.join(sessionDir, 'chat_history.jsonl'), [
    { type: 'user', synthetic_reason: 'startup', content: [{ type: 'text', text: 'needle hidden' }] },
    { type: 'user', content: [{ type: 'text', text: 'needle hello' }] },
    { type: 'reasoning', summary: [], encrypted_content: 'needle secret' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'needle thinks' }] },
    { type: 'assistant', content: 'needle answer' },
  ].map((o) => JSON.stringify(o)).join('\n'));
  const gmeta = await extractGrokMeta({
    id: sid, dir: sessionDir,
    chatPath: path.join(sessionDir, 'chat_history.jsonl'),
    summaryPath: path.join(sessionDir, 'summary.json'),
    usagePath: path.join(sessionDir, 'usage.json'),
    project: '-tmp-proj', projectPath: '/tmp/proj',
  });
  check('grok tokens come from usage.json', gmeta.usageRecords[0].out === 4 && gmeta.usageRecords[0].in === 8, JSON.stringify(gmeta.usageRecords[0]));
  check('grok ticks are not copied onto the session', gmeta.costUsdTicks == null && gmeta.usageRecords[0].costUsdTicks == null);
  check('synthetic grok lines are not user turns', gmeta.userTurns === 1, String(gmeta.userTurns));
  const synth = { type: 'user', synthetic_reason: 'startup', content: [{ type: 'text', text: 'needle hidden' }] };
  const enc = { type: 'reasoning', summary: [], encrypted_content: 'needle secret' };
  check('synthetic grok text is not searchable', grokDisplayText(synth) === null);
  check('encrypted grok reasoning is not searchable', grokDisplayText(enc) === null);
  check('grok summary text is searchable', grokDisplayText({ type: 'reasoning', summary: [{ text: 'needle thinks' }] }).text.includes('needle thinks'));

  const emptyId = '01a1cc33-e451-7013-abb2-015473bbe9b8';
  const emptyDir = path.join(DIR, 'grok-empty', emptyId);
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, 'summary.json'), JSON.stringify({ info: { id: emptyId, cwd: '/tmp/proj' } }));
  fs.writeFileSync(path.join(emptyDir, 'usage.json'), JSON.stringify({ session: {} }));
  fs.writeFileSync(path.join(emptyDir, 'chat_history.jsonl'), '');
  const emptyMeta = await extractGrokMeta({
    id: emptyId, dir: emptyDir,
    chatPath: path.join(emptyDir, 'chat_history.jsonl'),
    summaryPath: path.join(emptyDir, 'summary.json'),
    usagePath: path.join(emptyDir, 'usage.json'),
    project: '-tmp-proj', projectPath: '/tmp/proj',
  });
  check('an empty grok folder is not a prompt',
    emptyMeta.events === 0 && emptyMeta.userTurns === 0 && emptyMeta.usageRecords.length === 0);

  const clash = claimSessionIds([
    { id: 'same', agent: 'codex', filePath: '/codex.jsonl' },
    { id: 'same', agent: 'claude', filePath: '/claude.jsonl' },
    { id: 'only-codex', agent: 'codex', filePath: '/other.jsonl' },
  ]);
  const kept = clash.find((s) => s.id === 'same');
  check('claude keeps an id a codex file also claims', clash.length === 2 && kept && kept.agent === 'claude');

  const exported = exportSession({ title: 'T', agent: 'codex', id: UUID, models: {}, firstTs: 0 }, [], 'md');
  check('export names a codex session', exported.content.includes('> Codex session ·'));
  const exportedClaude = exportSession({ title: 'T', id: UUID, models: {}, firstTs: 0 }, [], 'md');
  check('export still names a claude session', exportedClaude.content.includes('> Claude Code session ·'));

  const q = 'zzneedlephrase';
  const hiddenLine = {
    timestamp: '2026-03-01T00:00:00.000Z', type: 'response_item',
    payload: { type: 'reasoning', encrypted_content: q + ' hidden', summary: [] },
  };
  const visibleLine = {
    timestamp: '2026-03-01T00:00:01.000Z', type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: q + ' visible' }] },
  };
  const searchId = '01a1aa11-e451-7013-abb2-015473bbe9b8';
  const searchFile = path.join(DIR, `rollout-2026-03-01T00-00-00-${searchId}.jsonl`);
  fs.writeFileSync(searchFile, [...Array(40).fill(hiddenLine), visibleLine].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const onlyId = '01a1bb22-e451-7013-abb2-015473bbe9b8';
  const onlyFile = path.join(DIR, `rollout-2026-03-02T00-00-00-${onlyId}.jsonl`);
  fs.writeFileSync(onlyFile, Array(10).fill(hiddenLine).map((o) => JSON.stringify(o)).join('\n') + '\n');
  const byId = new Map([
    [searchId, { id: searchId, agent: 'codex', title: 'quiet', projectPath: '/tmp/proj', lastTs: 2, filePath: searchFile }],
    [onlyId, { id: onlyId, agent: 'codex', title: 'quiet', projectPath: '/tmp/proj', lastTs: 1, filePath: onlyFile }],
  ]);
  const hits = await search(q, byId, 50, { roots: [DIR] });
  const hit = hits.find((h) => h.sessionId === searchId);
  const snip = hit && hit.snippets.map((s) => s.snippet).join(' ');
  check('a visible line still matches after hidden hits', !!hit && snip.includes('visible') && !snip.includes('hidden'), snip);
  check('encrypted-only codex text is not a hit', !hits.some((h) => h.sessionId === onlyId));

  if (fail) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
