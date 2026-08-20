// Built-in Claude Code commands that arrive through the same command
// wrappers as typed skills. Lives in lib/ with no node imports so the
// renderer bundle (which classifies at aggregation time) and the scanner
// share one set. The scanner records every carrier and never consults it;
// a name is a builtin if it ever arrived as a local_command line OR sits
// here. Builtins migrate between line shapes across Claude Code versions
// (/model has shipped both ways), so the set covers names regardless of
// delivery shape, and keeping it out of cached meta means it can grow
// without invalidating caches. Unobserved names are harmless.
const BUILTIN_COMMANDS = new Set([
  'add-dir', 'agents', 'bashes', 'bug', 'clear', 'compact', 'config',
  'context', 'cost', 'doctor', 'effort', 'export', 'fast', 'fork', 'help',
  'hooks', 'ide', 'init', 'install-github-app', 'login', 'logout', 'mcp',
  'memory', 'model', 'output-style', 'permissions', 'plugin', 'pr-comments',
  'release-notes', 'reload-plugins', 'reload-skills', 'remote-control',
  'rename', 'resume', 'rewind', 'skills', 'status', 'statusline',
  'terminal-setup', 'todos', 'usage', 'vim', 'workflows',
]);

module.exports = { BUILTIN_COMMANDS };
