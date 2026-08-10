// Battery for lib/resume.js (issue #10): substitution correctness, then the
// quoting proven through a real zsh. Hostile cwd / session-id values must
// arrive as exactly one argv word each, with no side effect firing. The shell
// run stubs the command words with printf, so a broken quote shows up as a
// mangled printf output or as the `touch` payload's marker file existing.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RESUME_TEMPLATE_DEFAULT, shellQuote, buildResumeCmd } = require('../lib/resume');

let fails = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
  if (!cond) fails++;
};

// -- substitution --
check('default template, both values quoted, cd --',
  buildResumeCmd(RESUME_TEMPLATE_DEFAULT, '/tmp/x', 'abc-123') === "cd -- '/tmp/x' && claude --resume 'abc-123'");
check('embedded single quote escaped', buildResumeCmd('{cwd}', "/a'b", '') === "'/a'\\''b'");
check('$& in a value is not a replacement pattern', buildResumeCmd('{cwd}', '$&', 'x') === "'$&'");
check('value containing {sessionId} is not re-substituted',
  buildResumeCmd('{cwd} {sessionId}', 'a{sessionId}b', 'S') === "'a{sessionId}b' 'S'");
check('value containing {cwd} is not re-substituted',
  buildResumeCmd('{cwd} {sessionId}', 'C', 'a{cwd}b') === "'C' 'a{cwd}b'");
check('repeated placeholders each substitute',
  buildResumeCmd('{sessionId} {sessionId}', '/c', 'S') === "'S' 'S'");
check('shellQuote wraps and escapes', shellQuote("it's") === "'it'\\''s'");

// -- through a real shell --
const marker = path.join(os.tmpdir(), 'resume-cmd-test-marker-' + process.pid);
const hostileCwd = '/tmp/dir; touch ' + marker;
const hostileIds = [
  'x; touch ' + marker,
  'x && touch ' + marker,
  'x | touch ' + marker,
  'x`touch ' + marker + '`',
  'x$(touch ' + marker + ')',
  "x' ; touch " + marker + " ; '",
  'x $HOME "quoted" \\backslash *',
  'x\nnewline; touch ' + marker,
];
for (const sid of hostileIds) {
  fs.rmSync(marker, { force: true });
  const cmd = buildResumeCmd('printf %s@@%s {cwd} {sessionId}', hostileCwd, sid);
  const out = execFileSync('/bin/zsh', ['-c', cmd]).toString();
  check('single word through zsh: ' + JSON.stringify(sid.slice(0, 28)),
    out === hostileCwd + '@@' + sid, JSON.stringify(out));
  check('payload did not fire', !fs.existsSync(marker));
}
fs.rmSync(marker, { force: true });

console.log(fails ? `\n${fails} FAILURES` : '\nall green');
process.exit(fails ? 1 : 0);
