<p align="center">
  <img src="assets/logo/hindcast-wordmark.svg" alt="Hindcast" height="64">
</p>

<p align="center">
  <b>Every Claude Code session you've ever run. Indexed, searchable, scrubbable.</b>
</p>

<p align="center">
  A local-first macOS app to browse, search, and replay your Claude Code sessions,
  with a timeline scrubber and a cost ledger.
</p>

<p align="center">
  <img src="assets/screenshots/session-dark.png" alt="A Claude Code session on the Hindcast tape" width="900">
</p>


A Mac desktop app that reads the transcripts Claude Code already writes to
`~/.claude/projects/` and turns them into a browsable archive: a home view with
your stats (tokens, tools, models, cadence heatmap), full-text search across
every session with ⌘K, and a per-session "tape" you can scrub through like
film footage.

Everything stays on your Mac. The app only ever reads local files. It never
sends messages, never drives sessions, and never touches the API or Agent SDK.
It is designed to stay within Anthropic's Terms of Service and to be safe with
any Claude Code subscription, unlike interactive wrapper tools affected by the
April 2026 restriction on Agent SDK chat with subscription accounts.

## The 30-second film

https://github.com/user-attachments/assets/80c5f6c9-7117-465e-886e-5626873f99c2

## Install

```bash
brew tap karanb192/tap
brew trust karanb192/tap
brew install --cask hindcast
xattr -rd com.apple.quarantine /Applications/Hindcast.app   # one-time fix until the app is notarized
```

Apple Silicon only for now. The `xattr` step is needed because the app isn't
notarized yet (Developer ID in progress); it disappears in an upcoming signed
release. Prefer a download? Grab the DMG from
[Releases](https://github.com/karanb192/hindcast/releases).

You'll also want [ripgrep](https://github.com/BurntSushi/ripgrep)
(`brew install ripgrep`); without it, full-text search quietly falls back
to title-only matching.

## Run from source

Requires Node 18+:

```bash
git clone https://github.com/karanb192/hindcast.git
cd hindcast
npm install
npm start
```

If Electron's binary fails to download during install (npm script protection),
run `node node_modules/electron/install.js` once, then `npm start`.

To install it as a proper app, `npm run pack` builds `Hindcast.app` into
`dist/mac-arm64/`; drag it to /Applications.

## How it works

- **Indexer** (`lib/scanner.js`): streams every top-level `*.jsonl` transcript,
  extracts the session title (custom-title > ai-title > first prompt),
  timestamps, models, token usage (deduplicated by message id: one API
  response spans several JSONL lines that each repeat the same usage object),
  and tool counts. Results are cached by file mtime + size + format version in the
  app's user-data dir, and an fs.watch re-index keeps the list live while you
  work.
- **Search** (`lib/search.js`): shells out to ripgrep across all transcripts
  (also matching the JSON-escaped spelling of queries containing quotes or
  backslashes), then re-reads only the matching lines to build human-readable
  snippets. Opening a result jumps the transcript to the matched event,
  including matches inside tool output.
- **Transcript**: sessions are trees (rewinds fork branches); the viewer
  follows the `leafUuid` pointer from the transcript's `last-prompt` line
  (falling back to the last message) and shows only the live conversation,
  reporting how many rewound / subagent events it hid. Renders markdown,
  collapsible thinking, tool cards with inline screenshot results, pasted
  images, compaction markers, and model-fallback notes. The format is
  officially internal to Claude Code, so parsing is tolerant: unknown line
  types and block types are skipped, never fatal.
- **The tape**: every event drawn as a tick (brass = you, ivory/ink = Claude,
  violet = thinking, teal = tools, brick = errors). Click or drag to scrub;
  the playhead follows your scroll.
- **Filters**: date presets (24h / week / month / year) plus a custom
  date-only range, and a model multi-select (any-of). Filters drive both the
  session list and the Archive stats.
- **Themes**: dark, light, and auto (follows macOS). The resolved theme is
  persisted so the window paints the right color from the first frame.
- **The Ledger**: ccusage-style usage and cost view: per-day / per-week /
  per-month tables with per-model breakdowns, estimated dollar cost at
  published API rates (`lib/pricing.js`: cache reads 0.1×, 5m writes 1.25×,
  1h writes 2×; legacy 3.x models and Bedrock/Vertex `xx.anthropic.` ids priced
  too), by-model totals, and a last-7-days figure. Usage is emitted as
  per-message records at index time and **deduplicated globally by message id**
  across every file, including the copied history in resumed/forked sessions
  and every subagent transcript, so nothing is double-counted (the same
  approach ccusage takes). Costs are estimates of API-equivalent value, not an
  invoice.
- **Export**: any session exports to markdown or self-contained HTML
  (active branch, images inlined in HTML) into `~/Downloads/Hindcast Exports`.
- **Subagent reels**: sessions list their subagent transcripts
  (`<sessionDir>/subagents/agent-*.jsonl`); each opens as its own tape with
  a back link.

## Design

"A reading room for machine work." Warm darkroom / warm paper palettes,
New York serif for display type, SF Mono for the machine's voice, one brass
accent. No neon.

## Known limitations

- A search match on a rewound (abandoned) branch opens the session but cannot
  jump to the hidden event.

## Non-goals

- **Live streaming/monitoring of active sessions**: Claude Code's own terminal
  already shows the stream; duplicating it adds nothing. Tools that go further
  are interactive wrappers sending messages via the Agent SDK, which Anthropic's
  ToS (April 2026) restrict on subscription accounts. Hindcast stays a
  read-only archive; the index refreshing as sessions land is as live as it gets.
- **Orchestration and team/cloud sync**: local-first, read-only, nothing leaves
  the machine.

## Not yet built

- Semantic search (RAG) alongside exact search
- Signed + notarized DMG for one-click installs (`npm run pack` builds a local
  unsigned .app today)
