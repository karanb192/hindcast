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

// Skills that ship inside Claude Code itself. They fire through the Skill
// tool like any other skill but never appear under ~/.claude/skills/ or in
// the plugin manifest, so the inventory join cannot see them; without this
// set they would read as prune candidates ("not installed"). Same
// maintenance rule as the set above: drifts with Claude Code releases,
// unobserved names are harmless, and it stays out of cached meta so it can
// grow without invalidating caches. An entry the user ALSO installs locally
// counts as installed, not bundled.
//
// Membership requires a receipt, never a guess: the Claude Code changelog
// naming the skill as bundled, the CLI binary's skill name table, or a
// transcript whose skill body extracted to tmp .../bundled-skills/<version>/.
// A wrong entry here relabels a removed user skill "bundled" and hides the
// pruning story the page exists to tell.
const BUNDLED_SKILLS = new Set([
  'artifact-capabilities', 'artifact-design', 'artifact-diagramming',
  'batch', 'claude-api', 'code-review', 'dataviz', 'deep-research',
  'fewer-permission-prompts', 'keybindings-help', 'loop', 'review',
  'schedule', 'security-review', 'simplify', 'update-config', 'workshop',
]);

module.exports = { BUILTIN_COMMANDS, BUNDLED_SKILLS };
