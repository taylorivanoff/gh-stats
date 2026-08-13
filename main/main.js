const { app, ipcMain } = require('electron');
const path = require('path');
const loadElectronTrayBase = require('./load-electron-tray-base.cjs');
const { configureAppIsolation, run } = loadElectronTrayBase();

configureAppIsolation({
  appId: 'io.github.taylorivanoff.gh-stats',
  appName: 'GhStats'
});

const store = require('./store');
const collector = require('./collector');
const { buildDashboard } = require('./analytics');
const logger = require('./logger');

const APP_NAME = 'GhStats';

let fetchInProgress = false;
let rendererReady = false;
let pendingAutoFetch = false;
let traySendToRenderer = () => {};
let runFetchForTray = () => {};

function userDataPath() {
  return app.getPath('userData');
}

function broadcast(sendToRenderer, channel, payload) {
  sendToRenderer(channel, payload);
}

async function getDashboardPayload(rangeDays = 30) {
  const snapshots = store.loadAllSnapshots(userDataPath());
  const latest = snapshots[snapshots.length - 1];
  const repos = latest?.repos || [];
  const starHistories = collector.loadAllStarHistories(userDataPath(), repos.map((r) => r.name));

  return buildDashboard({
    snapshots,
    starHistories,
    currentTotals: latest
      ? { stars: latest.totals.stars, downloads: latest.totals.downloads, repos: latest.repos }
      : null,
    rangeDays
  });
}

async function runFetch(sendToRenderer, options = {}) {
  if (fetchInProgress) return { ok: false, error: 'Fetch already in progress' };
  fetchInProgress = true;
  const fetchStarted = Date.now();
  const kind = options.includeStarHistory ? 'history' : 'fetch';
  logger.info('runFetch start', { includeStarHistory: !!options.includeStarHistory });
  broadcast(sendToRenderer, 'fetch:progress', { phase: 'auth', message: 'Checking gh authentication…', startedAt: fetchStarted });

  try {
    const authStarted = Date.now();
    const auth = await collector.checkAuth();
    store.recordTiming('auth', auth.ms ?? Date.now() - authStarted);
    broadcast(sendToRenderer, 'fetch:progress', {
      phase: 'auth-done',
      message: auth.ok ? `Authenticated as ${auth.user}` : auth.error,
      ms: auth.ms
    });

    if (!auth.ok) {
      broadcast(sendToRenderer, 'fetch:progress', { phase: 'error', message: auth.error });
      return { ok: false, error: 'gh not authenticated. Run: gh auth login', ms: Date.now() - fetchStarted };
    }

    const repoListQuery = store.DEFAULT_REPO_LIST_QUERY;
    broadcast(sendToRenderer, 'fetch:progress', {
      phase: 'repos',
      message: `Listing repos for ${auth.user}…`,
      startedAt: fetchStarted
    });

    const totals = await collector.fetchCurrentTotals((p) => {
      broadcast(sendToRenderer, 'fetch:progress', {
        phase: p.phase,
        message: `Release downloads: ${p.repo} (${p.current}/${p.total})`,
        current: p.current,
        total: p.total,
        startedAt: fetchStarted
      });
    }, { repoListQuery });

    const snapshot = store.saveSnapshot(userDataPath(), {
      timestamp: Date.now(),
      date: collector.dateKey(),
      repos: totals.repos,
      totals: totals.totals
    });

    if (options.includeStarHistory) {
      broadcast(sendToRenderer, 'fetch:progress', {
        phase: 'stars',
        message: 'Fetching star history (rate-limit aware, may take a while)…',
        startedAt: fetchStarted
      });

      for (let i = 0; i < totals.repos.length; i++) {
        const repo = totals.repos[i].name;
        const hist = await collector.fetchStarHistory(repo, (p) => {
          broadcast(sendToRenderer, 'fetch:progress', {
            phase: 'stars',
            message: `Star history: ${repo} (page ${p.page}, ${p.fetched} stars)`,
            repo,
            current: i + 1,
            total: totals.repos.length,
            startedAt: fetchStarted
          });
        });
        collector.saveStarHistory(userDataPath(), hist);
        if (i < totals.repos.length - 1) {
          await new Promise((r) => setTimeout(r, collector.RELEASE_DELAY_MS));
        }
      }
      store.setSettings({ starHistoryLoaded: true });
    }

    const ms = Date.now() - fetchStarted;
    store.recordTiming(kind, ms, { repos: totals.repos.length });
    const timing = store.getTimingStats();

    broadcast(sendToRenderer, 'fetch:done', { snapshot, ms, kind, timing });
    broadcast(sendToRenderer, 'dashboard:updated', await getDashboardPayload());
    logger.info('runFetch done', { stars: snapshot.totals.stars, downloads: snapshot.totals.downloads, ms, kind });
    return { ok: true, snapshot, ms, timing };
  } catch (err) {
    const message = err.message || String(err);
    logger.error('runFetch failed', { message });
    broadcast(sendToRenderer, 'fetch:progress', { phase: 'error', message });
    return { ok: false, error: message, ms: Date.now() - fetchStarted };
  } finally {
    fetchInProgress = false;
  }
}

function maybeAutoFetch(sendToRenderer) {
  if (!rendererReady || !pendingAutoFetch || fetchInProgress) return;
  pendingAutoFetch = false;
  logger.info('Auto-fetch starting');
  runFetch(sendToRenderer, { includeStarHistory: false }).catch((err) => {
    logger.error('Auto-fetch failed', { message: err.message });
  });
}

run({
  appName: APP_NAME,
  appId: 'io.github.taylorivanoff.gh-stats',
  iconPath: path.join(__dirname, '..', 'resources', 'icon.png'),
  splashPath: path.join(__dirname, '..', 'resources', 'splash.html'),
  store: { instance: store.settingsStore },
  window: {
    html: path.join(__dirname, '..', 'renderer', 'index.html'),
    preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    minWidth: 980,
    minHeight: 720,
    defaultBounds: { width: 1120, height: 860 }
  },
  dev: { entryModule: module },
  updater: { enabled: app.isPackaged },
  tray: {
    extraSections: () => [[
      { label: 'Refresh data', click: () => runFetchForTray() }
    ]]
  },
  hooks: {
    getSettings: () => store.getSettings(),
    setSettings: (partial) => store.setSettings(partial),
    onReady: ({ sendToRenderer }) => {
      traySendToRenderer = sendToRenderer;
      runFetchForTray = () => runFetch(traySendToRenderer, { includeStarHistory: false });
      logger.setLogFile(path.join(app.getPath('userData'), 'logs', 'gh-stats.log'));
      logger.info('GhStats starting', { version: app.getVersion(), packaged: app.isPackaged });
      logger.onLog((entry) => sendToRenderer('log:entry', entry));
    },
    onWindowCreated: (win) => {
      win.webContents.on('console-message', (_e, details) => {
        logger.debug('renderer console', { level: details.level, message: details.message });
      });
      win.webContents.on('did-fail-load', (_e, code, desc) => {
        logger.error('Renderer failed to load', { code, desc });
      });
    },
    onDidFinishLoad: (_win, { sendToRenderer }) => {
      logger.info('Renderer loaded');
      pendingAutoFetch = store.needsAutoFetch(userDataPath());
      maybeAutoFetch(sendToRenderer);
    },
    registerIpc: ({ sendToRenderer }) => {
      ipcMain.handle('renderer:ready', () => {
        rendererReady = true;
        logger.info('Renderer ready');
        maybeAutoFetch(sendToRenderer);
        return { ok: true };
      });
      ipcMain.handle('auth:check', async () => {
        logger.info('IPC auth:check');
        const started = Date.now();
        const result = await collector.checkAuth();
        store.recordTiming('auth', result.ms ?? Date.now() - started);
        return { ...result, timing: store.getTimingStats() };
      });
      ipcMain.handle('dashboard:get', async (_e, rangeDays) => {
        logger.debug('IPC dashboard:get', { rangeDays });
        return getDashboardPayload(rangeDays);
      });
      ipcMain.handle('fetch:run', (_e, options) => runFetch(sendToRenderer, options || {}));
      ipcMain.handle('fetch:status', () => ({ inProgress: fetchInProgress }));
      ipcMain.handle('timings:get', () => store.getTimingStats());
      ipcMain.handle('logs:get', (_e, limit) => logger.getLogs(limit || 80));
      ipcMain.handle('logs:path', () => logger.logFilePath || null);
    }
  }
});
