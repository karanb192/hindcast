// Cold-index benchmark: times buildIndex end to end with a fresh empty cache
// each run, so every file is parsed and nothing is served from cache. Reads
// ~/.claude only; never touches the app's real index-cache.json.
// Usage: node scripts/bench-index.js [runs]   (default 3; prints each run + median)
const fsp = require('fs/promises');
const path = require('path');
const { PROJECTS_DIR, buildIndex } = require('../lib/scanner');

// Untimed walk: main transcripts sit at depth 1 (project dir / session.jsonl);
// deeper .jsonl are subagent transcripts, which buildIndex also reads.
async function archiveStats() {
  const stats = { mainFiles: 0, allFiles: 0, bytes: 0 };
  async function walk(dir, depth) {
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { await walk(p, depth + 1); continue; }
      if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
      stats.allFiles++;
      if (depth === 1) stats.mainFiles++;
      try { stats.bytes += (await fsp.stat(p)).size; } catch {}
    }
  }
  await walk(PROJECTS_DIR, 0);
  return stats;
}

function median(times) {
  const s = [...times].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

(async () => {
  const runs = Math.max(1, parseInt(process.argv[2], 10) || 3);
  const arch = await archiveStats();
  const times = [];
  let result = null;
  for (let i = 0; i < runs; i++) {
    const cache = { entries: {} };
    const t0 = process.hrtime.bigint();
    result = await buildIndex(cache);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    times.push(ms);
    console.log(`run ${i + 1}: ${ms.toFixed(1)} ms`);
  }
  const mb = arch.bytes / (1024 * 1024);
  console.log(`files: ${arch.mainFiles} transcripts (${arch.allFiles} jsonl incl subagents)`);
  console.log(`sessions: ${result.sessions.length}`);
  console.log(`archive: ${mb.toFixed(1)} MB`);
  console.log(`median: ${median(times).toFixed(1)} ms over ${runs} run(s)`);
})();
