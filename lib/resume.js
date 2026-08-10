// The paste-into-a-terminal resume command (issue #10). Lives in lib/ so the
// renderer (via esbuild) and scripts/resume-cmd-test.js share one implementation,
// and so the default template has a single source of truth for main.js and the UI.

// `cd --` so a working directory that starts with a dash is a path, not a flag.
const RESUME_TEMPLATE_DEFAULT = 'cd -- {cwd} && claude --resume {sessionId}';
const TEMPLATE_MAX = 500;

// POSIX single-quote: closes the quote, escapes the quote char, reopens.
const shellQuote = (p) => "'" + String(p).replace(/'/g, "'\\''") + "'";

// Both values are quoted, and both come from disk: cwd is transcript-declared,
// and a session id is a *.jsonl basename, which on macOS may legally contain
// ; | $ ` and spaces. Anything that lands on the clipboard here is one paste
// away from a shell, so neither may be interpolated bare.
// Substitution is single-pass over the template, so a value that itself
// contains a placeholder (or a $-sequence special to String.replace) is
// inserted literally instead of being re-substituted.
const buildResumeCmd = (template, cwd, sessionId) => {
  const sub = { '{cwd}': shellQuote(cwd), '{sessionId}': shellQuote(sessionId) };
  return String(template).replace(/\{cwd\}|\{sessionId\}/g, (m) => sub[m]);
};

module.exports = { RESUME_TEMPLATE_DEFAULT, TEMPLATE_MAX, shellQuote, buildResumeCmd };
