// Export a parsed session (active branch) to markdown or self-contained HTML.
// The HTML export is self-contained and meant to be shared, so it must be safe
// to open: assistant text is rendered as markdown but ALL raw HTML is dropped
// and non-http link protocols are neutralized (marked v14 has no sanitizer).
let marked = null;
try {
  marked = require('marked').marked;
  marked.use({
    renderer: { html() { return ''; } }, // drop raw HTML blocks/inline entirely
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') {
        const href = token.href || '';
        if (!/^(https?:|mailto:|#)/i.test(href)) token.href = '#';
      }
    },
  });
} catch {}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A fence longer than any backtick run inside the content, so code never escapes.
function fenceFor(content) {
  let max = 0;
  for (const m of String(content || '').matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return '`'.repeat(Math.max(3, max + 1));
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) : '';
}

function slug(title) {
  return (title || 'session').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';
}

function toMarkdown(meta, events) {
  const lines = [];
  lines.push(`# ${meta.title || 'Untitled session'}`);
  lines.push('');
  lines.push(`> Claude Code session · ${fmtTime(meta.firstTs)} · ${Object.keys(meta.models).join(', ')} · exported by Hindcast`);
  lines.push('');
  for (const ev of events) {
    switch (ev.kind) {
      case 'user':
        lines.push(`## 🧑 You — ${fmtTime(ev.ts)}`);
        if (ev.text) lines.push('', ev.text);
        if (ev.images && ev.images.length) lines.push('', `*[${ev.images.length} image${ev.images.length > 1 ? 's' : ''} attached]*`);
        lines.push('');
        break;
      case 'assistant':
        lines.push(ev.text, '');
        break;
      case 'thinking': {
        const f = fenceFor(ev.text);
        lines.push('<details><summary><em>thinking</em></summary>', '', f, ev.text, f, '', '</details>', '');
        break;
      }
      case 'tool': {
        const head = `${ev.toolName}${ev.toolSummary ? ' — ' + ev.toolSummary : ''}${ev.isError ? ' (error)' : ''}`;
        lines.push(`<details><summary>🔧 ${esc(head)}</summary>`, '');
        const fi = fenceFor(ev.input);
        lines.push(fi + 'json', ev.input || '', fi, '');
        if (ev.result) { const fr = fenceFor(ev.result); lines.push(fr, ev.result, fr, ''); }
        if (ev.resultImages && ev.resultImages.length) lines.push(`*[${ev.resultImages.length} image(s) in result]*`, '');
        lines.push('</details>', '');
        break;
      }
      case 'compact':
        lines.push('---', '*context compacted*', '---', '');
        break;
      case 'system':
        lines.push(`> ⚙ ${ev.text.split('\n')[0]}`, '');
        break;
    }
  }
  return lines.join('\n');
}

const HTML_CSS = `
  :root { --bg:#f3efe5; --raised:#faf7f0; --line:#dbd3bf; --ink:#26211a; --dim:#4b443a;
    --putty:#7a7264; --brass:#8f7132; --teal:#3f6f6b; --violet:#645573; --brick:#a44b3c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141210; --raised:#1d1a17; --line:#2a2622; --ink:#e8e2d6; --dim:#b5ad9f;
      --putty:#8a8378; --brass:#c9a96a; --teal:#7fa6a3; --violet:#9c8aa5; --brick:#c4756b; } }
  body { background:var(--bg); color:var(--dim); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    max-width:820px; margin:0 auto; padding:48px 24px 80px; }
  h1 { font-family:"New York",ui-serif,Georgia,serif; font-weight:400; color:var(--ink); font-size:28px; }
  .meta { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--putty); margin-bottom:32px; }
  .user { border-left:2px solid var(--brass); padding:10px 14px; margin:28px 0 14px; background:var(--raised); border-radius:0 8px 8px 0; }
  .user .who { font-family:ui-monospace,monospace; font-size:9px; letter-spacing:.14em; text-transform:uppercase; color:var(--brass); margin-bottom:4px; }
  .user .body { white-space:pre-wrap; color:var(--ink); }
  .assistant { margin:12px 0; }
  .assistant pre { background:var(--raised); border:1px solid var(--line); border-radius:8px; padding:10px 12px; overflow-x:auto; font-size:12px; }
  .assistant code { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--teal); }
  .assistant strong { color:var(--ink); }
  details { margin:10px 0; font-family:ui-monospace,Menlo,monospace; font-size:12px; }
  summary { cursor:pointer; color:var(--putty); }
  summary .tool { color:var(--teal); } summary .err { color:var(--brick); }
  details pre { background:var(--raised); border-radius:6px; padding:8px 10px; overflow-x:auto;
    white-space:pre-wrap; word-break:break-word; font-size:11px; max-height:400px; overflow-y:auto; }
  .thinking summary em { color:var(--violet); }
  .thinking pre { color:var(--violet); font-style:italic; background:none; }
  .compact { text-align:center; font-family:ui-monospace,monospace; font-size:10px;
    letter-spacing:.14em; text-transform:uppercase; color:var(--violet); margin:24px 0; }
  .sys { font-family:ui-monospace,monospace; font-size:11px; color:var(--putty); }
  img { max-width:100%; border-radius:8px; border:1px solid var(--line); display:block; margin:8px 0; }
`;

function toHtml(meta, events) {
  const md = (t) => marked ? marked.parse(t || '') : `<pre>${esc(t)}</pre>`;
  const imgs = (arr) => (arr || []).map((im) =>
    `<img src="data:${esc(im.mediaType)};base64,${esc(im.data)}" alt="" />`).join('');
  const body = events.map((ev) => {
    switch (ev.kind) {
      case 'user':
        return `<div class="user"><div class="who">you · ${esc(fmtTime(ev.ts))}</div>` +
          (ev.text ? `<div class="body">${esc(ev.text)}</div>` : '') + imgs(ev.images) + '</div>';
      case 'assistant':
        return `<div class="assistant">${md(ev.text)}</div>`;
      case 'thinking':
        return `<details class="thinking"><summary><em>thinking</em></summary><pre>${esc(ev.text)}</pre></details>`;
      case 'tool':
        return `<details><summary><span class="${ev.isError ? 'err' : 'tool'}">${esc(ev.toolName)}</span> ${esc(ev.toolSummary || '')}</summary>` +
          `<pre>${esc(ev.input)}</pre>` +
          (ev.result ? `<pre>${esc(ev.result)}</pre>` : '') + imgs(ev.resultImages) + '</details>';
      case 'compact':
        return '<div class="compact">— context compacted —</div>';
      case 'system':
        return `<div class="sys">⚙ ${esc(ev.text.split('\n')[0])}</div>`;
      default:
        return '';
    }
  }).join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title || 'Claude Code session')}</title><style>${HTML_CSS}</style></head>
<body><h1>${esc(meta.title || 'Untitled session')}</h1>
<div class="meta">Claude Code session · ${esc(fmtTime(meta.firstTs))} · ${esc(Object.keys(meta.models).join(', '))} · exported by Hindcast</div>
${body}</body></html>`;
}

function exportSession(meta, events, format) {
  const base = `${slug(meta.title)}-${(meta.id || '').slice(0, 8)}`;
  if (format === 'html') return { filename: base + '.html', content: toHtml(meta, events) };
  return { filename: base + '.md', content: toMarkdown(meta, events) };
}

module.exports = { exportSession };
