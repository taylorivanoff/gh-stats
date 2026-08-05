(function boot() {
  const charts = window.GhCharts;
  if (!charts) {
    document.getElementById('auth-badge').textContent = 'JS load error';
    document.getElementById('auth-badge').className = 'auth-badge error';
    return;
  }

  const { drawLineChart, formatNumber } = charts;

  let currentRange = 30;
  let lastDashboard = null;
  let timingStats = null;
  const logLines = [];
  const MAX_LOG_LINES = 40;

  let timerInterval = null;
  let timerStartedAt = 0;
  let timerMode = null;
  let showDebugBar = false;

  const els = {
    authBadge: document.getElementById('auth-badge'),
    lastUpdated: document.getElementById('last-updated'),
    kpiGrid: document.getElementById('kpi-grid'),
    repoTbody: document.getElementById('repo-tbody'),
    repoCount: document.getElementById('repo-count'),
    progressBar: document.getElementById('progress-bar'),
    progressText: document.getElementById('progress-text'),
    progressElapsed: document.getElementById('progress-elapsed'),
    logPanel: document.getElementById('log-panel'),
    btnDebug: document.getElementById('btn-debug'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnStarHistory: document.getElementById('btn-star-history'),
    starsDailySub: document.getElementById('stars-daily-sub'),
    rangeTabs: document.getElementById('range-tabs'),
    charts: {
      starsDaily: document.getElementById('chart-stars-daily'),
      downloadsDaily: document.getElementById('chart-downloads-daily'),
      starsCumulative: document.getElementById('chart-stars-cumulative'),
      downloadsTotal: document.getElementById('chart-downloads-total')
    }
  };

  const platform = window.navigator.platform || '';
  if (platform.includes('Mac')) document.body.classList.add('platform-darwin');
  else if (platform.includes('Win')) document.body.classList.add('platform-win32');

  const EMPTY_DASHBOARD = {
    metrics: {
      totalStars: 0, totalDownloads: 0, starsToday: 0, stars7d: 0, stars30d: 0,
      downloadsToday: 0, downloads7d: 0, downloads30d: 0
    },
    series: {
      starsDaily: [], starsCumulative: [], downloadsDaily: [], downloadsTotal: []
    },
    repos: [],
    meta: { snapshotCount: 0, hasStarHistory: false, lastSnapshotAt: null }
  };

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return `${mins}m ${secs}s`;
  }

  function elapsedLabel(startedAt) {
    const base = startedAt || timerStartedAt;
    if (!base) return '0.0s';
    return formatDuration(Date.now() - base);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    timerMode = null;
  }

  function startAuthTimer() {
    stopTimer();
    timerStartedAt = Date.now();
    timerMode = 'auth';
    setAuthBadge('Checking gh 0.0s', 'pending');
    timerInterval = setInterval(() => {
      if (timerMode === 'auth') setAuthBadge(`Checking gh ${elapsedLabel()}`, 'pending');
    }, 100);
  }

  function startFetchTimer(message, startedAt) {
    stopTimer();
    timerStartedAt = startedAt || Date.now();
    timerMode = 'fetch';
    els.progressBar.classList.remove('hidden');
    els.progressText.textContent = message || 'Fetching…';
    updateFetchElapsed();
    timerInterval = setInterval(updateFetchElapsed, 100);
  }

  function updateFetchElapsed() {
    if (timerMode !== 'fetch') return;
    const elapsed = elapsedLabel();
    const msg = (els.progressText.textContent || '').toLowerCase();
    const isHistory = msg.includes('history') || msg.includes('star history');
    const avgMs = isHistory ? timingStats?.historyAvgMs : timingStats?.fetchAvgMs;
    els.progressElapsed.textContent = avgMs != null
      ? `${elapsed} · avg ${formatDuration(avgMs)}`
      : elapsed;
  }

  function appendLog(entry) {
    if (!entry?.message) return;
    const time = entry.time ? entry.time.slice(11, 19) : '';
    logLines.push({ level: entry.level || 'info', text: `[${time}] ${entry.message}` });
    while (logLines.length > MAX_LOG_LINES) logLines.shift();
    if (!showDebugBar) return;
    els.logPanel.innerHTML = logLines.map((l) =>
      `<div class="log-line ${l.level}">${escapeHtml(l.text)}</div>`
    ).join('');
    els.logPanel.scrollTop = els.logPanel.scrollHeight;
  }

  function renderLogPanel() {
    if (!showDebugBar) return;
    els.logPanel.innerHTML = logLines.map((l) =>
      `<div class="log-line ${l.level}">${escapeHtml(l.text)}</div>`
    ).join('');
    els.logPanel.scrollTop = els.logPanel.scrollHeight;
  }

  function applyDebugBar(on) {
    showDebugBar = !!on;
    els.logPanel.classList.toggle('hidden', !showDebugBar);
    els.logPanel.hidden = !showDebugBar;
    els.btnDebug.classList.toggle('is-on', showDebugBar);
    els.btnDebug.setAttribute('aria-pressed', showDebugBar ? 'true' : 'false');
    if (showDebugBar) renderLogPanel();
  }

  async function toggleDebugBar() {
    const next = !showDebugBar;
    applyDebugBar(next);
    try {
      await window.ghStats?.setSettings?.({ showDebugBar: next });
    } catch (_) {}
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setAuthBadge(text, state) {
    els.authBadge.textContent = text;
    els.authBadge.className = `auth-badge ${state || ''}`.trim();
  }

  function setFetching(on, message, startedAt) {
    els.btnRefresh.disabled = on;
    els.btnStarHistory.disabled = on;
    if (on) startFetchTimer(message, startedAt);
    else {
      stopTimer();
      els.progressBar.classList.add('hidden');
      els.progressElapsed.textContent = '';
    }
  }

  function formatRelative(ts) {
    if (!ts) return 'Never';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function timingSummary() {
    if (!timingStats) return '';
    const parts = [];
    if (timingStats.authAvgMs != null) parts.push(`auth avg ${formatDuration(timingStats.authAvgMs)}`);
    if (timingStats.fetchAvgMs != null) parts.push(`fetch avg ${formatDuration(timingStats.fetchAvgMs)}`);
    if (timingStats.historyAvgMs != null) parts.push(`history avg ${formatDuration(timingStats.historyAvgMs)}`);
    return parts.join(' · ');
  }

  function renderKpis(metrics) {
    const cards = [
      { label: 'Total stars', value: metrics.totalStars },
      { label: 'Total downloads', value: metrics.totalDownloads },
      { label: 'Stars today', value: metrics.starsToday },
      { label: 'Stars 7d', value: metrics.stars7d },
      { label: 'Stars 30d', value: metrics.stars30d },
      { label: 'DL today', value: metrics.downloadsToday },
      { label: 'DL 7d', value: metrics.downloads7d },
      { label: 'DL 30d', value: metrics.downloads30d }
    ];
    els.kpiGrid.innerHTML = cards.map((c) => `
      <article class="kpi-card">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${formatNumber(c.value)}</div>
      </article>
    `).join('');
  }

  function renderRepos(repos) {
    els.repoCount.textContent = `${repos.length} repos`;
    els.repoTbody.innerHTML = repos.map((r) => `
      <tr>
        <td><a href="https://github.com/${r.name}" target="_blank" rel="noopener">${r.name}</a></td>
        <td class="num">${formatNumber(r.stars)}</td>
        <td class="num">${formatNumber(r.downloads)}</td>
        <td class="num">${formatNumber(r.stars7d)}</td>
        <td class="num">${formatNumber(r.stars30d)}</td>
      </tr>
    `).join('');
  }

  function renderCharts(data) {
    const root = getComputedStyle(document.documentElement);
    const starsColor = root.getPropertyValue('--chart-stars').trim();
    const downloadsColor = root.getPropertyValue('--chart-downloads').trim();
    els.starsDailySub.textContent = data.meta.hasStarHistory ? 'From star history' : 'From snapshots';
    drawLineChart(els.charts.starsDaily, data.series.starsDaily, {
      color: starsColor,
      mode: 'bars',
      emptyText: 'No star deltas yet',
      valueLabel: 'New stars',
      tooltips: true
    });
    drawLineChart(els.charts.downloadsDaily, data.series.downloadsDaily, {
      color: downloadsColor,
      mode: 'bars',
      emptyText: 'Need more daily snapshots',
      valueLabel: 'New downloads',
      tooltips: true
    });
    drawLineChart(els.charts.starsCumulative, data.series.starsCumulative, {
      color: starsColor,
      emptyText: 'Refresh to load totals',
      interactive: false
    });
    drawLineChart(els.charts.downloadsTotal, data.series.downloadsTotal, {
      color: downloadsColor,
      emptyText: 'Refresh to load totals',
      interactive: false
    });
  }

  function renderMeta(data) {
    const timing = timingSummary();
    const base = `${formatRelative(data.meta.lastSnapshotAt)} · ${data.meta.snapshotCount} snaps`;
    els.lastUpdated.textContent = timing ? `${base} · ${timing}` : base;
    els.lastUpdated.title = timing || base;
  }

  function renderDashboard(data) {
    lastDashboard = data;
    renderKpis(data.metrics);
    renderRepos(data.repos);
    renderCharts(data);
    renderMeta(data);
  }

  async function loadTimings() {
    if (!window.ghStats?.getTimings) return;
    try { timingStats = await window.ghStats.getTimings(); } catch (_) {}
  }

  async function loadDashboard() {
    if (!window.ghStats) return;
    try {
      const range = currentRange === 'all' ? 'all' : Number(currentRange);
      const data = await window.ghStats.getDashboard(range);
      renderDashboard(data);
    } catch (err) {
      appendLog({ level: 'error', message: `dashboard: ${err.message}`, time: new Date().toISOString() });
      renderDashboard(EMPTY_DASHBOARD);
    }
  }

  async function checkAuth() {
    if (!window.ghStats) {
      setAuthBadge('No bridge', 'error');
      return;
    }
    startAuthTimer();
    try {
      const auth = await window.ghStats.checkAuth();
      stopTimer();
      if (auth.timing) timingStats = auth.timing;
      if (auth.ok) {
        let suffix = '';
        if (auth.ms != null && timingStats?.authAvgMs != null) {
          suffix = ` (${formatDuration(auth.ms)}, avg ${formatDuration(timingStats.authAvgMs)})`;
        } else if (auth.ms != null) {
          suffix = ` (${formatDuration(auth.ms)})`;
        }
        setAuthBadge(`${auth.user}${suffix}`, 'ok');
        appendLog({ level: 'info', message: `gh ok: ${auth.user} in ${formatDuration(auth.ms)}`, time: new Date().toISOString() });
      } else {
        setAuthBadge('Not authed', 'error');
        appendLog({ level: 'error', message: auth.error || 'gh auth failed', time: new Date().toISOString() });
      }
      if (lastDashboard) renderMeta(lastDashboard);
    } catch (err) {
      stopTimer();
      setAuthBadge('Auth timeout', 'error');
      appendLog({ level: 'error', message: `auth: ${err.message}`, time: new Date().toISOString() });
    }
  }

  async function loadLogs() {
    if (!window.ghStats?.getLogs) return;
    try {
      const logs = await window.ghStats.getLogs(30);
      logLines.length = 0;
      logs.forEach(appendLog);
    } catch (_) {}
  }

  els.btnDebug.addEventListener('click', () => {
    toggleDebugBar();
  });

  els.rangeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.range-tab');
    if (!btn) return;
    els.rangeTabs.querySelectorAll('.range-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    loadDashboard();
  });

  els.btnRefresh.addEventListener('click', async () => {
    setFetching(true, 'Fetching stars and downloads…');
    try {
      const result = await window.ghStats.runFetch({ includeStarHistory: false });
      if (result.timing) timingStats = result.timing;
      if (!result.ok) {
        els.progressText.textContent = result.error || 'Fetch failed';
        els.progressElapsed.textContent = formatDuration(result.ms);
        stopTimer();
      } else {
        setFetching(false);
      }
      await loadDashboard();
    } catch (err) {
      els.progressText.textContent = err.message;
      appendLog({ level: 'error', message: err.message, time: new Date().toISOString() });
    }
  });

  els.btnStarHistory.addEventListener('click', async () => {
    setFetching(true, 'Fetching star history…');
    try {
      const result = await window.ghStats.runFetch({ includeStarHistory: true });
      if (result.timing) timingStats = result.timing;
      if (!result.ok) {
        els.progressText.textContent = result.error || 'Fetch failed';
        els.progressElapsed.textContent = formatDuration(result.ms);
        stopTimer();
      } else {
        setFetching(false);
      }
      await loadDashboard();
    } catch (err) {
      els.progressText.textContent = err.message;
      appendLog({ level: 'error', message: err.message, time: new Date().toISOString() });
    }
  });

  if (window.ghStats) {
    window.ghStats.onFetchProgress((p) => {
      if (p.message) {
        if (p.phase === 'auth') startAuthTimer();
        else setFetching(true, p.message, p.startedAt);
      }
      if (p.phase === 'error') setAuthBadge('Error', 'error');
    });
    window.ghStats.onFetchDone((payload) => {
      if (payload?.timing) timingStats = payload.timing;
      setFetching(false);
      loadDashboard();
      loadTimings();
    });
    window.ghStats.onDashboardUpdated((data) => renderDashboard(data));
    window.ghStats.onLogEntry((entry) => appendLog(entry));
  }

  const resizeObserver = new ResizeObserver(() => {
    if (lastDashboard) renderCharts(lastDashboard);
  });
  document.querySelectorAll('.chart-body').forEach((el) => resizeObserver.observe(el));

  // Show empty UI immediately, then connect to main process.
  renderDashboard(EMPTY_DASHBOARD);

  if (!window.ghStats) {
    setAuthBadge('No bridge', 'error');
    appendLog({ level: 'error', message: 'preload bridge missing', time: new Date().toISOString() });
    return;
  }

  (async () => {
    try {
      await window.ghStats.ready();
      try {
        const settings = await window.ghStats.getSettings();
        applyDebugBar(!!settings.showDebugBar);
      } catch (_) {
        applyDebugBar(false);
      }
      await Promise.all([loadTimings(), loadDashboard(), checkAuth()]);
      loadLogs().then(() => { if (showDebugBar) renderLogPanel(); });
    } catch (err) {
      setAuthBadge('Startup error', 'error');
      appendLog({ level: 'error', message: `boot: ${err.message}`, time: new Date().toISOString() });
    }
  })();
})();
