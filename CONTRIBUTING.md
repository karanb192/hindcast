# Contributing to Hindcast

Thanks for your interest in Hindcast — a local-first viewer, timeline scrubber,
and cost tracker for your Claude Code sessions.

## Ground rules

Hindcast is, and will stay, **read-only and local-first**. It only ever *reads*
the transcript files Claude Code already writes to `~/.claude/projects/`. It must
never send messages, drive sessions, or call the Anthropic API / Agent SDK — that
boundary is what keeps it safe to use with any Claude Code subscription. Please
don't propose changes that cross it.

## Development setup

```bash
npm install
npm start        # builds the renderer bundle and launches the app
```

If Electron's binary fails to download during install (npm's script protection),
run `node node_modules/electron/install.js` once, then `npm start`.

## Project layout

- `main.js` — Electron main process (window, IPC, live re-index).
- `preload.js` — the `window.hindcast` bridge (context-isolated).
- `lib/scanner.js` — transcript indexing + parsing (branch walk, usage records).
- `lib/search.js` — ripgrep-backed full-text search.
- `lib/pricing.js` — per-model $/MTok + cache multipliers.
- `lib/export.js` — markdown / self-contained HTML export.
- `src/renderer.jsx` — the React UI (bundled to `out/` by esbuild).
- `styles.css` — the design system (dark / light tokens).

## Before you open a PR

- **Run the solidity battery:** `node scripts/torture.js` — it must stay green.
  If you touch parsing, pricing, export, or search, add a case for the edge you
  fixed.
- **Drive the app** and confirm the change works end to end (see `scripts/shoot.js`
  for the headless-driver pattern).
- Match the surrounding code style — no new dependencies without a good reason,
  and keep the renderer bundle dependency-light.
- Keep commits focused and write a clear description of what changed and why.

## Reporting bugs

Open an issue with: your macOS version, roughly how many sessions are in
`~/.claude/projects/`, and repro steps. Never paste transcript contents that
contain secrets.

## License

By contributing, you agree that your contributions will be licensed under the
MIT License (see `LICENSE`).
