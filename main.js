const { app, BrowserWindow, ipcMain, shell, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { PROJECTS_DIR, buildIndex, parseSession, listSubagents } = require('./lib/scanner');
const { search } = require('./lib/search');
const { exportSession } = require('./lib/export');
const { parseCodexSession, SESSIONS_DIR: CODEX_SESSIONS, ARCHIVED_DIR: CODEX_ARCHIVED, SESSION_ID_RE } = require('./lib/codex');
const { parseGrokSession, SESSIONS_DIR: GROK_SESSIONS } = require('./lib/grok');

let win = null;
let index = { projects: [], sessions: [], skillInventory: [] };
let sessionsById = new Map();
let indexing = false;

const CACHE_PATH = () => path.join(app.getPath('userData'), 'index-cache.json');

function loadCache() {
  try {
    return { entries: JSON.parse(fs.readFileSync(CACHE_PATH(), 'utf8')), dirty: false };
  } catch {
    return { entries: {}, dirty: false };
  }
}

function saveCache(cache) {
  if (!cache.dirty) return;
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH()), { recursive: true });
    fs.writeFileSync(CACHE_PATH(), JSON.stringify(cache.entries));
  } catch {}
}

let firstIndexDone = false;
let lastIndexSig = null;
let servedWhileIndexing = false;

async function refreshIndex() {
  if (indexing) return;
  indexing = true;
  const cache = loadCache();
  try {
    // Watch-triggered rescans are mtime-cached and near-instant; progress
    // flicker is only worth showing while the first full index streams. But
    // a later rescan can turn out to be a bulk re-parse (cache file deleted,
    // format-version bump, transcripts restored from another machine), and
    // going silent for one of those would look like a hang; once the rescan
    // has re-parsed enough files to matter, progress comes back.
    const isFirstIndex = !firstIndexDone;
    let sentProgress = false;
    let lastParsed = 0;
    index = await buildIndex(cache, (p) => {
      lastParsed = p.parsed;
      if (!isFirstIndex && p.parsed < 25) return;
      sentProgress = true;
      if (win && !win.isDestroyed()) win.webContents.send('index:progress', p);
    });
    sessionsById = new Map(index.sessions.map((s) => [s.id, s]));
    saveCache(cache);
    // Active Claude Code sessions fire the watcher constantly; when a rescan
    // produces an identical index, skip the ready ping so the renderer
    // doesn't reload and re-render the whole app for nothing. The signature
    // is (path, mtime, size) of every main transcript; with the dedup
    // tiebreak in scanner.js the shipped index is a pure function of that
    // set, with two exceptions that need their own handling. Subagent files
    // fold into cached meta without appearing in the signature; that is why
    // any rescan that actually re-parsed files (lastParsed > 0) always
    // pings: after a cache loss the re-parse can pick up changed subagent
    // usage under an unchanged signature. And the skill inventory is
    // re-read from ~/.claude/skills and the plugin manifest on every build,
    // so it gets its own signature term, or a skill installed while the app
    // is open would never reach the renderer on a quiet rescan. Kept over
    // JSON.stringify(index), which re-stringified the whole shipped index
    // every rescan and held the result in memory for the life of the app.
    const sig = index.sessions
      .map((s) => s.filePath + ':' + s.mtime + ':' + s.size)
      .sort()
      .join('|')
      + '#' + (index.skillInventory || []).map((i) => i.source + ':' + i.name).join('|')
      + '#z' + (index.skippedZstd || 0);
    const changed = sig !== lastIndexSig;
    lastIndexSig = sig;
    // sentProgress keeps a visible progress bar from sticking; lastParsed
    // covers re-parses too small to have shown progress; servedWhileIndexing
    // unsticks a renderer that snapshotted indexing:true mid-rescan.
    const mustPing = changed || !firstIndexDone || sentProgress || lastParsed > 0 || servedWhileIndexing;
    if (mustPing && win && !win.isDestroyed()) {
      win.webContents.send('index:ready');
    }
    servedWhileIndexing = false;
    firstIndexDone = true;
  } finally {
    indexing = false;
  }
}

const THEME_PATH = () => path.join(app.getPath('userData'), 'theme.json');

function readTheme() {
  try { return JSON.parse(fs.readFileSync(THEME_PATH(), 'utf8')); }
  catch { return { pref: 'auto', resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' }; }
}

const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
const {
  RESUME_TEMPLATE_DEFAULT, CODEX_RESUME_TEMPLATE_DEFAULT, GROK_RESUME_TEMPLATE_DEFAULT, TEMPLATE_MAX,
} = require('./lib/resume');
let settingsCache = null;

const TEMPLATE_KEYS = {
  resumeTemplate: RESUME_TEMPLATE_DEFAULT,
  codexResumeTemplate: CODEX_RESUME_TEMPLATE_DEFAULT,
  grokResumeTemplate: GROK_RESUME_TEMPLATE_DEFAULT,
};

function readSettings() {
  if (!settingsCache) {
    try { settingsCache = JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8')); }
    catch { settingsCache = {}; }
    // a hand-edited file can hold valid JSON that is not an object
    if (!settingsCache || typeof settingsCache !== 'object' || Array.isArray(settingsCache)) settingsCache = {};
  }
  const out = { templateMax: TEMPLATE_MAX };
  for (const [key, fallback] of Object.entries(TEMPLATE_KEYS)) {
    const stored = settingsCache[key];
    out[key] = typeof stored === 'string' && stored.trim() ? stored : fallback;
    out[key + 'Default'] = fallback;
  }
  return out;
}

function createWindow() {
  const theme = readTheme();
  nativeTheme.themeSource = theme.pref === 'auto' ? 'system' : theme.pref;
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: theme.resolved === 'light' ? '#f3efe5' : '#141210',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Live index: re-scan (cheap, mtime-cached) when a transcript is written, so
// sessions appear while you work. Debounced hard because active sessions
// append constantly. A directory that is not there yet is tried again: Codex
// or Grok may be installed after Hindcast is open.
const WATCH_DIRS = [PROJECTS_DIR, CODEX_SESSIONS, CODEX_ARCHIVED, GROK_SESSIONS];
let watchTimer = null;
let watchRetry = null;
const watched = new Set();

function armWatch(dir) {
  if (watched.has(dir)) return true;
  try {
    fs.watch(dir, { recursive: true }, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => refreshIndex(), 5000);
    });
    watched.add(dir);
    return true;
  } catch {
    return false;
  }
}

function watchProjects() {
  for (const dir of WATCH_DIRS) armWatch(dir);
  if (WATCH_DIRS.every((d) => watched.has(d))) {
    if (watchRetry) { clearInterval(watchRetry); watchRetry = null; }
    return;
  }
  if (watchRetry) return;
  watchRetry = setInterval(() => {
    let appeared = false;
    for (const dir of WATCH_DIRS) {
      if (!watched.has(dir) && armWatch(dir)) appeared = true;
    }
    if (WATCH_DIRS.every((d) => watched.has(d))) {
      clearInterval(watchRetry);
      watchRetry = null;
    }
    if (appeared) refreshIndex();
  }, 60000);
}

app.whenReady().then(() => {
  // Dev dock icon (packaged builds use the bundled .icns instead)
  if (process.platform === 'darwin' && app.dock) {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon-512.png'));
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch {}
  }
  createWindow();
  refreshIndex();
  watchProjects();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

// ---------- IPC ----------

ipcMain.handle('index:get', () => {
  // A snapshot taken mid-rescan shows "indexing"; the renderer clears that
  // only on index:ready, so remember to ping even if the rescan ends quiet.
  if (indexing) servedWhileIndexing = true;
  return {
    projects: index.projects,
    sessions: index.sessions.map((s) => ({ ...s })),
    skillInventory: index.skillInventory || [],
    skippedZstd: index.skippedZstd || 0,
    indexing,
  };
});

ipcMain.handle('index:refresh', async () => { await refreshIndex(); return true; });

async function parseFor(s, opts) {
  const agent = s.agent || 'claude';
  if (agent === 'codex') {
    const parsed = await parseCodexSession(s.filePath);
    if (s.subagents && s.subagents.length) parsed.subagents = s.subagents;
    return parsed;
  }
  if (agent === 'grok') return parseGrokSession(s.filePath);
  return parseSession(s.filePath, opts);
}

ipcMain.handle('session:read', async (_e, id) => {
  const s = sessionsById.get(id);
  if (!s) return null;
  try {
    const parsed = await parseFor(s);
    return { meta: s, ...parsed };
  } catch (err) {
    return { meta: s, events: [], sidechainCount: 0, abandonedCount: 0, error: String(err && err.message || err) };
  }
});

ipcMain.handle('search:query', async (_e, q) => {
  try { return await search(q, sessionsById); } catch { return []; }
});

ipcMain.handle('shell:revealSession', (_e, id) => {
  const s = sessionsById.get(id);
  if (s) shell.showItemInFolder(s.filePath);
});

ipcMain.handle('session:readSub', async (_e, { id, agentId }) => {
  const s = sessionsById.get(id);
  if (!s) return null;
  if ((s.agent || 'claude') === 'codex') {
    const want = String(agentId || '').toLowerCase();
    if (!SESSION_ID_RE.test(want)) return null;
    const sub = (s.subagents || []).find((x) => x.id === want);
    if (!sub || !sub.filePath) return null;
    try {
      const parsed = await parseCodexSession(sub.filePath);
      return { title: sub.title, ...parsed };
    } catch (err) {
      return { title: sub.title, events: [], sidechainCount: 0, abandonedCount: 0, subagents: [], error: String(err && err.message || err) };
    }
  }
  if (!/^[a-z0-9]+$/.test(String(agentId))) return null;
  const subs = await listSubagents(s.filePath);
  const sub = subs.find((x) => x.id === agentId);
  if (!sub) return null;
  try {
    const parsed = await parseSession(sub.filePath, { includeSidechain: true, skipSubagents: true });
    return { title: sub.title, ...parsed };
  } catch (err) {
    return { title: sub.title, events: [], sidechainCount: 0, abandonedCount: 0, subagents: [], error: String(err && err.message || err) };
  }
});

ipcMain.handle('session:export', async (_e, { id, format }) => {
  const s = sessionsById.get(id);
  if (!s || !['md', 'html'].includes(format)) return null;
  try {
    const parsed = await parseFor(s, { skipSubagents: true });
    const { filename, content } = exportSession({ ...s }, parsed.events, format);
    const dir = path.join(app.getPath('downloads'), 'Hindcast Exports');
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, filename);
    fs.writeFileSync(outPath, content);
    shell.showItemInFolder(outPath);
    return outPath;
  } catch (err) {
    return null;
  }
});

ipcMain.handle('settings:get', () => readSettings());

ipcMain.handle('settings:save', (_e, s) => {
  if (!s || typeof s !== 'object') return readSettings();
  // Re-read from disk before mutating, so a hand edit to settings.json made
  // while the app is running is not clobbered by this write.
  settingsCache = null;
  readSettings();
  for (const key of Object.keys(TEMPLATE_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(s, key)) continue;
    const t = typeof s[key] === 'string' ? s[key].trim() : '';
    // The editor input caps at TEMPLATE_MAX, so over-length only arrives from
    // outside the UI; refuse it rather than truncating mid-placeholder.
    if (t.length > TEMPLATE_MAX) return { ...readSettings(), saveFailed: true };
  }
  for (const [key, fallback] of Object.entries(TEMPLATE_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(s, key)) continue;
    const t = typeof s[key] === 'string' ? s[key].trim() : '';
    // A cleared or default-valued template is stored as absent, so future
    // default changes reach users who never customized it.
    if (t && t !== fallback) settingsCache[key] = t;
    else delete settingsCache[key];
  }
  // Report what actually persisted: on a write failure the caller must not be
  // told the new value is saved, or the UI shows it until the next launch.
  try {
    fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(settingsCache));
  } catch {
    settingsCache = null; // drop the unsaved mutation; next read reloads from disk
    return { ...readSettings(), saveFailed: true };
  }
  return readSettings();
});

ipcMain.handle('theme:save', (_e, t) => {
  if (!t || !['auto', 'light', 'dark'].includes(t.pref)) return;
  nativeTheme.themeSource = t.pref === 'auto' ? 'system' : t.pref;
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(t.resolved === 'light' ? '#f3efe5' : '#141210');
  }
  try { fs.writeFileSync(THEME_PATH(), JSON.stringify(t)); } catch {}
});
