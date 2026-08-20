# Security

Hindcast is a local-first app: it reads `~/.claude/projects` on your own
machine and never sends transcript data anywhere. There is no server, no
telemetry, and no network dependency beyond checking GitHub for releases.

If you find a vulnerability (for example anything that could make the app
write outside its own data directory, execute transcript content, or leak
session data), please email karanb192@gmail.com rather than opening a public
issue. You will get a reply within a few days and credit in the fix notes
unless you prefer otherwise.
