import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useDeferredValue } from 'react';
import { createRoot } from 'react-dom/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { costOf } from '../lib/pricing.js';
import { buildResumeCmd } from '../lib/resume.js';
import { BUILTIN_COMMANDS } from '../lib/builtin-commands.js';

const api = window.hindcast;

marked.setOptions({ breaks: true, gfm: true });

// ---------- formatting helpers ----------

const fmtTokens = (n) => {
  if (n == null) return '';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
};

// toLocaleDateString builds a fresh Intl.DateTimeFormat on every call
// (~0.05ms each: a full session-list render burned ~23ms on dates alone).
// Shared formatter instances make the same render ~150x cheaper.
const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const DATE_FMT_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

const fmtDate = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() === new Date().getFullYear() ? DATE_FMT.format(d) : DATE_FMT_YEAR.format(d);
};

const fmtTime = (ts) => ts ? TIME_FMT.format(ts) : '';

const fmtUSD = (n) => {
  if (n == null) return '—';
  if (n >= 1000) return '$' + Math.round(n).toLocaleString();
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 0.01) return '$' + n.toFixed(2);
  return n > 0 ? '<$0.01' : '$0';
};

const fmtDuration = (ms) => {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
};

const modelShort = (m) => {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
};

// Canvas can't use var() — resolve the theme's event colors at draw time.
function themeEventColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (n) => css.getPropertyValue(n).trim();
  return {
    user: get('--ev-user'),
    assistant: get('--ev-assistant'),
    thinking: get('--ev-thinking'),
    tool: get('--ev-tool'),
    error: get('--ev-error'),
    system: get('--ev-system'),
    brass: get('--brass'),
  };
}

// ---------- markdown ----------

function Markdown({ text }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text || '')),
    [text]
  );
  return <div className="body" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------- left rail ----------

// The Spool mark, inlined so it inherits the theme's brass via currentColor.
function SpoolMark({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="-52 -52 104 104" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round"
        d="M48 40H0 A33.5 33.5 0 0 1 0 -27 A22.5 22.5 0 0 1 0 18 A15 15 0 0 1 0 -12" />
      <circle fill="currentColor" r="5.5" />
    </svg>
  );
}

const Rail = React.memo(function Rail({ projects, selected, onSelect, totalSessions, projectCounts, filtersActive, themePref, setThemePref, view, skillCount }) {
  // Local query: typing here re-renders only the rail, never the app.
  const [projectQuery, setProjectQuery] = useState('');
  const filterVisible = projects.length > 8;
  // If a rescan drops the project count below the threshold, the input
  // unmounts; clear its query too or an invisible filter keeps narrowing
  // the list with no control left to clear it.
  useEffect(() => {
    if (!filterVisible && projectQuery) setProjectQuery('');
  }, [filterVisible, projectQuery]);
  const shownProjects = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      p.name.toLowerCase().includes(q) || (p.path || '').toLowerCase().includes(q)
    );
  }, [projects, projectQuery]);
  return (
    <div className="rail">
      <div className="rail-brand"><span className="brand-mark"><SpoolMark /></span>Hindcast</div>
      <div className="rail-fixed">
        <div
          className={'rail-item' + (view === 'archive' && selected === null ? ' active' : '')}
          onClick={() => onSelect(null, 'archive')}
        >
          <span className="name">The Archive</span>
          <span className="count">{totalSessions}</span>
        </div>
        <div
          className={'rail-item' + (view === 'ledger' ? ' active' : '')}
          onClick={() => onSelect(selected, 'ledger')}
        >
          <span className="name">The Ledger</span>
          <span className="count">$</span>
        </div>
        <div
          className={'rail-item' + (view === 'skills' ? ' active' : '')}
          onClick={() => onSelect(selected, 'skills')}
        >
          <span className="name">The Skills</span>
          <span className="count">{skillCount}</span>
        </div>
      </div>
      {/* Label and filter sit outside the scroll container, so a scrolled
          project list stays named and filterable. */}
      <div className="rail-list-head">
        <div className="rail-section">Projects</div>
        {filterVisible && (
          <input
            className="rail-filter"
            placeholder="Filter projects…"
            value={projectQuery}
            onChange={(e) => setProjectQuery(e.target.value)}
          />
        )}
      </div>
      <div className="rail-list">
        {projectQuery.trim() !== '' && shownProjects.length === 0 && (
          <div className="rail-empty">no matching projects</div>
        )}
        {shownProjects.map((p) => {
          const n = projectCounts.get(p.id) || 0;
          const dim = filtersActive && n === 0 && !(selected === p.id && view === 'archive');
          return (
            <div
              key={p.id}
              className={'rail-item' + (selected === p.id && view === 'archive' ? ' active' : '') + (dim ? ' dim' : '')}
              onClick={() => onSelect(p.id, 'archive')}
              title={p.path}
            >
              <span className="name">{p.name}</span>
              <span className="count">{n}</span>
            </div>
          );
        })}
      </div>
      <div className="rail-foot">
        <div className="hint"><b>⌘K</b> search</div>
        <div className="theme-seg">
          {['auto', 'light', 'dark'].map((t) => (
            <button
              key={t}
              className={themePref === t ? 'on' : ''}
              onClick={() => setThemePref(t)}
            >{t}</button>
          ))}
        </div>
      </div>
    </div>
  );
});

// ---------- filters ----------

const DATE_PRESETS = [
  ['all', 'All time'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last week'],
  ['30d', 'Last month'],
  ['365d', 'Last year'],
  ['custom', 'Custom range'],
];
const PRESET_MS = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, '365d': 365 * 864e5 };

function sessionPassesDate(s, f) {
  const t = s.lastTs || 0;
  if (f.preset in PRESET_MS) return t >= Date.now() - PRESET_MS[f.preset];
  if (f.preset === 'custom') {
    if (f.from && t < new Date(f.from + 'T00:00:00').getTime()) return false;
    if (f.to && t > new Date(f.to + 'T23:59:59.999').getTime()) return false;
  }
  return true;
}

// Predicate over a 'YYYY-MM-DD' day key — mirrors the session date filter at day
// granularity, so the Ledger's per-day math matches the active Date filter.
function makeDayInRange(f) {
  if (f.preset === 'all') return () => true;
  if (f.preset in PRESET_MS) {
    const cutoff = Date.now() - PRESET_MS[f.preset];
    return (date) => new Date(date + 'T23:59:59.999').getTime() >= cutoff;
  }
  if (f.preset === 'custom') {
    return (date) => {
      if (f.from && date < f.from) return false;
      if (f.to && date > f.to) return false;
      return true;
    };
  }
  return () => true;
}

function Dropdown({ label, active, open, setOpen, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);
  return (
    <div className="dd" ref={ref}>
      <button className={'dd-btn' + (active ? ' active' : '')} onClick={() => setOpen(!open)}>
        {label} <span className="dd-caret">▾</span>
      </button>
      {open && <div className="dd-pop">{children}</div>}
    </div>
  );
}

function FilterBar({ dateFilter, setDateFilter, modelFilter, setModelFilter, modelOptions }) {
  const [openWhich, setOpenWhich] = useState(null);

  const dateActive = dateFilter.preset !== 'all';
  let dateLabel = 'Date';
  if (dateActive) {
    if (dateFilter.preset === 'custom') {
      const f = dateFilter.from ? fmtDate(new Date(dateFilter.from + 'T12:00:00').getTime()) : '…';
      const t = dateFilter.to ? fmtDate(new Date(dateFilter.to + 'T12:00:00').getTime()) : '…';
      dateLabel = `${f} – ${t}`;
    } else {
      dateLabel = DATE_PRESETS.find((p) => p[0] === dateFilter.preset)[1];
    }
  }

  const modelActive = modelFilter.size > 0;
  const modelLabel = !modelActive
    ? 'Model'
    : modelFilter.size === 1
      ? modelShort([...modelFilter][0])
      : `${modelFilter.size} models`;

  return (
    <div className="filter-row">
      <Dropdown
        label={dateLabel} active={dateActive}
        open={openWhich === 'date'} setOpen={(v) => setOpenWhich(v ? 'date' : null)}
      >
        {DATE_PRESETS.map(([k, lbl]) => (
          <div
            key={k}
            className={'dd-item' + (dateFilter.preset === k ? ' on' : '')}
            onClick={() => {
              setDateFilter({ ...dateFilter, preset: k });
              if (k !== 'custom') setOpenWhich(null);
            }}
          >
            <span className="dd-check">{dateFilter.preset === k ? '●' : ''}</span>{lbl}
          </div>
        ))}
        {dateFilter.preset === 'custom' && (
          <div className="dd-range">
            <label>from
              <input
                className="dd-date" type="date" value={dateFilter.from || ''}
                onChange={(e) => setDateFilter({ ...dateFilter, from: e.target.value || null })}
              />
            </label>
            <label>to
              <input
                className="dd-date" type="date" value={dateFilter.to || ''}
                onChange={(e) => setDateFilter({ ...dateFilter, to: e.target.value || null })}
              />
            </label>
          </div>
        )}
      </Dropdown>
      <Dropdown
        label={modelLabel} active={modelActive}
        open={openWhich === 'model'} setOpen={(v) => setOpenWhich(v ? 'model' : null)}
      >
        {modelOptions.length === 0 && <div className="dd-empty">no models in scope</div>}
        {modelOptions.map(({ id, name, count }) => {
          const on = modelFilter.has(id);
          return (
            <div
              key={id}
              className={'dd-item' + (on ? ' on' : '')}
              onClick={() => {
                const next = new Set(modelFilter);
                if (on) next.delete(id); else next.add(id);
                setModelFilter(next);
              }}
            >
              <span className="dd-check">{on ? '✓' : '○'}</span>
              <span className="dd-name">{name}</span>
              <span className="dd-count">{count}</span>
            </div>
          );
        })}
        {modelActive && (
          <div className="dd-item dd-clear" onClick={() => setModelFilter(new Set())}>
            <span className="dd-check" />Clear models
          </div>
        )}
      </Dropdown>
    </div>
  );
}

// ---------- session list ----------

const SessionCard = React.memo(function SessionCard({ s, active, onSelect }) {
  return (
    <div
      className={'session-card' + (active ? ' active' : '')}
      onClick={() => onSelect(s.id)}
    >
      <div className="title">{s.title || 'Untitled session'}</div>
      <div className="sub">
        <span>{fmtDate(s.lastTs)}</span>
        <span className="sep">·</span>
        <span className="proj">{(s.projectPath || '').split('/').pop()}</span>
        {s.tokens.output > 0 && <>
          <span className="sep">·</span>
          <span>{fmtTokens(s.tokens.output)} out</span>
        </>}
        {s.toolCalls > 0 && <>
          <span className="sep">·</span>
          <span>{s.toolCalls} tools</span>
        </>}
      </div>
    </div>
  );
});

// List body, memoized so the urgent keystroke render (which only changes
// `filter`, not `deferredFilter`) bails out here entirely: a keystroke's
// synchronous work is the input plus the meta line, nothing else.
// NOT windowed: card heights vary (1 to 2 title lines and sub lines), so
// fixed-row padding spacers drift and the list visibly jumps mid-scroll.
// Off-screen layout/paint cost is already covered by the cards'
// content-visibility:auto, which handles variable heights natively.
const SessionListBody = React.memo(function SessionListBody({
  shown, selectedId, onSelect, deferredFilter, anyFilter, onClearFilters, onSearchTranscripts,
}) {
  const listRef = useRef(null);

  // A new query means new results: start reading from the top. Layout effect,
  // not passive: the reset must land before the commit paints, or a keystroke
  // while scrolled deep flashes one frame of the old scroll position first.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [deferredFilter]);

  return (
    <div className="session-list" ref={listRef}>
      {shown.length === 0 && (
        <div className="list-empty">
          {deferredFilter.trim() ? (
            <>
              <div>No titles match “{deferredFilter.trim()}”.</div>
              <div className="hint-line" onClick={() => onSearchTranscripts(deferredFilter.trim())}>
                Search inside transcripts <span className="kbd">⌘K</span>
              </div>
            </>
          ) : (
            <>
              <div>No sessions in this view.</div>
              {anyFilter && <div className="hint-line" onClick={onClearFilters}>Clear filters</div>}
            </>
          )}
        </div>
      )}
      {shown.map((s) => (
        <SessionCard key={s.id} s={s} active={s.id === selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
});

function SessionList({ sessions, selectedId, onSelect, projectName, filterBar, anyFilter, onClearFilters, onSearchTranscripts }) {
  // The query lives here, not in App: a keystroke re-renders this list only,
  // never the rail or the stage. The deferred value lets the input echo
  // instantly while the filtered list catches up a frame later.
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter);
  // While the list is catching up to the input, say so instead of showing a
  // count that belongs to the previous query.
  const isStale = filter !== deferredFilter;
  const shown = useMemo(() => {
    if (!deferredFilter.trim()) return sessions;
    const q = deferredFilter.toLowerCase();
    return sessions.filter((s) =>
      (s.title || '').toLowerCase().includes(q) ||
      (s.projectPath || '').toLowerCase().includes(q)
    );
  }, [sessions, deferredFilter]);

  return (
    <div className="sessions">
      <div className="sessions-head">
        <input
          className="filter"
          placeholder={`Filter ${projectName || 'all sessions'} by title…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filterBar}
      </div>
      <div className="sessions-meta">
        {isStale
          ? <span className="filtering-note">filtering…</span>
          : <>{shown.length.toLocaleString()} session{shown.length === 1 ? '' : 's'}</>}
        {anyFilter && <span className="clear-link" onClick={onClearFilters}> · clear filters</span>}
      </div>
      {/* The shell carries the stale dim so the memoized body doesn't take
          isStale as a prop, which would drag it into the urgent render. */}
      <div className="list-shell" style={{ opacity: isStale ? 0.55 : 1 }}>
        <SessionListBody
          shown={shown}
          selectedId={selectedId}
          onSelect={onSelect}
          deferredFilter={deferredFilter}
          anyFilter={anyFilter}
          onClearFilters={onClearFilters}
          onSearchTranscripts={onSearchTranscripts}
        />
      </div>
    </div>
  );
}

// ---------- archive (home) ----------

function Heatmap({ sessions }) {
  const WEEKS = 26;
  const cells = useMemo(() => {
    const byDay = new Map();
    for (const s of sessions) {
      if (!s.lastTs) continue;
      const d = new Date(s.lastTs);
      const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
      byDay.set(key, (byDay.get(key) || 0) + 1);
    }
    const today = new Date();
    const cols = [];
    // Last column is the current (partial) week, Sunday-first rows;
    // days after today render as padded null cells.
    const start = new Date(today);
    start.setDate(start.getDate() - ((WEEKS - 1) * 7 + today.getDay()));
    let max = 1;
    for (let w = 0; w < WEEKS; w++) {
      const col = [];
      for (let d = 0; d < 7; d++) {
        const day = new Date(start);
        day.setDate(start.getDate() + w * 7 + d);
        if (day > today) { col.push(null); continue; }
        const key = day.getFullYear() + '-' + day.getMonth() + '-' + day.getDate();
        const v = byDay.get(key) || 0;
        max = Math.max(max, v);
        col.push({ v, day });
      }
      cols.push(col);
    }
    return { cols, max };
  }, [sessions]);

  const shade = (v) => {
    if (!v) return null; // class default (--heat-empty) applies
    const t = Math.min(1, v / cells.max);
    const a = 0.3 + t * 0.7;
    return `rgba(var(--heat), ${a.toFixed(2)})`;
  };

  return (
    <div className="heatmap">
      {cells.cols.map((col, i) => (
        <div className="heat-col" key={i}>
          {col.map((c, j) => (
            <div
              key={j}
              className="heat-cell"
              style={c ? (shade(c.v) ? { background: shade(c.v) } : undefined) : { opacity: 0.25 }}
              title={c ? `${c.day.toDateString()} — ${c.v} session${c.v === 1 ? '' : 's'}` : ''}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function BarList({ items, color }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="bar-list">
      {items.map((it) => (
        <div className="bar-item" key={it.label}>
          <div className="lbl" title={it.label}>{it.label}</div>
          <div className="track">
            <div className="fill" style={{ width: (it.value / max * 100) + '%', background: color }} />
          </div>
          <div className="val">{it.display ?? it.value.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

function Archive({ sessions, indexing, progress, filtered }) {
  const stats = useMemo(() => {
    let tokensOut = 0, tokensIn = 0, cacheRead = 0, toolCalls = 0, userTurns = 0;
    const models = {}, tools = {};
    const projCounts = new Map();
    let firstTs = null;
    for (const s of sessions) {
      tokensOut += s.tokens.output; tokensIn += s.tokens.input;
      cacheRead += s.tokens.cacheRead;
      toolCalls += s.toolCalls; userTurns += s.userTurns;
      for (const [m, c] of Object.entries(s.models)) models[m] = (models[m] || 0) + c;
      for (const [t, c] of Object.entries(s.tools)) tools[t] = (tools[t] || 0) + c;
      const pname = (s.projectPath || '').split('/').pop() || s.project;
      projCounts.set(pname, (projCounts.get(pname) || 0) + 1);
      if (s.firstTs && (!firstTs || s.firstTs < firstTs)) firstTs = s.firstTs;
    }
    return { tokensOut, tokensIn, cacheRead, toolCalls, userTurns, models, tools, projCounts, firstTs };
  }, [sessions]);

  const topTools = Object.entries(stats.tools).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([label, value]) => ({ label, value }));
  const topModels = Object.entries(stats.models).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([label, value]) => ({ label: modelShort(label), value, display: value.toLocaleString() + ' msgs' }));
  const topProjects = [...stats.projCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([label, value]) => ({ label, value, display: value + ' session' + (value === 1 ? '' : 's') }));

  const since = stats.firstTs
    ? new Date(stats.firstTs).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : '';

  return (
    <div className="archive">
      <div className="archive-hero">
        <div className="archive-eyebrow">The Archive</div>
        <div className="archive-title">
          {sessions.length.toLocaleString()} conversation{sessions.length === 1 ? '' : 's'} with <em>the machine</em>
          {filtered ? ' in this view.' : since ? ` since ${since}.` : '.'}
        </div>
        <div className="archive-sub">
          Every Claude Code session on this Mac, indexed and searchable.
          Select a session to replay it, or press ⌘K to search across all of them.
        </div>
        {indexing && (
          <div className="indexing-note">
            indexing… {progress ? `${progress.done} / ${progress.total}` : ''}
          </div>
        )}
        <div className="stat-row">
          <div className="stat"><div className="num">{fmtTokens(stats.tokensOut)}</div><div className="lbl">tokens written</div></div>
          <div className="stat"><div className="num">{fmtTokens(stats.cacheRead)}</div><div className="lbl">tokens read</div></div>
          <div className="stat"><div className="num">{stats.toolCalls.toLocaleString()}</div><div className="lbl">tool runs</div></div>
          <div className="stat"><div className="num">{stats.userTurns.toLocaleString()}</div><div className="lbl">prompts</div></div>
          <div className="stat"><div className="num">{stats.projCounts.size}</div><div className="lbl">projects</div></div>
        </div>
      </div>

      <div className="archive-section">
        <h3>{filtered ? 'Cadence — filtered view' : 'Cadence — last 26 weeks'}</h3>
        <Heatmap sessions={sessions} />
      </div>

      <div className="archive-section">
        <h3>Instruments</h3>
        <BarList items={topTools} color="var(--tool-dim)" />
      </div>

      <div className="archive-section">
        <h3>Models</h3>
        <BarList items={topModels} color="var(--brass-dim)" />
      </div>

      <div className="archive-section">
        <h3>Where the work happens</h3>
        <BarList items={topProjects} color="var(--putty-dim)" />
      </div>
    </div>
  );
}

// ---------- the ledger (usage & cost) ----------

function periodKey(dateStr, group) {
  // dateStr is 'YYYY-MM-DD' local
  if (group === 'day') return dateStr;
  const d = new Date(dateStr + 'T12:00:00');
  if (group === 'week') {
    const start = new Date(d);
    start.setDate(d.getDate() - d.getDay()); // Sunday-first, matching the heatmap
    return start.getFullYear() + '-' +
      String(start.getMonth() + 1).padStart(2, '0') + '-' +
      String(start.getDate()).padStart(2, '0');
  }
  return dateStr.slice(0, 7); // month: 'YYYY-MM'
}

function periodLabel(key, group) {
  if (group === 'month') {
    return new Date(key + '-15T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }
  const label = new Date(key + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return group === 'week' ? 'wk of ' + label : label;
}

const pad2 = (n) => String(n).padStart(2, '0');
// Local day key, same 'YYYY-MM-DD' convention as s.daily and makeDayInRange.
const dayKeyOf = (ts) => {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
};

function Ledger({ sessions, dayInRange, modelFilter }) {
  const [group, setGroup] = useState('day');
  const dayOk = dayInRange || (() => true);
  const modelOk = (m) => !modelFilter || modelFilter.size === 0 || modelFilter.has(m);

  const { rows, models, totals } = useMemo(() => {
    // period -> model -> {in,out,cr,w5,w1}; plus per-period session counts
    const byPeriod = new Map();
    const perModel = new Map();
    const sessionsInPeriod = new Map();
    for (const s of sessions) {
      const touched = new Set();
      for (const [date, dayModels] of Object.entries(s.daily || {})) {
        if (!dayOk(date)) continue; // honor the active date filter at day granularity
        const key = periodKey(date, group);
        const period = byPeriod.get(key) || new Map();
        for (const [model, u] of Object.entries(dayModels)) {
          if (!modelOk(model)) continue; // honor the active model filter
          touched.add(key);
          byPeriod.set(key, period);
          for (const map of [period, perModel]) {
            const acc = map.get(model) || { in: 0, out: 0, cr: 0, w5: 0, w1: 0 };
            acc.in += u.in; acc.out += u.out; acc.cr += u.cr; acc.w5 += u.w5; acc.w1 += u.w1;
            map.set(model, acc);
          }
        }
      }
      for (const key of touched) {
        sessionsInPeriod.set(key, (sessionsInPeriod.get(key) || 0) + 1);
      }
    }

    const rows = [...byPeriod.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, modelMap]) => {
        let cost = 0, priced = false, tin = 0, tout = 0, tcr = 0, tcw = 0;
        const perModelRow = [];
        for (const [model, u] of [...modelMap.entries()].sort((a, b) => b[1].out - a[1].out)) {
          const c = costOf(model, u);
          if (c != null) { cost += c; priced = true; }
          tin += u.in; tout += u.out; tcr += u.cr; tcw += u.w5 + u.w1;
          perModelRow.push({ model, cost: c, out: u.out });
        }
        return {
          key, label: periodLabel(key, group),
          cost: priced ? cost : null,
          tin, tout, tcr, tcw,
          models: perModelRow,
          sessions: sessionsInPeriod.get(key) || 0,
        };
      });

    const models = [...perModel.entries()]
      .map(([model, u]) => ({ model, u, cost: costOf(model, u) }))
      .sort((a, b) => (b.cost || 0) - (a.cost || 0));

    const activeDays = new Set();
    for (const s of sessions) {
      for (const date of Object.keys(s.daily || {})) if (dayOk(date)) activeDays.add(date);
    }
    const totals = {
      cost: models.reduce((a, m) => a + (m.cost || 0), 0),
      out: models.reduce((a, m) => a + m.u.out, 0),
      cr: models.reduce((a, m) => a + m.u.cr, 0),
      days: activeDays.size,
    };
    return { rows, models, totals };
  }, [sessions, group, dayInRange, modelFilter]);

  const last7 = useMemo(() => {
    // Window = today plus the 6 prior whole days (7 calendar days), matching the label.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 6);
    const startKey = start.getFullYear() + '-' +
      String(start.getMonth() + 1).padStart(2, '0') + '-' +
      String(start.getDate()).padStart(2, '0');
    let sum = 0;
    for (const s of sessions) {
      for (const [date, dayModels] of Object.entries(s.daily || {})) {
        if (date < startKey) continue; // 'YYYY-MM-DD' strings sort chronologically
        for (const [model, u] of Object.entries(dayModels)) {
          if (modelOk(model)) sum += costOf(model, u) || 0;
        }
      }
    }
    return sum;
  }, [sessions, modelFilter]);

  const maxRowCost = Math.max(...rows.map((r) => r.cost || 0), 0.01);

  return (
    <div className="archive">
      <div className="archive-hero">
        <div className="archive-eyebrow">The Ledger</div>
        <div className="archive-title">
          <em>{fmtUSD(totals.cost)}</em> of API-equivalent value burned.
        </div>
        <div className="archive-sub">
          Token usage and estimated cost at published API rates, computed from the transcripts
          themselves and deduplicated by message. Estimates, not an invoice — subscription plans
          don't bill per token.
        </div>
        <div className="stat-row">
          <div className="stat"><div className="num">{fmtUSD(totals.cost)}</div><div className="lbl">est. total value</div></div>
          <div className="stat"><div className="num">{fmtUSD(last7)}</div><div className="lbl">last 7 days</div></div>
          <div className="stat"><div className="num">{fmtTokens(totals.out)}</div><div className="lbl">tokens written</div></div>
          <div className="stat"><div className="num">{fmtTokens(totals.cr)}</div><div className="lbl">tokens read</div></div>
          <div className="stat"><div className="num">{totals.days}</div><div className="lbl">active days</div></div>
        </div>
      </div>

      <div className="archive-section">
        <h3>By model</h3>
        <BarList items={models.map((m) => ({
          label: modelShort(m.model),
          value: m.cost || 0,
          display: `${fmtUSD(m.cost)} · ${fmtTokens(m.u.out)} out`,
        }))} color="var(--brass-dim)" />
      </div>

      <div className="archive-section">
        <h3>
          Over time
          <span className="ledger-groups">
            {['day', 'week', 'month'].map((g) => (
              <button key={g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>{g}</button>
            ))}
          </span>
        </h3>
        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead><tr>
              <th className="l">{group}</th><th className="l">models</th>
              <th>sessions</th><th>in</th><th>out</th><th>cache r</th><th>cache w</th><th>est. cost</th><th></th>
            </tr></thead>
            <tbody>
              {rows.slice(0, 90).map((r) => (
                <tr key={r.key}>
                  <td className="l period">{r.label}</td>
                  <td className="l models">
                    {r.models.slice(0, 4).map((m) => (
                      <span key={m.model} className="model-chip" title={`${m.model}: ${fmtUSD(m.cost)}`}>
                        {modelShort(m.model)}
                      </span>
                    ))}
                    {r.models.length > 4 && <span className="model-chip">+{r.models.length - 4}</span>}
                  </td>
                  <td>{r.sessions}</td>
                  <td>{fmtTokens(r.tin)}</td>
                  <td>{fmtTokens(r.tout)}</td>
                  <td>{fmtTokens(r.tcr)}</td>
                  <td>{fmtTokens(r.tcw)}</td>
                  <td className="cost">{fmtUSD(r.cost)}</td>
                  <td className="spark">
                    <span className="spark-bar" style={{ width: `${Math.max(2, ((r.cost || 0) / maxRowCost) * 100)}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 90 && <div className="ledger-note">showing the most recent 90 periods</div>}
      </div>

      <div className="archive-section">
        <h3>Method</h3>
        <p className="ledger-method">
          Cost = input + output at each model's published $/MTok, cache reads at 0.1×, cache
          writes at 1.25× (5-minute) and 2× (1-hour) input rate. Usage is deduplicated by API
          message id. Models without a known price are counted in tokens but excluded from cost.
        </p>
      </div>
    </div>
  );
}

// ---------- the skills (inventory & firings) ----------

function Skills({ scopeSessions, allSessions, dayInRange, dateFilter, skillInventory, onOpenSession }) {
  const [openSkill, setOpenSkill] = useState(null); // name of the one expanded row, or null
  const dayOk = dayInRange || (() => true);
  const skillAll = allSessions || scopeSessions;

  // Aggregates s.skills entirely in memory; the page does zero file IO.
  // Two session lists feed it. skillAll is the whole archive: the hero, the
  // never-fired and idle flags, and the skill-vs-builtin classification
  // claim all-time truth, so any narrowing would make them lie.
  // scopeSessions is project-scoped only: the columns honor the date filter
  // per record (dayOk) and ignore the model filter, since a skill
  // invocation carries no model.
  const skills = useMemo(() => {
    // Fixed 12-month window, oldest first. It ends at the custom range's
    // upper bound when one is set, so a range older than the window still
    // draws bars; a range spanning more than 12 months keeps its oldest
    // records in the counts but off the strip.
    const months = [];
    const end = dateFilter && dateFilter.preset === 'custom' && dateFilter.to
      ? new Date(dateFilter.to + 'T12:00:00') : new Date();
    for (let i = 11; i >= 0; i--) {
      const m = new Date(end.getFullYear(), end.getMonth() - i, 1);
      months.push(m.getFullYear() + '-' + pad2(m.getMonth() + 1));
    }

    const byName = new Map();
    const entry = (name) => {
      let e = byName.get(name);
      if (!e) {
        e = {
          name, installed: false, source: null,
          allCount: 0, allClaude: 0, allLastTs: 0, // archive-wide; feed the flags and classification
          count: 0, claude: 0, you: 0,             // scope + date filter; feed the columns
          firstTs: null, lastTs: null,
          byMonth: new Map(),                      // 'YYYY-MM' -> count, date-filtered
          sessions: new Map(),                     // sessionId -> { s, count, ts, uuid }
        };
        byName.set(name, e);
      }
      return e;
    };

    // Names that ever arrived as a system local_command line; with the
    // hardcoded set, the builtin side of classification.
    const builtinSeen = new Set();
    for (const s of skillAll) {
      for (const n of Object.keys(s.builtins || {})) builtinSeen.add(n);
      for (const r of (s.skills || [])) {
        if (!r || !r.n || !r.ts) continue;
        const e = entry(r.n);
        e.allCount++;
        if (r.t === 'claude') e.allClaude++;
        if (r.ts > e.allLastTs) e.allLastTs = r.ts;
      }
    }
    for (const s of scopeSessions) {
      for (const r of (s.skills || [])) {
        if (!r || !r.n || !r.ts) continue;
        if (!dayOk(dayKeyOf(r.ts))) continue;
        const e = entry(r.n);
        e.count++;
        if (r.t === 'claude') e.claude++; else e.you++;
        if (!e.firstTs || r.ts < e.firstTs) e.firstTs = r.ts;
        if (!e.lastTs || r.ts > e.lastTs) e.lastTs = r.ts;
        const mk = dayKeyOf(r.ts).slice(0, 7);
        e.byMonth.set(mk, (e.byMonth.get(mk) || 0) + 1);
        const line = e.sessions.get(s.id) || { s, count: 0, ts: r.ts, uuid: r.u };
        line.count++;
        // The jump lands on the session's earliest firing of this skill.
        if (r.ts < line.ts) { line.ts = r.ts; line.uuid = r.u; }
        e.sessions.set(s.id, line);
      }
    }
    for (const it of (skillInventory || [])) {
      if (it && it.name) {
        const e = entry(it.name);
        e.installed = true;
        e.source = it.source || null;
      }
    }

    // Typed builtins ride the same command wrappers as typed skills, so the
    // scanner ships them undistinguished. A name stays if the Skill tool
    // ever fired it or it is installed; otherwise it is dropped as a
    // builtin when the set or a local_command sighting says so. What
    // remains (typed-only, not installed, not builtin) is typically a
    // since-removed skill, which must keep showing.
    const classified = [...byName.values()].filter((e) =>
      e.allClaude > 0 || e.installed ||
        !(builtinSeen.has(e.name) || BUILTIN_COMMANDS.has(e.name)));

    // Hero and stat-row numbers are archive-true like the flags: filters
    // never change what is installed or what never fired. The row's algebra
    // must close under a reader's subtraction: installed = have fired +
    // never fired. Skills that fired but sit outside today's inventory
    // (removed skills, bare plugin names) get their own stat and never mix
    // into the installed ones; idle is an installed-only flag, since an
    // uninstalled skill needs no pruning nudge.
    const now = Date.now();
    const stats = { installed: 0, fired: 0, neverFired: 0, idle: 0, gone: 0 };
    for (const e of classified) {
      if (e.installed) {
        stats.installed++;
        if (e.allCount > 0) stats.fired++;
        else stats.neverFired++;
        if (e.allCount > 0 && now - e.allLastTs > 60 * 864e5) stats.idle++;
      } else if (e.allCount > 0) {
        stats.gone++;
      }
    }

    // The archive-wide pass also names skills fired only outside the
    // current scope or filter; those rows show only when installed
    // (carrying their flags), so the table keeps following the view.
    const rows = classified
      .filter((e) => e.count > 0 || e.installed)
      // Fired skills by in-filter count, then all-time count, then name;
      // installed-never-fired rows sink to the bottom alphabetically.
      .sort((a, b) =>
        (b.count - a.count) || (b.allCount - a.allCount) || (a.name < b.name ? -1 : 1));
    return { rows, months, stats };
  }, [scopeSessions, skillAll, dayInRange, dateFilter, skillInventory]);

  const st = skills.stats;
  return (
    <div className="archive">
      <div className="archive-hero">
        <div className="archive-eyebrow">The Skills</div>
        <div className="archive-title">
          {st.installed > 0 && st.neverFired > 0 ? (
            <>Of <em>{st.installed}</em> installed skills, <em>{st.neverFired}</em> {st.neverFired === 1 ? 'has' : 'have'} never fired.</>
          ) : st.installed > 0 ? (
            <>All <em>{st.installed}</em> installed skills have fired.</>
          ) : st.gone > 0 ? (
            <><em>{st.gone}</em> skills have fired across the archive.</>
          ) : (
            <>No skills have fired yet.</>
          )}
        </div>
        <div className="archive-sub">
          Every invocation read from the transcripts, whether Claude loaded the skill or
          you typed the slash command, deduplicated across forked and resumed sessions.
          Counts follow the project scope and the date filter; the model filter does not
          apply, and the never-fired and idle flags always speak for the whole archive.
        </div>
        <div className="stat-row">
          <div className="stat"><div className="num">{st.installed}</div><div className="lbl">installed</div></div>
          <div className="stat"><div className="num">{st.fired}</div><div className="lbl">have fired</div></div>
          <div className="stat"><div className="num">{st.neverFired}</div><div className="lbl">never fired</div></div>
          <div className="stat"><div className="num">{st.idle}</div><div className="lbl">idle 60+ days</div></div>
          <div className="stat"><div className="num">{st.gone}</div><div className="lbl">fired, not installed</div></div>
        </div>
      </div>

      <div className="archive-section">
        <h3>By skill</h3>
        {skills.rows.length === 0 ? (
          <p className="ledger-method">
            No skill invocations in this view. When a session fires a skill, whether
            Claude loads it or you type the slash command, it shows up here with its
            full history.
          </p>
        ) : (
          <div className="ledger-table-wrap">
            <table className="ledger-table skills-table">
              <thead><tr>
                <th className="l">skill</th><th>fired</th><th>claude</th><th>you</th>
                <th>sessions</th><th>first</th><th>last</th><th></th>
              </tr></thead>
              <tbody>
                {skills.rows.map((r) => {
                  const open = openSkill === r.name;
                  const expandable = r.allCount > 0;
                  const num = (n) => n ? n : ''; // zeros render blank; the chips carry the story
                  const trendMax = Math.max(...skills.months.map((m) => r.byMonth.get(m) || 0), 1);
                  return (
                    <React.Fragment key={r.name}>
                      <tr
                        className={expandable ? 'skill-row' : undefined}
                        onClick={expandable ? () => setOpenSkill(open ? null : r.name) : undefined}
                      >
                        <td className="l name">
                          <span className="twist">{expandable ? (open ? '▼' : '▶') : ''}</span>
                          {r.name}
                          {r.installed && r.allCount === 0 && (
                            <span className="model-chip skill-flag" title={(r.source === 'plugin'
                              ? 'provided by an installed plugin'
                              : 'installed under ~/.claude/skills') + ' but never fired in any indexed session'}>never fired</span>
                          )}
                          {r.installed && r.allCount > 0 && Date.now() - r.allLastTs > 60 * 864e5 && (
                            <span className="model-chip skill-flag" title={'last fired ' + fmtDate(r.allLastTs)}>
                              idle {Math.floor((Date.now() - r.allLastTs) / 864e5)}d
                            </span>
                          )}
                          {!r.installed && r.allCount > 0 && (
                            <span className="model-chip skill-flag" title="fired in the archive but absent from the current inventory">not installed</span>
                          )}
                        </td>
                        <td>{num(r.count)}</td>
                        <td>{num(r.claude)}</td>
                        <td>{num(r.you)}</td>
                        <td>{num(r.sessions.size)}</td>
                        <td>{r.firstTs ? fmtDate(r.firstTs) : ''}</td>
                        <td>{r.lastTs ? fmtDate(r.lastTs) : ''}</td>
                        <td className="trend">
                          {r.count > 0 && (
                            <span className="skill-trend">
                              {skills.months.map((m) => {
                                const n = r.byMonth.get(m) || 0;
                                return (
                                  <i
                                    key={m}
                                    className={n ? '' : 'zero'}
                                    style={n ? { height: (3 + Math.round(11 * n / trendMax)) + 'px' } : undefined}
                                    title={periodLabel(m, 'month') + ': ' + n}
                                  />
                                );
                              })}
                            </span>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="skill-detail">
                          <td colSpan={8} className="l">
                            {(() => {
                              const lines = [...r.sessions.values()].sort((a, b) => b.ts - a.ts);
                              if (lines.length === 0) {
                                return (
                                  <div className="skill-none">
                                    None of this skill's sessions are in this view. They may sit outside the
                                    date filter, or their transcripts have been pruned from disk.
                                  </div>
                                );
                              }
                              return (
                                <>
                                  {lines.slice(0, 30).map((ln) => (
                                    <div className="skill-session" key={ln.s.id} onClick={() => onOpenSession(ln.s, ln.uuid)}>
                                      <span className="t">{ln.s.title || 'Untitled session'}</span>
                                      <span className="p">{(ln.s.projectPath || '').split('/').pop()}</span>
                                      <span>{fmtDate(ln.ts)}</span>
                                      {ln.count > 1 && <span className="n">x{ln.count}</span>}
                                    </div>
                                  ))}
                                  {lines.length > 30 && <div className="skill-none">+{lines.length - 30} more sessions</div>}
                                </>
                              );
                            })()}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- the tape (scrubber) ----------

function Tape({ events, onSeek, scrollFraction, theme }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const [tip, setTip] = useState(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const colors = themeEventColors();
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const n = events.length;
    if (!n) return;
    const mid = h / 2;

    for (let i = 0; i < n; i++) {
      const ev = events[i];
      const x = n === 1 ? w / 2 : (i / (n - 1)) * (w - 4) + 2;
      let color = colors[ev.kind] || colors.system;
      if (ev.kind === 'tool' && ev.isError) color = colors.error;
      let hh; // half-height
      switch (ev.kind) {
        case 'user': hh = 26; break;
        case 'assistant': hh = 15; break;
        case 'thinking': hh = 9; break;
        case 'tool': hh = 12; break;
        default: hh = 5;
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = ev.kind === 'user' ? 0.95 : 0.6;
      ctx.lineWidth = ev.kind === 'user' ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(x, mid - hh);
      ctx.lineTo(x, mid + hh);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // playhead
    const px = 2 + scrollFraction * (w - 4);
    ctx.strokeStyle = colors.brass;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(px, 2);
    ctx.lineTo(px, h - 2);
    ctx.stroke();
    ctx.fillStyle = colors.brass;
    ctx.beginPath();
    ctx.moveTo(px - 4, 0); ctx.lineTo(px + 4, 0); ctx.lineTo(px, 6);
    ctx.closePath(); ctx.fill();
  }, [events, scrollFraction, theme]);

  useEffect(() => {
    draw();
    const obs = new ResizeObserver(draw);
    if (wrapRef.current) obs.observe(wrapRef.current);
    return () => obs.disconnect();
  }, [draw]);

  const eventAt = (clientX) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left - 2) / (rect.width - 4)));
    const idx = Math.round(frac * (events.length - 1));
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    return { idx, frac, x };
  };

  const showTip = (idx, x) => {
    const ev = events[idx];
    const label = ev.kind === 'tool'
      ? `${ev.toolName} ${ev.toolSummary || ''}`
      : (ev.text || '').slice(0, 60);
    setTip({ x, kind: ev.kind === 'tool' ? ev.toolName : ev.kind, label, time: fmtTime(ev.ts) });
  };

  const handleMove = (e) => {
    if (!events.length) return;
    const { idx, x } = eventAt(e.clientX);
    if (e.buttons === 1) onSeek(idx);
    showTip(idx, x);
  };

  return (
    <div className="tape-wrap">
      <div
        ref={wrapRef}
        className="tape"
        onPointerMove={handleMove}
        onPointerLeave={() => setTip(null)}
        onPointerDown={(e) => {
          if (!events.length) return;
          // Capture so a drag keeps scrubbing even off the strip.
          e.currentTarget.setPointerCapture(e.pointerId);
          const { idx, x } = eventAt(e.clientX);
          onSeek(idx);
          showTip(idx, x);
        }}
      >
        <canvas ref={canvasRef} />
        {tip && (
          <div className="tape-tip" style={{ left: tip.x }}>
            <span className="k">{tip.kind}</span> {tip.time} — {tip.label}
          </div>
        )}
      </div>
      <div className="tape-legend">
        <span><span className="dot" style={{ background: 'var(--ev-user)' }} />you</span>
        <span><span className="dot" style={{ background: 'var(--ev-assistant)' }} />claude</span>
        <span><span className="dot" style={{ background: 'var(--ev-thinking)' }} />thinking</span>
        <span><span className="dot" style={{ background: 'var(--ev-tool)' }} />tools</span>
        <span><span className="dot" style={{ background: 'var(--ev-error)' }} />errors</span>
      </div>
    </div>
  );
}

// ---------- transcript events ----------

function Collapsible({ className, head, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={'ev ev-collapsible ' + className}>
      <div className="head" onClick={() => setOpen(!open)}>
        <span className="twist">{open ? '▼' : '▶'}</span>
        {head}
      </div>
      {open && children}
    </div>
  );
}

function EventImages({ images }) {
  if (!images || !images.length) return null;
  return (
    <div className="ev-imgs">
      {images.map((im, i) => (
        <img key={i} className="ev-img" src={`data:${im.mediaType};base64,${im.data}`} alt="" />
      ))}
    </div>
  );
}

function EventBlock({ ev, idx }) {
  switch (ev.kind) {
    case 'user':
      return (
        <div className="ev ev-user" data-idx={idx} id={'ev-' + idx}>
          <div className="who">you · {fmtTime(ev.ts)}</div>
          {ev.text && <div className="body">{ev.text}</div>}
          <EventImages images={ev.images} />
        </div>
      );
    case 'compact':
      return (
        <div className="ev compact-marker" data-idx={idx} id={'ev-' + idx}>
          context compacted
        </div>
      );
    case 'assistant':
      return (
        <div className="ev ev-assistant" data-idx={idx} id={'ev-' + idx}>
          <Markdown text={ev.text} />
        </div>
      );
    case 'thinking':
      return (
        <div data-idx={idx} id={'ev-' + idx}>
          <Collapsible className="ev-thinking" head={<>
            <span className="tag">thinking</span>
            <span className="summary">{(ev.text || '').slice(0, 80).replace(/\n/g, ' ')}…</span>
          </>}>
            <div className="body">{ev.text}</div>
          </Collapsible>
        </div>
      );
    case 'tool':
      return (
        <div data-idx={idx} id={'ev-' + idx}>
          <Collapsible className={'ev-tool' + (ev.isError ? ' is-error' : '')} head={<>
            <span className="tag">{ev.toolName}</span>
            <span className="summary">{ev.toolSummary}</span>
            {ev.durationMs > 800 && <span className="dur">{fmtDuration(ev.durationMs)}</span>}
          </>}>
            <div className="detail">
              <div className="sec">input</div>
              <pre>{ev.input}</pre>
              {ev.result != null && <>
                <div className="sec">{ev.isError ? 'error' : 'result'}</div>
                {(ev.result || !(ev.resultImages && ev.resultImages.length)) &&
                  <pre>{ev.result || '(empty)'}</pre>}
                <EventImages images={ev.resultImages} />
              </>}
            </div>
          </Collapsible>
        </div>
      );
    case 'system':
      return <div className="ev ev-system" data-idx={idx} id={'ev-' + idx}>{ev.text}</div>;
    default:
      return null;
  }
}

// ---------- session view ----------

function Reel({ events, theme, jumpToUuid, onJumped }) {
  const [scrollFraction, setScrollFraction] = useState(0);
  const scrollRef = useRef(null);
  const pinGen = useRef(0);

  // Transcript blocks use content-visibility:auto, so off-screen heights are
  // estimates; one scrollIntoView lands on the estimate and the real layout
  // then shifts the target away (scroll anchoring can move scrollTop too).
  // Re-pin every frame until the position holds still, but let go the moment
  // the user scrolls themselves.
  const pinTo = useCallback((el, block) => {
    const box = scrollRef.current;
    const gen = ++pinGen.current;
    let last = NaN, stable = 0, tries = 0;
    const cancel = () => { pinGen.current++; };
    const cleanup = () => {
      if (!box) return;
      box.removeEventListener('wheel', cancel);
      box.removeEventListener('touchstart', cancel);
    };
    if (box) {
      box.addEventListener('wheel', cancel, { passive: true });
      box.addEventListener('touchstart', cancel, { passive: true });
    }
    const pin = () => {
      if (pinGen.current !== gen) { cleanup(); return; }
      if (block === 'center' || !box) {
        el.scrollIntoView({ block: 'center' });
      } else {
        // Place the event at the sliding reference line (viewport top at
        // scroll start, viewport bottom at scroll end) — the same line the
        // playhead reads — so the playhead lands exactly where you clicked.
        const max = box.scrollHeight - box.clientHeight;
        const elTop = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
        box.scrollTop = max <= 0 ? 0 : Math.min(max, Math.max(0, elTop / (1 + box.clientHeight / max)));
      }
      const top = box ? box.scrollTop : 0;
      stable = Math.abs(top - last) < 1 ? stable + 1 : 0;
      last = top;
      tries++;
      // Chromium lays out content-visibility chunks over several frames, so
      // hold the pin a minimum window even if the position looks stable.
      if ((stable < 3 || tries < 12) && tries < 60) requestAnimationFrame(pin);
      else cleanup();
    };
    pin();
  }, []);

  useEffect(() => () => { pinGen.current++; }, []);

  useEffect(() => {
    if (!jumpToUuid) return;
    // Search hits inside tool output carry the result line's uuid, which lives
    // on the tool event as resultUuid, not uuid.
    const idx = events.findIndex((e) => e.uuid === jumpToUuid || e.resultUuid === jumpToUuid);
    if (idx >= 0) {
      if (onJumped) onJumped(jumpToUuid);
      requestAnimationFrame(() => {
        const el = document.getElementById('ev-' + idx);
        if (el) pinTo(el, 'center');
      });
    }
  }, [events, jumpToUuid]);

  // The playhead lives in the same space as the tape's ticks (event index),
  // not raw scroll pixels — event heights vary too much for pixels to line up.
  // Read which event crosses the reference line and interpolate within it.
  const onScroll = useCallback(() => {
    const box = scrollRef.current;
    if (!box || !events.length) return;
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 0) return;
    const refY = box.getBoundingClientRect().top + (box.scrollTop / max) * box.clientHeight;
    let lo = 0, hi = events.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const el = document.getElementById('ev-' + mid);
      if (el && el.getBoundingClientRect().top <= refY) lo = mid; else hi = mid - 1;
    }
    const el = document.getElementById('ev-' + lo);
    let within = 0;
    if (el) {
      const r = el.getBoundingClientRect();
      within = r.height > 0 ? Math.min(1, Math.max(0, (refY - r.top) / r.height)) : 0;
    }
    setScrollFraction(Math.min(1, (lo + within) / Math.max(1, events.length - 1)));
  }, [events]);

  const seek = useCallback((idx) => {
    const el = document.getElementById('ev-' + idx);
    if (!el) return;
    pinTo(el, 'start');
    const box = scrollRef.current;
    // Short transcript with no scroll range: move the playhead directly.
    if (box && box.scrollHeight - box.clientHeight <= 0) {
      setScrollFraction(idx / Math.max(1, events.length - 1));
    }
  }, [pinTo, events]);

  // Insert day markers when the session spans multiple days
  const blocks = [];
  let lastDay = null;
  events.forEach((ev, i) => {
    if (ev.ts) {
      const day = new Date(ev.ts).toDateString();
      if (day !== lastDay) {
        if (lastDay !== null) blocks.push(<div className="ts-marker" key={'d' + i}>{day}</div>);
        lastDay = day;
      }
    }
    blocks.push(<EventBlock ev={ev} idx={i} key={i} />);
  });

  return (
    <>
      <Tape events={events} onSeek={seek} scrollFraction={scrollFraction} theme={theme} />
      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="transcript-inner">{blocks}</div>
      </div>
    </>
  );
}

function sessionCost(meta) {
  let total = 0, priced = false;
  for (const day of Object.values(meta.daily || {})) {
    for (const [model, u] of Object.entries(day)) {
      const c = costOf(model, u);
      if (c != null) { total += c; priced = true; }
    }
  }
  return priced ? total : null;
}

function SubagentView({ sessionId, agent, theme, onBack }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setData(null); setFailed(false);
    let alive = true;
    api.readSubagent(sessionId, agent.id)
      .then((d) => { if (alive) { if (d && d.events) setData(d); else setFailed(true); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [sessionId, agent.id]);

  const back = <span className="reveal" onClick={onBack}>← back to session</span>;

  if (failed) {
    return (
      <div className="session-view">
        <div className="sv-head"><div className="sv-meta" style={{ marginBottom: 6 }}>{back}</div></div>
        <div className="empty"><div className="glyph">◉</div>
          <div className="msg">This subagent reel couldn't be loaded.</div>
          <div className="sub">the transcript may have moved or been removed</div>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="session-view">
        <div className="sv-head"><div className="sv-meta" style={{ marginBottom: 6 }}>{back}</div></div>
        <div className="empty"><div className="glyph">◉</div><div className="sub">loading subagent reel…</div></div>
      </div>
    );
  }
  return (
    <div className="session-view">
      <div className="sv-head">
        <div className="sv-meta" style={{ marginBottom: 6 }}>{back}</div>
        <div className="sv-title">{data.title || agent.title || `subagent ${agent.id.slice(0, 8)}`}</div>
        <div className="sv-meta">
          <span className="brass">subagent · agent-{agent.id.slice(0, 10)}</span>
          {agent.workflow && <span>{agent.workflow}</span>}
          <span>{data.events.length} events</span>
        </div>
      </div>
      <Reel events={data.events} theme={theme} />
    </div>
  );
}

function CopyChip({ label, value, title, className = 'copy-chip' }) {
  const [copied, setCopied] = useState(false);
  return (
    <span
      className={className + (copied ? ' copied' : '')}
      title={title}
      onClick={() => navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })}
    >
      {copied ? 'copied ✓' : label}
    </span>
  );
}

function SessionView({ sessionId, jumpToUuid, theme }) {
  const [data, setData] = useState(null);
  const [openAgent, setOpenAgent] = useState(null);
  const [exportState, setExportState] = useState(null); // 'md' | 'html' while in flight
  const [settings, setSettings] = useState(null);
  const [editingTpl, setEditingTpl] = useState(false);
  const [tplDraft, setTplDraft] = useState('');
  const [saveErr, setSaveErr] = useState(false);
  const jumpedRef = useRef(null); // consume each jumpToUuid once, so returning from a subagent doesn't re-jump

  useEffect(() => {
    let alive = true;
    api.getSettings().then((s) => { if (alive) setSettings(s); });
    return () => { alive = false; };
  }, []);

  const saveTpl = () => {
    api.saveSettings({ resumeTemplate: tplDraft }).then((s) => {
      setSettings(s);
      // A failed write leaves the editor open holding the draft, rather than
      // closing as if the template had been saved.
      if (s && s.saveFailed) setSaveErr(true);
      else setEditingTpl(false);
    });
  };

  useEffect(() => {
    setData(null);
    setOpenAgent(null);
    setEditingTpl(false); // a half-typed draft must not follow you to another session
    setSaveErr(false);
    jumpedRef.current = null;
    let alive = true;
    // null means the id is gone from the index (transcript pruned between
    // refreshes); keep it distinct from "still loading" or the view spins.
    api.readSession(sessionId).then((d) => { if (alive) setData(d || { missing: true }); });
    return () => { alive = false; };
  }, [sessionId]);

  const doExport = (fmt) => {
    if (exportState) return; // guard against double-click running the export twice
    setExportState(fmt);
    Promise.resolve(api.exportSession(sessionId, fmt)).finally(() => setExportState(null));
  };

  // Only hand the jump to Reel until it's been consumed for this session.
  const effectiveJump = jumpToUuid && jumpedRef.current !== jumpToUuid ? jumpToUuid : null;

  if (!data) {
    return <div className="stage"><div className="empty"><div className="glyph">◉</div><div className="sub">loading reel…</div></div></div>;
  }

  if (data.missing) {
    return (
      <div className="stage"><div className="empty">
        <div className="glyph">◌</div>
        <div className="sub">this session is no longer in the index; its transcript was likely pruned from disk</div>
      </div></div>
    );
  }

  if (openAgent) {
    return <SubagentView sessionId={sessionId} agent={openAgent} theme={theme} onBack={() => setOpenAgent(null)} />;
  }

  const m = data.meta;
  const models = Object.keys(m.models).map(modelShort).join(', ');
  const dur = m.firstTs && m.lastTs ? fmtDuration(m.lastTs - m.firstTs) : '';
  const cost = sessionCost(m);
  const subs = data.subagents || [];

  return (
    <div className="session-view">
      <div className="sv-head">
        <div className="sv-title">{m.title || 'Untitled session'}</div>
        <div className="sv-meta">
          <span className="chip">{fmtDate(m.firstTs)} {fmtTime(m.firstTs)}</span>
          {dur && <span>{dur}</span>}
          <span className="brass">{models}</span>
          <span>{m.userTurns} prompts</span>
          <span>{m.toolCalls} tool runs</span>
          <span>{fmtTokens(m.tokens.output)} tokens out</span>
          {cost != null && <span className="brass">≈{fmtUSD(cost)}</span>}
          {data.abandonedCount > 0 && <span>{data.abandonedCount} rewound events hidden</span>}
          <span className="reveal" onClick={() => api.revealSession(sessionId)}>reveal file</span>
          <span className={'reveal' + (exportState ? ' busy' : '')} onClick={() => doExport('md')}>
            {exportState === 'md' ? 'exporting…' : 'export md'}
          </span>
          <span className={'reveal' + (exportState ? ' busy' : '')} onClick={() => doExport('html')}>
            {exportState === 'html' ? 'exporting…' : 'export html'}
          </span>
          {m.cwd && settings && (
            <>
              <CopyChip
                className="reveal"
                label="resume"
                value={buildResumeCmd(settings.resumeTemplate, m.cwd, sessionId)}
                title={'copy: ' + buildResumeCmd(settings.resumeTemplate, m.cwd, sessionId)}
              />
              <span
                className="reveal"
                title="edit the resume command template"
                onClick={() => {
                  setTplDraft(settings.resumeTemplate);
                  setSaveErr(false);
                  setEditingTpl((v) => !v);
                }}
              >✎</span>
            </>
          )}
        </div>
        <div className="sv-path">
          {m.cwd && <CopyChip label={m.cwd} value={m.cwd} title="working directory · click to copy" />}
          {m.cwd && <span className="sep">·</span>}
          <CopyChip label={sessionId} value={sessionId} title="session id · click to copy" />
        </div>
        {editingTpl && m.cwd && settings && (
          <div className="resume-edit">
            <input
              value={tplDraft}
              spellCheck={false}
              autoFocus
              maxLength={settings.templateMax || 500}
              onChange={(e) => setTplDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveTpl(); if (e.key === 'Escape') setEditingTpl(false); }}
            />
            <span className="reveal" onClick={saveTpl}>save</span>
            <span className="reveal" onClick={() => setTplDraft(settings.resumeTemplateDefault)}>reset</span>
            <span className="re-hint">
              {saveErr
                ? 'could not write settings, the template was not saved'
                : <>{'{cwd}'} and {'{sessionId}'} are inserted shell-quoted · aliases from your shell work here</>}
            </span>
          </div>
        )}
        {subs.length > 0 && (
          <div className="sub-strip">
            <span className="sub-strip-label">{subs.length} subagent reel{subs.length === 1 ? '' : 's'}</span>
            {subs.slice(0, 60).map((a) => (
              <span key={a.filePath} className="sub-chip" title={a.title || a.id} onClick={() => setOpenAgent(a)}>
                ▸ {a.title ? a.title.slice(0, 44) : (a.workflow ? a.workflow + '/' : '') + 'agent-' + a.id.slice(0, 8)}
              </span>
            ))}
            {subs.length > 60 && <span className="sub-strip-label">+{subs.length - 60} more</span>}
          </div>
        )}
      </div>
      <Reel events={data.events} theme={theme} jumpToUuid={effectiveJump}
        onJumped={(u) => { jumpedRef.current = u; }} />
    </div>
  );
}

// ---------- search overlay ----------

function SearchOverlay({ sessions, onClose, onOpenSession, initialQuery }) {
  const [q, setQ] = useState(initialQuery || '');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const seq = useRef(0);
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  useEffect(() => {
    if (q.trim().length < 2) {
      seq.current++; // invalidate any in-flight search
      setResults(null);
      setBusy(false);
      return;
    }
    const mySeq = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      const r = await api.search(q);
      if (seq.current === mySeq) { setResults(r); setBusy(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const highlight = (snippet) => {
    const i = snippet.toLowerCase().indexOf(q.trim().toLowerCase());
    if (i < 0) return snippet;
    return <>
      {snippet.slice(0, i)}
      <mark>{snippet.slice(i, i + q.trim().length)}</mark>
      {snippet.slice(i + q.trim().length)}
    </>;
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette">
        <input
          ref={inputRef}
          placeholder="Search every session ever…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        />
        <div className="palette-results">
          {!results && !busy && (
            <div className="palette-hint">
              Full-text search across {sessions.length.toLocaleString()} transcripts — prompts, replies, thinking, commands, results.
            </div>
          )}
          {busy && <div className="palette-hint">searching the archive…</div>}
          {results && results.length === 0 && !busy && (
            <div className="palette-hint">Nothing in the archive matches "{q}".</div>
          )}
          {results && results.map((r) => {
            const s = sessionsById.get(r.sessionId);
            if (!s) return null;
            return (
              <div
                key={r.sessionId}
                className="result"
                onClick={() => onOpenSession(s, r.snippets[0]?.uuid)}
              >
                <div className="r-title">{s.title || 'Untitled session'}</div>
                <div className="r-meta">{fmtDate(s.lastTs)} · {(s.projectPath || '').split('/').pop()}</div>
                {r.snippets.map((sn, i) => (
                  <div className="r-snip" key={i}>
                    <span className="role">{sn.role}</span> {highlight(sn.snippet)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- error boundary ----------

class Boundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="empty">
          <div className="glyph">◉</div>
          <div className="msg">This view hit an error and stopped.</div>
          <div className="sub">{String(this.state.error && this.state.error.message || this.state.error).slice(0, 200)}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------- app ----------

// A live re-index ships brand-new objects for every session, which defeats
// every React.memo downstream and re-renders the whole UI each time the
// watcher fires (constantly, while a Claude Code session is running). Reuse
// the previous object whenever the fields the UI reads are unchanged; a
// typical rescan then touches one session and every other card bails.
const sameTokens = (a, b) =>
  a.input === b.input && a.output === b.output &&
  a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;

// Global claiming can move a skill record between files without touching the
// file itself (a restored older transcript claims ids a newer fork held), so
// records are compared, not assumed stable under mtime+size.
const sameSkills = (a, b) => {
  const ra = a.skills || [], rb = b.skills || [];
  if (ra.length !== rb.length) return false;
  for (let i = 0; i < ra.length; i++) {
    if (ra[i].n !== rb[i].n || ra[i].t !== rb[i].t ||
        ra[i].u !== rb[i].u || ra[i].ts !== rb[i].ts) return false;
  }
  const ba = a.builtins || {}, bb = b.builtins || {};
  const ka = Object.keys(ba);
  if (ka.length !== Object.keys(bb).length) return false;
  for (const k of ka) if (ba[k] !== bb[k]) return false;
  return true;
};

function mergeIndex(prev, next) {
  const prevSessions = new Map(prev.sessions.map((s) => [s.id, s]));
  let sessionsSame = prev.sessions.length === next.sessions.length;
  const sessions = next.sessions.map((s, i) => {
    const p = prevSessions.get(s.id);
    // filePath too: a transcript relocated with mtime/size intact (project dir
    // re-encode, restore from another machine) must not keep the old path or
    // its project attribution alive.
    if (p && p.mtime === s.mtime && p.size === s.size && p.filePath === s.filePath &&
        p.title === s.title && p.lastTs === s.lastTs && p.toolCalls === s.toolCalls &&
        sameTokens(p.tokens, s.tokens) && sameSkills(p, s)) {
      if (prev.sessions[i] !== p) sessionsSame = false;
      return p;
    }
    sessionsSame = false;
    return s;
  });
  const prevProjects = new Map(prev.projects.map((p) => [p.id, p]));
  let projectsSame = prev.projects.length === next.projects.length;
  const projects = next.projects.map((n, i) => {
    const p = prevProjects.get(n.id);
    if (p && p.name === n.name && p.path === n.path && p.sessions === n.sessions &&
        p.lastTs === n.lastTs && p.tokens === n.tokens) {
      if (prev.projects[i] !== p) projectsSame = false;
      return p;
    }
    projectsSame = false;
    return n;
  });
  // Preserve the inventory's identity when its content is unchanged, so a
  // quiet rescan does not recompute the skills memo downstream.
  const pi = prev.skillInventory || [], ni = next.skillInventory || [];
  const invSame = pi.length === ni.length &&
    ni.every((it, i) => pi[i] && pi[i].name === it.name && pi[i].source === it.source);
  if (sessionsSame && projectsSame && invSame && prev.indexing === next.indexing) return prev;
  return {
    projects: projectsSame ? prev.projects : projects,
    sessions: sessionsSame ? prev.sessions : sessions,
    skillInventory: invSame ? pi : ni,
    indexing: next.indexing,
  };
}

function App() {
  const [index, setIndex] = useState({ projects: [], sessions: [], skillInventory: [], indexing: true });
  const [progress, setProgress] = useState(null);
  const [selectedProject, setSelectedProject] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [jumpToUuid, setJumpToUuid] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchSeed, setSearchSeed] = useState('');
  const [view, setView] = useState('archive'); // 'archive' | 'ledger' | 'skills'
  const [dateFilter, setDateFilter] = useState({ preset: 'all', from: null, to: null });
  const [modelFilter, setModelFilter] = useState(new Set());
  const [themePref, setThemePref] = useState(() => localStorage.getItem('hindcast-theme') || 'auto');
  const [resolvedTheme, setResolvedTheme] = useState(() => document.documentElement.dataset.theme || 'dark');

  useEffect(() => {
    localStorage.setItem('hindcast-theme', themePref);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = themePref === 'dark' || (themePref === 'auto' && mq.matches);
      const t = dark ? 'dark' : 'light';
      document.documentElement.dataset.theme = t;
      setResolvedTheme(t);
    };
    apply();
    if (themePref === 'auto') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [themePref]);

  useEffect(() => {
    // Main process persists this so next launch paints the right background
    if (api.saveTheme) api.saveTheme({ pref: themePref, resolved: resolvedTheme });
  }, [themePref, resolvedTheme]);

  // Relative presets compare against "now" — nudge the memo forward each minute
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    if (!(dateFilter.preset in PRESET_MS)) return;
    const t = setInterval(() => setNowTick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, [dateFilter.preset]);

  const loadIndex = useCallback(async () => {
    const idx = await api.getIndex();
    setIndex((prev) => mergeIndex(prev, idx));
  }, []);

  useEffect(() => {
    loadIndex();
    const off1 = api.onIndexProgress((p) => setProgress(p));
    const off2 = api.onIndexReady(() => { setProgress(null); loadIndex(); });
    return () => { off1(); off2(); };
  }, [loadIndex]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchSeed('');
        setSearchOpen((v) => !v);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const visibleSessions = useMemo(() => {
    if (!selectedProject) return index.sessions;
    return index.sessions.filter((s) => s.project === selectedProject);
  }, [index.sessions, selectedProject]);

  // Faceted pipeline: project scope → date filter → model filter.
  const dateScoped = useMemo(
    () => visibleSessions.filter((s) => sessionPassesDate(s, dateFilter)),
    [visibleSessions, dateFilter, nowTick]
  );
  const modelOptions = useMemo(() => {
    const counts = new Map();
    for (const s of dateScoped) {
      for (const m of Object.keys(s.models)) counts.set(m, (counts.get(m) || 0) + 1);
    }
    const opts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, name: modelShort(id), count }));
    // If two snapshots collapse to the same short name, show full ids instead
    const nameCounts = {};
    for (const o of opts) nameCounts[o.name] = (nameCounts[o.name] || 0) + 1;
    for (const o of opts) if (nameCounts[o.name] > 1) o.name = o.id;
    return opts;
  }, [dateScoped]);
  const filteredSessions = useMemo(() => {
    if (!modelFilter.size) return dateScoped;
    return dateScoped.filter((s) => Object.keys(s.models).some((m) => modelFilter.has(m)));
  }, [dateScoped, modelFilter]);

  const anyFilter = dateFilter.preset !== 'all' || modelFilter.size > 0;

  // Rail counts follow the active filters (across ALL projects, regardless of
  // the current scope), so the numbers next to each project answer "how many
  // sessions would I see there under this filter".
  const railCounts = useMemo(() => {
    const byProject = new Map();
    let total = 0;
    for (const s of index.sessions) {
      if (!sessionPassesDate(s, dateFilter)) continue;
      if (modelFilter.size && !Object.keys(s.models).some((m) => modelFilter.has(m))) continue;
      total++;
      byProject.set(s.project, (byProject.get(s.project) || 0) + 1);
    }
    return { total, byProject };
  }, [index.sessions, dateFilter, modelFilter, nowTick]);

  const clearFilters = () => {
    setDateFilter({ preset: 'all', from: null, to: null });
    setModelFilter(new Set());
  };

  // Stable handlers so the memoized Rail and session cards skip re-renders.
  const selectFromRail = useCallback((p, v) => {
    setView(v || 'archive');
    if (p !== selectedProject) {
      setModelFilter(new Set()); // scope changed; a stale selection would be invisible and uncheckable
    }
    setSelectedProject(p); setSelectedSession(null);
  }, [selectedProject]);

  const selectSession = useCallback((id) => {
    setSelectedSession(id); setJumpToUuid(null); setView('archive');
  }, []);

  const projectName = selectedProject
    ? index.projects.find((p) => p.id === selectedProject)?.name
    : null;

  const openFromSearch = (session, uuid) => {
    setView('archive'); // otherwise the rail keeps highlighting The Ledger over an open session
    setSelectedProject(session.project);
    setSelectedSession(session.id);
    setJumpToUuid(uuid || null);
    setSearchOpen(false);
  };

  const dayInRange = useMemo(() => makeDayInRange(dateFilter), [dateFilter]);

  return (
    <div className="app">
      <Rail
        projects={index.projects}
        selected={selectedProject}
        view={view}
        onSelect={selectFromRail}
        totalSessions={railCounts.total}
        projectCounts={railCounts.byProject}
        filtersActive={anyFilter}
        themePref={themePref}
        setThemePref={setThemePref}
        skillCount={(index.skillInventory || []).length}
      />
      <SessionList
        key={selectedProject || '(all)'} /* remount on scope change clears the title query (also resets list scroll and dropdown state, which the old App-owned clear did not) */
        sessions={filteredSessions}
        selectedId={selectedSession}
        onSelect={selectSession}
        projectName={projectName}
        anyFilter={anyFilter}
        onClearFilters={clearFilters}
        onSearchTranscripts={(q) => { setSearchSeed(q); setSearchOpen(true); }}
        filterBar={
          <FilterBar
            dateFilter={dateFilter} setDateFilter={setDateFilter}
            modelFilter={modelFilter} setModelFilter={setModelFilter}
            modelOptions={modelOptions}
          />
        }
      />
      <div className="stage">
        <Boundary resetKey={[selectedSession || 'none', view, selectedProject || 'all', dateFilter.preset, modelFilter.size].join('|')}>
          {selectedSession
            ? <SessionView sessionId={selectedSession} jumpToUuid={jumpToUuid} theme={resolvedTheme} />
            : view === 'skills'
              ? <Skills
                  scopeSessions={visibleSessions}
                  allSessions={index.sessions}
                  dayInRange={dayInRange}
                  dateFilter={dateFilter}
                  skillInventory={index.skillInventory || []}
                  onOpenSession={openFromSearch}
                />
            : view === 'ledger'
              ? <Ledger sessions={filteredSessions} dayInRange={dayInRange} modelFilter={modelFilter} />
              : <Archive
                  sessions={filteredSessions}
                  indexing={index.indexing || !!progress}
                  progress={progress}
                  filtered={anyFilter}
                />}
        </Boundary>
      </div>
      {searchOpen && (
        <SearchOverlay
          sessions={index.sessions}
          initialQuery={searchSeed}
          onClose={() => setSearchOpen(false)}
          onOpenSession={openFromSearch}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
