/**
 * Facade matching the Electron preload API (window.ghStats).
 * Requires vendor/tauri-tray-bridge.js and withGlobalTauri.
 */
(function () {
  const bridge = window.tauriTrayBridge;
  if (!bridge) {
    console.error("tauriTrayBridge missing — load vendor/tauri-tray-bridge.js first");
    return;
  }

  const IPC_TIMEOUT_MS = 30_000;
  const INSTALL_TIMEOUT_MS = 180_000;

  function invoke(cmd, args, timeoutMs) {
    const timeout = timeoutMs ?? IPC_TIMEOUT_MS;
    return Promise.race([
      bridge.invoke(cmd, args || {}),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`IPC timeout (${cmd})`)), timeout);
      }),
    ]);
  }

  function onEvent(event, cb) {
    let unlisten = null;
    bridge.listen(event, cb).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }

  window.ghStats = {
    ready: () => invoke("renderer_ready"),
    checkAuth: () => invoke("auth_check"),
    getGhStatus: () => invoke("gh_status"),
    installGh: () => invoke("gh_install", {}, INSTALL_TIMEOUT_MS),
    authLogin: () => invoke("auth_login"),
    getDashboard: (rangeDays) => invoke("dashboard_get", { rangeDays }),
    getSettings: () => bridge.getSettings(),
    setSettings: (partial) => bridge.setSettings(partial),
    runFetch: (options) => invoke("fetch_run", { options: options || {} }),
    getFetchStatus: () => invoke("fetch_status"),
    getTimings: () => invoke("timings_get"),
    onFetchProgress: (cb) => onEvent("fetch:progress", cb),
    onFetchDone: (cb) => onEvent("fetch:done", cb),
    onDashboardUpdated: (cb) => onEvent("dashboard:updated", cb),
    getLogs: (limit) => invoke("logs_get", { limit: limit || 80 }),
    getLogPath: () => invoke("logs_path"),
    onLogEntry: (cb) => onEvent("log:entry", cb),
    seedDemo: () => invoke("seed_demo"),
    completeOnboarding: () => invoke("complete_onboarding"),
    dismissDemo: () => invoke("dismiss_demo"),
  };
})();
