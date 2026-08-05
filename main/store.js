const fs = require('fs');
const path = require('path');
const Store = require('electron-store');

const settingsStore = new Store({
  name: 'gh-stats-settings',
  defaults: {
    alwaysOnTop: false,
    startMinimised: false,
    windowBounds: null,
    lastFetchAt: null,
    autoFetchHours: 24,
    starHistoryLoaded: false,
    showDebugBar: false,
    timings: []
  }
});

const MAX_TIMINGS = 50;

function recordTiming(kind, ms, meta = {}) {
  const msVal = Math.round(Number(ms));
  if (!Number.isFinite(msVal) || msVal < 0) return;
  const list = settingsStore.get('timings', []);
  list.push({ kind, ms: msVal, at: Date.now(), ...meta });
  while (list.length > MAX_TIMINGS) list.shift();
  settingsStore.set('timings', list);
  return list[list.length - 1];
}

function avgMs(items) {
  if (!items.length) return null;
  return Math.round(items.reduce((sum, t) => sum + t.ms, 0) / items.length);
}

function getTimingStats() {
  const list = settingsStore.get('timings', []);
  const auth = list.filter((t) => t.kind === 'auth');
  const fetch = list.filter((t) => t.kind === 'fetch');
  const history = list.filter((t) => t.kind === 'history');
  const last = (items) => items[items.length - 1] || null;
  return {
    authAvgMs: avgMs(auth),
    fetchAvgMs: avgMs(fetch),
    historyAvgMs: avgMs(history),
    authCount: auth.length,
    fetchCount: fetch.length,
    historyCount: history.length,
    lastAuth: last(auth),
    lastFetch: last(fetch),
    lastHistory: last(history)
  };
}

function snapshotsDir(userDataPath) {
  const dir = path.join(userDataPath, 'snapshots');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listSnapshotFiles(userDataPath) {
  const dir = snapshotsDir(userDataPath);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

function loadSnapshot(userDataPath, fileName) {
  const file = path.join(snapshotsDir(userDataPath), fileName);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadAllSnapshots(userDataPath) {
  return listSnapshotFiles(userDataPath)
    .map((f) => loadSnapshot(userDataPath, f))
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function saveSnapshot(userDataPath, data) {
  const snapshot = {
    timestamp: data.timestamp || Date.now(),
    date: data.date || new Date().toISOString().slice(0, 10),
    repos: data.repos || [],
    totals: data.totals || { stars: 0, downloads: 0 }
  };
  const file = path.join(snapshotsDir(userDataPath), `${snapshot.date}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
  settingsStore.set('lastFetchAt', snapshot.timestamp);
  return snapshot;
}

function getSettings() {
  return {
    alwaysOnTop: settingsStore.get('alwaysOnTop', false),
    startMinimised: settingsStore.get('startMinimised', false),
    lastFetchAt: settingsStore.get('lastFetchAt', null),
    autoFetchHours: settingsStore.get('autoFetchHours', 24),
    starHistoryLoaded: settingsStore.get('starHistoryLoaded', false),
    showDebugBar: settingsStore.get('showDebugBar', false)
  };
}

function setSettings(partial) {
  if (partial.alwaysOnTop !== undefined) settingsStore.set('alwaysOnTop', !!partial.alwaysOnTop);
  if (partial.startMinimised !== undefined) settingsStore.set('startMinimised', !!partial.startMinimised);
  if (partial.autoFetchHours !== undefined) {
    const h = Number(partial.autoFetchHours);
    if (Number.isFinite(h) && h >= 1) settingsStore.set('autoFetchHours', Math.min(168, h));
  }
  if (partial.starHistoryLoaded !== undefined) settingsStore.set('starHistoryLoaded', !!partial.starHistoryLoaded);
  if (partial.showDebugBar !== undefined) settingsStore.set('showDebugBar', !!partial.showDebugBar);
  return getSettings();
}

function getWindowBounds() {
  return settingsStore.get('windowBounds', null);
}

function setWindowBounds(bounds) {
  settingsStore.set('windowBounds', bounds);
}

function needsAutoFetch(userDataPath) {
  const settings = getSettings();
  const last = settings.lastFetchAt;
  if (!last) return true;
  const hours = settings.autoFetchHours || 24;
  return Date.now() - last > hours * 60 * 60 * 1000;
}

module.exports = {
  loadAllSnapshots,
  saveSnapshot,
  getSettings,
  setSettings,
  getWindowBounds,
  setWindowBounds,
  needsAutoFetch,
  recordTiming,
  getTimingStats,
  settingsStore
};
