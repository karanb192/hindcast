const { app, BrowserWindow, ipcMain, shell, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { PROJECTS_DIR, buildIndex, parseSession, listSubagents } = require('./lib/scanner');
const { CODEX_SESSION_DIRS, CODEX_INDEX_FILE, parseCodexSession } = require('./lib/codex');
const { search } = require('./lib/search');
const { exportSession } = require('./lib/export');

let win = null;
let index = { projects: [], sessions: [], skillInventory: [], codexChildren: new Map(), codexOwners: new Map() };
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
    // Codex thread names live in session_index.jsonl, not the rollout, so a
    // rename moves the title without touching any signed file: sign titles.
    // Codex subagent rollouts fold into their root session's usage without
    // touching the root's file, so they get their own term too: a deleted
    // or archived child must still ping.
    const sig = index.sessions
      .map((s) => s.filePath + ':' + s.mtime + ':' + s.size + ':' + s.title)
      .sort()
      .join('|')
      + '#' + (index.skillInventory || []).map((i) => i.source + ':' + i.name).join('|')
      + '#' + [...(index.codexChildren || new Map()).values()].flat()
        .map((c) => c.filePath + ':' + c.mtime + ':' + c.size).sort().join('|');
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
const { RESUME_TEMPLATE_DEFAULT, CODEX_RESUME_TEMPLATE_DEFAULT, TEMPLATE_MAX } = require('./lib/resume');
// settings key -> its default; each agent has its own resume command
const TEMPLATE_DEFAULTS = {
  resumeTemplate: RESUME_TEMPLATE_DEFAULT,
  codexResumeTemplate: CODEX_RESUME_TEMPLATE_DEFAULT,
};
let settingsCache = null;

function readSettings() {
  if (!settingsCache) {
    try { settingsCache = JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8')); }
    catch { settingsCache = {}; }
    // a hand-edited file can hold valid JSON that is not an object
    if (!settingsCache || typeof settingsCache !== 'object' || Array.isArray(settingsCache)) settingsCache = {};
  }
  const tpl = (key) => (typeof settingsCache[key] === 'string' && settingsCache[key].trim()
    ? settingsCache[key] : TEMPLATE_DEFAULTS[key]);
  return {
    resumeTemplate: tpl('resumeTemplate'),
    resumeTemplateDefault: RESUME_TEMPLATE_DEFAULT,
    codexResumeTemplate: tpl('codexResumeTemplate'),
    codexResumeTemplateDefault: CODEX_RESUME_TEMPLATE_DEFAULT,
    templateMax: TEMPLATE_MAX,
  };
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

// Live index: re-scan (cheap, mtime-cached) when Claude Code or Codex writes
// new transcript lines, so sessions appear while you work. Debounced hard
// because active sessions append constantly. Only the transcript dirs are
// watched: the rest of ~/.codex holds databases that are written nonstop.
let watchTimer = null;
const watched = new Set();
function onTranscriptChange() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => refreshIndex(), 5000);
}
// A target that does not exist yet (Codex never run, no thread renamed yet)
// gets its watcher on a later pass, and its arrival triggers a rescan.
function watchProjects() {
  let added = false;
  for (const target of [PROJECTS_DIR, ...CODEX_SESSION_DIRS, CODEX_INDEX_FILE]) {
    if (watched.has(target)) continue;
    try {
      fs.watch(target, { recursive: target !== CODEX_INDEX_FILE }, onTranscriptChange);
      watched.add(target);
      added = true;
    } catch {}
  }
  return added;
}

const isCodex = (s) => s.agent === 'codex';

// Codex subagent threads were found at index time; Claude's are listed
// from the session's own directory on demand.
async function subagentsOf(s) {
  return isCodex(s) ? (index.codexChildren.get(s.id) || []) : listSubagents(s.filePath);
}

async function parseAny(s, opts = {}) {
  if (!isCodex(s)) return parseSession(s.filePath, opts);
  const parsed = await parseCodexSession(s.filePath);
  if (!opts.skipSubagents) parsed.subagents = await subagentsOf(s);
  return parsed;
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
  setInterval(() => { if (watchProjects()) onTranscriptChange(); }, 60000);
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
    indexing,
  };
});

ipcMain.handle('index:refresh', async () => { await refreshIndex(); return true; });

ipcMain.handle('session:read', async (_e, id) => {
  const s = sessionsById.get(id);
  if (!s) return null;
  try {
    const parsed = await parseAny(s);
    return { meta: s, ...parsed };
  } catch (err) {
    return { meta: s, events: [], sidechainCount: 0, abandonedCount: 0, error: String(err && err.message || err) };
  }
});

ipcMain.handle('search:query', async (_e, q) => {
  try { return await search(q, sessionsById, index.codexOwners); } catch { return []; }
});

ipcMain.handle('shell:revealSession', (_e, id) => {
  const s = sessionsById.get(id);
  if (s) shell.showItemInFolder(s.filePath);
});

ipcMain.handle('session:readSub', async (_e, { id, agentId }) => {
  const s = sessionsById.get(id);
  // Claude agent ids are short hex; Codex subagents are thread uuids
  const idOk = isCodex(s || {}) ? /^[0-9a-f-]{36}$/ : /^[a-z0-9]+$/;
  if (!s || !idOk.test(String(agentId))) return null;
  const subs = await subagentsOf(s);
  const sub = subs.find((x) => x.id === agentId);
  if (!sub) return null;
  try {
    const parsed = isCodex(s)
      ? await parseCodexSession(sub.filePath)
      : await parseSession(sub.filePath, { includeSidechain: true, skipSubagents: true });
    return { title: sub.title, ...parsed };
  } catch (err) {
    return { title: sub.title, events: [], sidechainCount: 0, abandonedCount: 0, subagents: [], error: String(err && err.message || err) };
  }
});

ipcMain.handle('session:export', async (_e, { id, format }) => {
  const s = sessionsById.get(id);
  if (!s || !['md', 'html'].includes(format)) return null;
  try {
    const parsed = await parseAny(s, { skipSubagents: true });
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
  for (const [key, def] of Object.entries(TEMPLATE_DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(s, key)) continue;
    const t = typeof s[key] === 'string' ? s[key].trim() : '';
    // The editor input caps at TEMPLATE_MAX, so over-length only arrives from
    // outside the UI; refuse it rather than truncating mid-placeholder.
    if (t.length > TEMPLATE_MAX) { settingsCache = null; return { ...readSettings(), saveFailed: true }; }
    // A cleared or default-valued template is stored as absent, so future
    // default changes reach users who never customized it.
    if (t && t !== def) settingsCache[key] = t;
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
