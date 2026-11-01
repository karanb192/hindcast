// Line walker with a hard cap. A single multi-megabyte JSON line (a workspace
// snapshot, an encrypted reasoning blob) must not be decoded or kept.
const fs = require('fs');
const { spawn } = require('child_process');

const MAX_LINE = 8 * 1024 * 1024;

function zstdBin() {
  const candidates = ['/opt/homebrew/bin/zstd', '/usr/local/bin/zstd'];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = require('path').join(dir, 'zstd');
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function openInput(filePath) {
  if (!filePath.endsWith('.zst')) return fs.createReadStream(filePath);
  const bin = zstdBin();
  if (!bin) throw new Error('zstd missing');
  const child = spawn(bin, ['-dc', '--', filePath], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.on('error', () => {});
  return child.stdout;
}

// Calls onLine with each line that fits under the cap. Over-long lines are
// dropped whole. Resolves to the number of lines dropped.
async function forEachLine(filePath, onLine) {
  const input = openInput(filePath);
  let buf = '';
  let dropped = 0;
  try {
    for await (const chunk of input) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.length > MAX_LINE) { dropped++; continue; }
        if (line) await onLine(line);
      }
      if (buf.length > MAX_LINE) { buf = ''; dropped++; }
    }
  } finally {
    if (input.destroy) input.destroy();
  }
  if (buf.length > MAX_LINE) dropped++;
  else if (buf) await onLine(buf);
  return dropped;
}

module.exports = { forEachLine, zstdBin, MAX_LINE };
