const { app, BrowserWindow, ipcMain, shell, nativeTheme, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { PROJECTS_DIR, buildIndex, parseSession, listSubagents } = require('./lib/scanner');
const { search } = require('./lib/search');
const { exportSession } = require('./lib/export');

let win = null;
let index = { projects: [], sessions: [] };
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

async function refreshIndex() {
  if (indexing) return;
  indexing = true;
  const cache = loadCache();
  try {
    // Watch-triggered rescans are mtime-cached and near-instant; progress
    // flicker is only worth showing while the first full index streams.
    const showProgress = !firstIndexDone;
    index = await buildIndex(cache, (p) => {
      if (showProgress && win && !win.isDestroyed()) win.webContents.send('index:progress', p);
    });
    sessionsById = new Map(index.sessions.map((s) => [s.id, s]));
    saveCache(cache);
    // Active Claude Code sessions fire the watcher constantly; when a rescan
    // produces an identical index, skip the ready ping so the renderer
    // doesn't reload and re-render the whole app for nothing.
    const sig = JSON.stringify(index);
    const changed = sig !== lastIndexSig;
    lastIndexSig = sig;
    if ((changed || !firstIndexDone) && win && !win.isDestroyed()) {
      win.webContents.send('index:ready');
    }
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

// Live index: re-scan (cheap, mtime-cached) when Claude Code writes new
// transcript lines, so sessions appear while you work. Debounced hard because
// active sessions append constantly.
let watchTimer = null;
function watchProjects() {
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => refreshIndex(), 5000);
    });
  } catch {}
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

ipcMain.handle('index:get', () => ({
  projects: index.projects,
  sessions: index.sessions.map((s) => ({ ...s })),
  indexing,
}));

ipcMain.handle('index:refresh', async () => { await refreshIndex(); return true; });

ipcMain.handle('session:read', async (_e, id) => {
  const s = sessionsById.get(id);
  if (!s) return null;
  try {
    const parsed = await parseSession(s.filePath);
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
  if (!s || !/^[a-z0-9]+$/.test(String(agentId))) return null;
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
    const parsed = await parseSession(s.filePath, { skipSubagents: true });
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

ipcMain.handle('theme:save', (_e, t) => {
  if (!t || !['auto', 'light', 'dark'].includes(t.pref)) return;
  nativeTheme.themeSource = t.pref === 'auto' ? 'system' : t.pref;
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(t.resolved === 'light' ? '#f3efe5' : '#141210');
  }
  try { fs.writeFileSync(THEME_PATH(), JSON.stringify(t)); } catch {}
});
