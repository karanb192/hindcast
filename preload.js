const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hindcast', {
  getIndex: () => ipcRenderer.invoke('index:get'),
  refreshIndex: () => ipcRenderer.invoke('index:refresh'),
  readSession: (id) => ipcRenderer.invoke('session:read', id),
  readSubagent: (id, agentId) => ipcRenderer.invoke('session:readSub', { id, agentId }),
  exportSession: (id, format) => ipcRenderer.invoke('session:export', { id, format }),
  search: (q) => ipcRenderer.invoke('search:query', q),
  revealSession: (id) => ipcRenderer.invoke('shell:revealSession', id),
  saveTheme: (t) => ipcRenderer.invoke('theme:save', t),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  onIndexProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('index:progress', h);
    return () => ipcRenderer.removeListener('index:progress', h);
  },
  onIndexReady: (cb) => {
    const h = () => cb();
    ipcRenderer.on('index:ready', h);
    return () => ipcRenderer.removeListener('index:ready', h);
  },
});
