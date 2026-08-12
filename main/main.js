const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  nativeTheme,
  Notification
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const store = require('./store');
const collector = require('./collector');
const { buildDashboard } = require('./analytics');
const { createTray, updateTrayMenu, destroyTray, getIconPath } = require('./tray');
const logger = require('./logger');

const APP_NAME = 'GhStats';
const START_MINIMIZED_ARG = '--start-minimised';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function hasStartMinimisedArg(argv = process.argv) {
  return argv.some(
    (arg) => arg === START_MINIMIZED_ARG || arg.startsWith(`${START_MINIMIZED_ARG}=`)
  );
}

function wasLaunchedMinimised(argv = process.argv) {
  return hasStartMinimisedArg(argv);
}
const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;
const DEFAULT_BOUNDS = { width: 960, height: 680 };

let mainWindow = null;
let splashWindow = null;
let isQuitting = false;
let fetchInProgress = false;
let rendererReady = false;
let pendingAutoFetch = false;
let manualUpdateCheck = false;
let trayHandlers = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (hasStartMinimisedArg(argv)) return;
    showWindow();
  });

  if (!app.isPackaged) {
    try {
      require('electron-reloader')(module, {
        watchRenderer: true,
        ignore: ['**/node_modules/**', '**/.git/**']
      });
    } catch (_) {}
  }
}

function userDataPath() {
  return app.getPath('userData');
}

function normalizeBounds(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BOUNDS };
  return {
    x: Number.isFinite(raw.x) ? Math.round(raw.x) : undefined,
    y: Number.isFinite(raw.y) ? Math.round(raw.y) : undefined,
    width: Math.max(MIN_WIDTH, Math.round(raw.width || DEFAULT_BOUNDS.width)),
    height: Math.max(MIN_HEIGHT, Math.round(raw.height || DEFAULT_BOUNDS.height))
  };
}

function getWindowBounds() {
  const saved = normalizeBounds(store.getWindowBounds());
  if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) {
    return { width: saved.width, height: saved.height };
  }
  return saved;
}

let saveBoundsTimer = null;
function saveWindowBounds() {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveBoundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    store.setWindowBounds(normalizeBounds(mainWindow.getBounds()));
  }, 150);
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 280,
    height: 320,
    frame: false,
    show: false,
    backgroundColor: '#1c1c1e',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: { nodeIntegration: false }
  });
  splashWindow.setMenu(null);
  const show = () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.center();
      splashWindow.show();
    }
  };
  splashWindow.webContents.once('did-finish-load', show);
  splashWindow.loadFile(path.join(__dirname, '..', 'resources', 'splash.html')).catch(show);
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy();
    splashWindow = null;
  }
}

function platformWindowOptions() {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 10 },
      vibrancy: 'under-window',
      visualEffectState: 'active',
      backgroundColor: '#00000000'
    };
  }
  return {
    frame: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f3f3f3',
    autoHideMenuBar: true
  };
}

function createWindow() {
  if (mainWindow) return mainWindow;

  const bounds = getWindowBounds();
  const settings = store.getSettings();

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    icon: getIconPath(),
    ...platformWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setMenu(null);
  mainWindow.webContents.on('console-message', (_e, details) => {
    logger.debug('renderer console', { level: details.level, message: details.message });
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    logger.error('Renderer failed to load', { code, desc });
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    logger.info('Renderer loaded');
    closeSplash();
    if (wasLaunchedMinimised()) mainWindow.hide();
    else mainWindow.show();
    pendingAutoFetch = store.needsAutoFetch(userDataPath());
    maybeAutoFetch();
  });

  mainWindow.on('resize', saveWindowBounds);
  mainWindow.on('move', saveWindowBounds);
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  return mainWindow;
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
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

async function runFetch(options = {}) {
  if (fetchInProgress) return { ok: false, error: 'Fetch already in progress' };
  fetchInProgress = true;
  const fetchStarted = Date.now();
  const kind = options.includeStarHistory ? 'history' : 'fetch';
  logger.info('runFetch start', { includeStarHistory: !!options.includeStarHistory });
  broadcast('fetch:progress', { phase: 'auth', message: 'Checking gh authentication…', startedAt: fetchStarted });

  try {
    const authStarted = Date.now();
    const auth = await collector.checkAuth();
    store.recordTiming('auth', auth.ms ?? Date.now() - authStarted);
    broadcast('fetch:progress', {
      phase: 'auth-done',
      message: auth.ok ? `Authenticated as ${auth.user}` : auth.error,
      ms: auth.ms
    });

    if (!auth.ok) {
      broadcast('fetch:progress', { phase: 'error', message: auth.error });
      return { ok: false, error: 'gh not authenticated. Run: gh auth login', ms: Date.now() - fetchStarted };
    }

    broadcast('fetch:progress', {
      phase: 'repos',
      message: `Fetching totals for ${auth.user}…`,
      startedAt: fetchStarted
    });

    const totals = await collector.fetchCurrentTotals((p) => {
      broadcast('fetch:progress', {
        phase: p.phase,
        message: `Release downloads: ${p.repo} (${p.current}/${p.total})`,
        current: p.current,
        total: p.total,
        startedAt: fetchStarted
      });
    });

    const snapshot = store.saveSnapshot(userDataPath(), {
      timestamp: Date.now(),
      date: collector.dateKey(),
      repos: totals.repos,
      totals: totals.totals
    });

    if (options.includeStarHistory) {
      broadcast('fetch:progress', {
        phase: 'stars',
        message: 'Fetching star history (rate-limit aware, may take a while)…',
        startedAt: fetchStarted
      });

      for (let i = 0; i < totals.repos.length; i++) {
        const repo = totals.repos[i].name;
        const hist = await collector.fetchStarHistory(repo, (p) => {
          broadcast('fetch:progress', {
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

    broadcast('fetch:done', { snapshot, ms, kind, timing });
    broadcast('dashboard:updated', await getDashboardPayload());
    logger.info('runFetch done', { stars: snapshot.totals.stars, downloads: snapshot.totals.downloads, ms, kind });
    return { ok: true, snapshot, ms, timing };
  } catch (err) {
    const message = err.message || String(err);
    logger.error('runFetch failed', { message });
    broadcast('fetch:progress', { phase: 'error', message });
    return { ok: false, error: message, ms: Date.now() - fetchStarted };
  } finally {
    fetchInProgress = false;
  }
}

function setupTray() {
  trayHandlers = {
    showWindow,
    refresh: () => runFetch({ includeStarHistory: false }),
    getSettings: store.getSettings,
    setAlwaysOnTop: (checked) => {
      store.setSettings({ alwaysOnTop: checked });
      if (mainWindow) mainWindow.setAlwaysOnTop(checked);
      updateTrayMenu(trayHandlers);
    },
    checkForUpdates: () => checkForUpdates(true),
    quit: () => {
      isQuitting = true;
      app.quit();
    }
  };

  try {
    createTray(getIconPath(), trayHandlers);
    logger.info('Tray created');
  } catch (err) {
    logger.warn('Tray unavailable', { message: err.message });
  }
}

async function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) logger.info('Update check skipped (unpackaged)');
    return;
  }
  manualUpdateCheck = manual;
  try {
    logger.info('Checking for updates', { manual });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    logger.warn('Update check failed', { message: err.message });
    manualUpdateCheck = false;
  }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    logger.info('Update available', { version: info.version });
    if (!Notification.isSupported()) return;
    new Notification({
      title: APP_NAME,
      body: `Update ${info.version} found. The app will update and restart.`,
      icon: getIconPath()
    }).show();
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('No updates available');
    manualUpdateCheck = false;
  });

  autoUpdater.on('update-downloaded', () => {
    logger.info('Update downloaded — installing');
    manualUpdateCheck = false;
    isQuitting = true;
    autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.on('error', (err) => {
    logger.warn('Updater error', { message: err?.message || String(err) });
    manualUpdateCheck = false;
  });

  checkForUpdates(false);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
}

function maybeAutoFetch() {
  if (!rendererReady || !pendingAutoFetch || fetchInProgress) return;
  pendingAutoFetch = false;
  logger.info('Auto-fetch starting');
  runFetch({ includeStarHistory: false }).catch((err) => {
    logger.error('Auto-fetch failed', { message: err.message });
  });
}

function registerIpc() {
  ipcMain.handle('renderer:ready', () => {
    rendererReady = true;
    logger.info('Renderer ready');
    maybeAutoFetch();
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
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, partial) => {
    const s = store.setSettings(partial);
    if (partial.alwaysOnTop !== undefined && mainWindow) {
      mainWindow.setAlwaysOnTop(s.alwaysOnTop);
    }
    if (partial.startMinimised === false && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
    return s;
  });
  ipcMain.handle('fetch:run', (_e, options) => runFetch(options || {}));
  ipcMain.handle('fetch:status', () => ({ inProgress: fetchInProgress }));
  ipcMain.handle('timings:get', () => store.getTimingStats());
  ipcMain.handle('logs:get', (_e, limit) => logger.getLogs(limit || 80));
  ipcMain.handle('logs:path', () => logger.logFilePath || null);
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('io.github.taylorivanoff.gh-stats');
  logger.setLogFile(path.join(app.getPath('userData'), 'logs', 'gh-stats.log'));
  logger.info('GhStats starting', { version: app.getVersion(), packaged: app.isPackaged });
  logger.onLog((entry) => broadcast('log:entry', entry));
  if (!wasLaunchedMinimised()) createSplash();
  registerIpc();
  setupTray();
  createWindow();
  if (app.isPackaged) setupAutoUpdater();
});

app.on('before-quit', () => {
  isQuitting = true;
  destroyTray();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
