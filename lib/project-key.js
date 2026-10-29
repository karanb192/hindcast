// Claude Code names a project directory by replacing every non-alphanumeric
// character in the working directory with "-". "/" becomes "-", so the key
// starts with "-". Codex and Grok sessions join that same row.
function projectKeyFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

module.exports = { projectKeyFromCwd };
