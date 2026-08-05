const { contextBridge, ipcRenderer } = require('electron');

const IPC_TIMEOUT_MS = 30_000;

function invoke(channel, ...args) {
  return Promise.race([
    ipcRenderer.invoke(channel, ...args),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`IPC timeout (${channel})`)), IPC_TIMEOUT_MS);
    })
  ]);
}

contextBridge.exposeInMainWorld('ghStats', {
  ready: () => invoke('renderer:ready'),
  checkAuth: () => invoke('auth:check'),
  getDashboard: (rangeDays) => invoke('dashboard:get', rangeDays),
  getSettings: () => invoke('settings:get'),
  setSettings: (partial) => invoke('settings:set', partial),
  runFetch: (options) => invoke('fetch:run', options),
  getFetchStatus: () => invoke('fetch:status'),
  getTimings: () => invoke('timings:get'),
  onFetchProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('fetch:progress', listener);
    return () => ipcRenderer.removeListener('fetch:progress', listener);
  },
  onFetchDone: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('fetch:done', listener);
    return () => ipcRenderer.removeListener('fetch:done', listener);
  },
  onDashboardUpdated: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('dashboard:updated', listener);
    return () => ipcRenderer.removeListener('dashboard:updated', listener);
  },
  getLogs: (limit) => invoke('logs:get', limit),
  getLogPath: () => invoke('logs:path'),
  onLogEntry: (cb) => {
    const listener = (_e, entry) => cb(entry);
    ipcRenderer.on('log:entry', listener);
    return () => ipcRenderer.removeListener('log:entry', listener);
  }
});
