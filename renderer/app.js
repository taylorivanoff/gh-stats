(function boot() {
  const charts = window.GhCharts;
  if (!charts) {
    const auth = document.getElementById('auth-badge');
    const gh = document.getElementById('gh-badge');
    if (auth) {
      auth.textContent = 'JS load error';
      auth.className = 'auth-badge error';
    }
    if (gh) {
      gh.textContent = 'gh ?';
      gh.className = 'auth-badge error';
    }
    return;
  }

  const { drawLineChart, formatNumber } = charts;

  let currentRange = 30;
  let currentView = 'analytics';
  let lastDashboard = null;
  let timingStats = null;
  const logLines = [];
  const MAX_LOG_LINES = 40;

  let timerInterval = null;
  let timerStartedAt = 0;
  let timerMode = null;
  let showDebugBar = false;

  const DEFAULT_LAYOUT = { tableH: 140 };

  const SPLITTER_SIZE = 10;
  const KPI_H = 52;

  let layout = { ...DEFAULT_LAYOUT };
  let saveLayoutTimer = null;
  let copyFlashTimer = null;

  const els = {
    ghBadge: document.getElementById('gh-badge'),
    authBadge: document.getElementById('auth-badge'),
    btnInstallGh: document.getElementById('btn-install-gh'),
    btnAuthLogin: document.getElementById('btn-auth-login'),
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
    viewTabs: document.getElementById('view-tabs'),
    rangeTabs: document.getElementById('range-tabs'),
    healthTabCount: document.getElementById('health-tab-count'),
    viewAnalytics: document.getElementById('view-analytics'),
    viewTraffic: document.getElementById('view-traffic'),
    viewHealth: document.getElementById('view-health'),
    mainPanels: document.getElementById('main-panels'),
    splitTable: document.getElementById('split-table'),
    issuesList: document.getElementById('issues-list'),
    buildsList: document.getElementById('builds-list'),
    releasesList: document.getElementById('releases-list'),
    issuesMeta: document.getElementById('issues-meta'),
    buildsMeta: document.getElementById('builds-meta'),
    releasesMeta: document.getElementById('releases-meta'),
    btnCopyIssues: document.getElementById('btn-copy-issues'),
    btnCopyBuilds: document.getElementById('btn-copy-builds'),
    btnCopyReleases: document.getElementById('btn-copy-releases'),
    trafficKpiGrid: document.getElementById('traffic-kpi-grid'),
    referrersList: document.getElementById('referrers-list'),
    onboardingOverlay: document.getElementById('onboarding-overlay'),
    btnOnboardingStart: document.getElementById('btn-onboarding-start'),
    btnOnboardingDismiss: document.getElementById('btn-onboarding-dismiss'),
    demoBanner: document.getElementById('demo-banner'),
    btnDismissDemo: document.getElementById('btn-dismiss-demo'),
    charts: {
      starsDaily: document.getElementById('chart-stars-daily'),
      downloadsDaily: document.getElementById('chart-downloads-daily'),
      starsCumulative: document.getElementById('chart-stars-cumulative'),
      downloadsTotal: document.getElementById('chart-downloads-total'),
      trafficViews: document.getElementById('chart-traffic-views'),
      trafficClones: document.getElementById('chart-traffic-clones')
    }
  };

  let ghBusy = false;
  let lastGhStatus = null;

  const platform = window.navigator.platform || '';
  if (platform.includes('Mac')) document.body.classList.add('platform-darwin');
  else if (platform.includes('Win')) document.body.classList.add('platform-win32');

  const EMPTY_DASHBOARD = {
    metrics: {
      totalStars: 0, totalDownloads: 0, starsToday: 0, stars7d: 0, stars30d: 0,
      downloadsToday: 0, downloads7d: 0, downloads30d: 0,
      npmDownloads: 0, pypiDownloads: 0, crateDownloads: 0,
      views14d: 0, clones14d: 0
    },
    series: {
      starsDaily: [], starsCumulative: [], downloadsDaily: [], downloadsTotal: [],
      traffic: { daily: [], referrers: [] }
    },
    repos: [],
    health: { fetchedAt: null, issueCount: 0, issues: [], builds: [], releases: [] },
    meta: { snapshotCount: 0, hasStarHistory: false, hasTraffic: false, lastSnapshotAt: null },
    demoMode: false,
    onboardingComplete: false
  };

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function applyLayout(next = layout) {
    layout = { ...DEFAULT_LAYOUT, ...next };
    document.documentElement.style.setProperty('--table-h', `${layout.tableH}px`);
  }

  function maxTableHeight() {
    if (!els.mainPanels) return 480;
    const kpiH = els.kpiGrid?.offsetHeight || KPI_H;
    const reserved = kpiH + 6 + 120 + SPLITTER_SIZE;
    return clamp(Math.floor(els.mainPanels.clientHeight - reserved), 72, 480);
  }

  function schedulePersistLayout() {
    if (saveLayoutTimer) clearTimeout(saveLayoutTimer);
    saveLayoutTimer = setTimeout(() => {
      saveLayoutTimer = null;
      if (window.ghStats?.setSettings) {
        window.ghStats.setSettings({ layout, activeView: currentView }).catch(() => {});
      }
    }, 200);
  }

  function finishResize(handle, pointerId) {
    handle.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing');
    if (pointerId != null) handle.releasePointerCapture(pointerId);
    schedulePersistLayout();
  }

  function bindHeightSplitter(handle, { getSize, setSize, invert = false }) {
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.classList.add('is-dragging');
      document.body.classList.add('is-resizing');
      const startY = e.clientY;
      const startSize = getSize();
      handle.setPointerCapture(e.pointerId);

      function onMove(ev) {
        const delta = ev.clientY - startY;
        setSize(startSize + (invert ? -delta : delta));
      }
      function onUp(ev) {
        finishResize(handle, ev.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  function initSplitters() {
    applyLayout();
    bindHeightSplitter(els.splitTable, {
      getSize: () => layout.tableH,
      setSize: (h) => applyLayout({ ...layout, tableH: clamp(Math.round(h), 72, maxTableHeight()) }),
      invert: true
    });
  }

  function setView(view, { persist = true } = {}) {
    currentView = ['health', 'traffic'].includes(view) ? view : 'analytics';
    const isHealth = currentView === 'health';
    const isTraffic = currentView === 'traffic';
    const isAnalytics = currentView === 'analytics';
    els.viewAnalytics?.classList.toggle('hidden', !isAnalytics);
    els.viewTraffic?.classList.toggle('hidden', !isTraffic);
    els.viewHealth?.classList.toggle('hidden', !isHealth);
    if (els.viewAnalytics) els.viewAnalytics.hidden = !isAnalytics;
    if (els.viewTraffic) els.viewTraffic.hidden = !isTraffic;
    if (els.viewHealth) els.viewHealth.hidden = !isHealth;
    els.rangeTabs?.classList.toggle('is-hidden', !isAnalytics && !isTraffic);
    els.viewTabs?.querySelectorAll('.view-tab').forEach((btn) => {
      const active = btn.dataset.view === currentView;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if ((isAnalytics || isTraffic) && lastDashboard) {
      requestAnimationFrame(() => renderCharts(lastDashboard));
    }
    if (persist) {
      window.ghStats?.setSettings?.({ activeView: currentView }).catch(() => {});
    }
  }

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
    setAuthBadge(`Checking ${elapsedLabel()}`, 'pending');
    timerInterval = setInterval(() => {
      if (timerMode === 'auth') setAuthBadge(`Checking ${elapsedLabel()}`, 'pending');
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

  function setBadge(el, text, state) {
    if (!el) return;
    el.textContent = text;
    el.title = text;
    el.className = `auth-badge ${state || ''}`.trim();
  }

  function setAuthBadge(text, state) {
    setBadge(els.authBadge, text, state);
  }

  function setGhBadge(text, state) {
    setBadge(els.ghBadge, text, state);
  }

  function updateSetupActions(status) {
    lastGhStatus = status;
    const installed = !!status?.installed;
    const authed = !!status?.authenticated || !!status?.ok;
    if (els.btnInstallGh) {
      els.btnInstallGh.classList.toggle('hidden', installed || ghBusy);
      els.btnInstallGh.disabled = ghBusy;
    }
    if (els.btnAuthLogin) {
      els.btnAuthLogin.classList.toggle('hidden', !installed || authed || ghBusy);
      els.btnAuthLogin.disabled = ghBusy || !installed;
    }
  }

  function applyGhStatus(status, authMs) {
    if (!status) return;
    if (status.installed) {
      const ver = status.version ? ` ${status.version}` : '';
      setGhBadge(`gh${ver}`, 'ok');
      if (els.ghBadge && status.path) els.ghBadge.title = status.path;
    } else {
      setGhBadge('gh missing', 'pending');
      if (els.ghBadge) els.ghBadge.title = status.message || 'GitHub CLI not installed';
    }

    if (!status.installed) {
      setAuthBadge('Install gh', 'error');
    } else if (status.authenticated || status.ok) {
      let suffix = '';
      const user = status.user || 'authed';
      if (authMs != null && timingStats?.authAvgMs != null) {
        suffix = ` (${formatDuration(authMs)}, avg ${formatDuration(timingStats.authAvgMs)})`;
      } else if (authMs != null) {
        suffix = ` (${formatDuration(authMs)})`;
      }
      setAuthBadge(`${user}${suffix}`, 'ok');
    } else {
      setAuthBadge('Not authed', 'error');
      if (els.authBadge) els.authBadge.title = status.message || status.error || 'Run gh auth login';
    }
    updateSetupActions({
      installed: status.installed,
      authenticated: status.authenticated || status.ok,
      version: status.version,
      path: status.path,
      message: status.message || status.error,
      user: status.user
    });
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

  function shortIso(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }

  function runBadge(run) {
    const status = String(run?.status || '').toLowerCase();
    const conclusion = String(run?.conclusion || '').toLowerCase();
    if (status === 'in_progress' || status === 'queued' || status === 'waiting' || status === 'pending') {
      return { label: status, cls: 'info' };
    }
    if (conclusion === 'success') return { label: 'success', cls: 'ok' };
    if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'cancelled' || conclusion === 'startup_failure') {
      return { label: conclusion, cls: 'error' };
    }
    if (conclusion) return { label: conclusion, cls: 'warn' };
    return { label: status || 'unknown', cls: 'info' };
  }

  function issueBadge(issue) {
    const sev = String(issue?.severity || 'info');
    const kind = String(issue?.kind || 'issue').replace(/_/g, ' ');
    return { label: kind, cls: sev === 'error' || sev === 'warn' || sev === 'info' ? sev : 'info' };
  }

  async function copyText(text, btn) {
    const value = String(text || '').trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        if (copyFlashTimer) clearTimeout(copyFlashTimer);
        copyFlashTimer = setTimeout(() => {
          btn.textContent = prev;
        }, 1200);
      }
    } catch (err) {
      appendLog({ level: 'error', message: `copy failed: ${err.message}`, time: new Date().toISOString() });
    }
  }

  function formatIssuesCopy(issues) {
    if (!issues?.length) return 'No attention items.';
    const lines = ['GhStats — Attention', `Generated ${new Date().toISOString()}`, ''];
    for (const issue of issues) {
      const link = issue.runUrl || issue.releaseUrl || `https://github.com/${issue.repo}`;
      lines.push(`- [${issue.severity}] ${issue.repo}: ${issue.message}`);
      lines.push(`  ${link}`);
    }
    return lines.join('\n');
  }

  function formatBuildsCopy(builds) {
    if (!builds?.length) return 'No recent builds.';
    const lines = ['GhStats — Recent builds', `Generated ${new Date().toISOString()}`, ''];
    for (const run of builds) {
      const badge = runBadge(run);
      lines.push(`- ${run.repo} · ${run.name} · ${badge.label}${run.branch ? ` · ${run.branch}` : ''}`);
      if (run.url) lines.push(`  ${run.url}`);
    }
    return lines.join('\n');
  }

  function formatReleasesCopy(releases) {
    if (!releases?.length) return 'No recent releases.';
    const lines = ['GhStats — Recent releases', `Generated ${new Date().toISOString()}`, ''];
    for (const rel of releases) {
      const flags = [
        rel.draft ? 'draft' : null,
        rel.prerelease ? 'pre' : null,
        Number(rel.assetCount) === 0 ? 'no-assets' : null
      ].filter(Boolean).join(', ');
      lines.push(`- ${rel.repo} · ${rel.tag}${flags ? ` (${flags})` : ''} · ${formatNumber(rel.downloads || 0)} dl`);
      if (rel.url) lines.push(`  ${rel.url}`);
    }
    return lines.join('\n');
  }

  function rowCopyButton(text) {
    return `<button type="button" class="ops-copy-one" data-copy="${encodeURIComponent(text)}" title="Copy row">Copy</button>`;
  }

  function renderHealth(health) {
    const data = health || EMPTY_DASHBOARD.health;
    const issues = data.issues || [];
    const builds = data.builds || [];
    const releases = data.releases || [];

    if (els.healthTabCount) {
      const count = issues.length;
      els.healthTabCount.textContent = String(count);
      els.healthTabCount.classList.toggle('hidden', count === 0);
      els.healthTabCount.title = count ? `${count} items need attention` : '';
    }

    els.issuesMeta.textContent = issues.length ? `${issues.length}` : 'Clear';
    els.buildsMeta.textContent = builds.length ? `${builds.length}` : '—';
    els.releasesMeta.textContent = releases.length ? `${releases.length}` : '—';

    if (!issues.length) {
      els.issuesList.innerHTML = `<div class="ops-empty">${data.fetchedAt ? 'No open issues across listed repos' : 'Refresh to scan builds & releases'}</div>`;
    } else {
      els.issuesList.innerHTML = issues.map((issue) => {
        const badge = issueBadge(issue);
        const href = issue.runUrl || issue.releaseUrl || `https://github.com/${issue.repo}`;
        const line = `${issue.repo}: ${issue.message}${href ? `\n${href}` : ''}`;
        return `
          <div class="ops-row">
            <div class="ops-row-main">
              <div class="ops-row-top">
                <a class="ops-repo" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(issue.repo)}</a>
                <span class="ops-badge ${badge.cls}">${escapeHtml(badge.label)}</span>
              </div>
              <div class="ops-msg" title="${escapeHtml(issue.message)}">${escapeHtml(issue.message)}</div>
            </div>
            ${rowCopyButton(line)}
          </div>
        `;
      }).join('');
    }

    if (!builds.length) {
      els.buildsList.innerHTML = `<div class="ops-empty">${data.fetchedAt ? 'No workflow runs found' : 'Refresh to load builds'}</div>`;
    } else {
      els.buildsList.innerHTML = builds.map((run) => {
        const badge = runBadge(run);
        const when = shortIso(run.createdAt);
        const detail = [run.name, run.branch, when].filter(Boolean).join(' · ');
        const href = run.url || `https://github.com/${run.repo}/actions`;
        const line = `${run.repo} · ${run.name} · ${badge.label}${run.branch ? ` · ${run.branch}` : ''}${href ? `\n${href}` : ''}`;
        return `
          <div class="ops-row">
            <div class="ops-row-main">
              <div class="ops-row-top">
                <a class="ops-repo" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(run.repo)}</a>
                <span class="ops-badge ${badge.cls}">${escapeHtml(badge.label)}</span>
              </div>
              <div class="ops-msg" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>
            </div>
            ${rowCopyButton(line)}
          </div>
        `;
      }).join('');
    }

    if (!releases.length) {
      els.releasesList.innerHTML = `<div class="ops-empty">${data.fetchedAt ? 'No releases published' : 'Refresh to load releases'}</div>`;
    } else {
      els.releasesList.innerHTML = releases.map((rel) => {
        const flags = [];
        if (rel.draft) flags.push('draft');
        if (rel.prerelease) flags.push('pre');
        if (Number(rel.assetCount) === 0) flags.push('no assets');
        const badgeCls = rel.draft || Number(rel.assetCount) === 0 ? 'error' : (rel.prerelease ? 'warn' : 'ok');
        const badgeLabel = flags[0] || 'release';
        const detail = [rel.tag, shortIso(rel.publishedAt), `${formatNumber(rel.downloads || 0)} dl`].filter(Boolean).join(' · ');
        const href = rel.url || `https://github.com/${rel.repo}/releases`;
        const line = `${rel.repo} · ${rel.tag}${flags.length ? ` (${flags.join(', ')})` : ''} · ${formatNumber(rel.downloads || 0)} dl${href ? `\n${href}` : ''}`;
        return `
          <div class="ops-row">
            <div class="ops-row-main">
              <div class="ops-row-top">
                <a class="ops-repo" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(rel.repo)}</a>
                <span class="ops-badge ${badgeCls}">${escapeHtml(badgeLabel)}</span>
              </div>
              <div class="ops-msg" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>
            </div>
            ${rowCopyButton(line)}
          </div>
        `;
      }).join('');
    }
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
      { label: 'DL 30d', value: metrics.downloads30d },
      { label: 'npm (30d)', value: metrics.npmDownloads },
      { label: 'PyPI (30d)', value: metrics.pypiDownloads },
      { label: 'Views 14d', value: metrics.views14d },
      { label: 'Clones 14d', value: metrics.clones14d }
    ];
    els.kpiGrid.innerHTML = cards.map((c) => `
      <article class="kpi-card">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${formatNumber(c.value)}</div>
      </article>
    `).join('');
  }

  function renderTrafficKpis(metrics) {
    if (!els.trafficKpiGrid) return;
    const cards = [
      { label: 'Views (14d)', value: metrics.views14d },
      { label: 'Clones (14d)', value: metrics.clones14d },
      { label: 'npm downloads', value: metrics.npmDownloads },
      { label: 'PyPI downloads', value: metrics.pypiDownloads },
      { label: 'crates.io', value: metrics.crateDownloads }
    ];
    els.trafficKpiGrid.innerHTML = cards.map((c) => `
      <article class="kpi-card">
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${formatNumber(c.value)}</div>
      </article>
    `).join('');
  }

  function renderReferrers(traffic) {
    if (!els.referrersList) return;
    const referrers = traffic?.referrers || [];
    if (!referrers.length) {
      els.referrersList.innerHTML = '<div class="ops-empty">Refresh to collect referrer data (preserved beyond GitHub\'s 14-day limit)</div>';
      return;
    }
    els.referrersList.innerHTML = referrers.map((r) => `
      <div class="referrer-row">
        <span class="referrer-name">${escapeHtml(r.referrer || '(direct)')}</span>
        <span class="referrer-count">${formatNumber(r.count)} views · ${formatNumber(r.uniques)} unique</span>
      </div>
    `).join('');
  }

  function renderRepos(repos) {
    els.repoCount.textContent = `${repos.length} repos`;
    els.repoTbody.innerHTML = repos.map((r) => `
      <tr>
        <td><a href="https://github.com/${r.name}" target="_blank" rel="noopener">${r.name}</a></td>
        <td class="num">${formatNumber(r.stars)}</td>
        <td class="num">${formatNumber(r.downloads)}</td>
        <td class="num">${formatNumber(r.npmDownloads || 0)}</td>
        <td class="num">${formatNumber(r.pypiDownloads || 0)}</td>
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

    const traffic = data.series.traffic || { daily: [] };
    const viewsSeries = (traffic.daily || []).map((d) => ({ date: d.date, value: d.views || 0 }));
    const clonesSeries = (traffic.daily || []).map((d) => ({ date: d.date, value: d.clones || 0 }));
    const trafficColor = root.getPropertyValue('--chart-traffic').trim() || '#6366f1';
    if (els.charts.trafficViews) {
      drawLineChart(els.charts.trafficViews, viewsSeries, {
        color: trafficColor,
        mode: 'bars',
        emptyText: 'Refresh to collect traffic snapshots',
        valueLabel: 'Views',
        interactive: false
      });
    }
    if (els.charts.trafficClones) {
      drawLineChart(els.charts.trafficClones, clonesSeries, {
        color: trafficColor,
        mode: 'bars',
        emptyText: 'Refresh to collect traffic snapshots',
        valueLabel: 'Clones',
        interactive: false
      });
    }
  }

  function renderMeta(data) {
    const timing = timingSummary();
    const issues = data.health?.issueCount || 0;
    const healthBit = issues ? `${issues} attention` : 'health ok';
    const base = `${formatRelative(data.meta.lastSnapshotAt)} · ${data.meta.snapshotCount} snaps · ${healthBit}`;
    els.lastUpdated.textContent = timing ? `${base} · ${timing}` : base;
    els.lastUpdated.title = timing || base;
  }

  function renderDashboard(data) {
    lastDashboard = data;
    renderKpis(data.metrics);
    renderTrafficKpis(data.metrics);
    renderReferrers(data.series?.traffic);
    renderRepos(data.repos);
    renderCharts(data);
    renderHealth(data.health);
    renderMeta(data);
    updateDemoBanner(data);
    maybeShowOnboarding(data);
  }

  function updateDemoBanner(data) {
    const show = !!data.demoMode;
    els.demoBanner?.classList.toggle('hidden', !show);
    if (els.demoBanner) els.demoBanner.hidden = !show;
  }

  function maybeShowOnboarding(data) {
    if (data.onboardingComplete || !els.onboardingOverlay) return;
    els.onboardingOverlay.classList.remove('hidden');
    els.onboardingOverlay.hidden = false;
  }

  function hideOnboarding() {
    els.onboardingOverlay?.classList.add('hidden');
    if (els.onboardingOverlay) els.onboardingOverlay.hidden = true;
    window.ghStats?.completeOnboarding?.().catch(() => {});
  }

  window.__ghStatsRender = renderDashboard;

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
      setGhBadge('gh ?', 'error');
      setAuthBadge('No bridge', 'error');
      return;
    }
    startAuthTimer();
    try {
      const auth = await window.ghStats.checkAuth();
      stopTimer();
      if (auth.timing) timingStats = auth.timing;
      applyGhStatus(auth, auth.ms);
      if (auth.ok) {
        appendLog({ level: 'info', message: `gh ok: ${auth.user} in ${formatDuration(auth.ms)}`, time: new Date().toISOString() });
      } else if (auth.installed === false) {
        appendLog({ level: 'error', message: auth.error || 'gh not installed', time: new Date().toISOString() });
      } else {
        appendLog({ level: 'error', message: auth.error || 'gh auth failed', time: new Date().toISOString() });
      }
      if (lastDashboard) renderMeta(lastDashboard);
    } catch (err) {
      stopTimer();
      setAuthBadge('Auth timeout', 'error');
      appendLog({ level: 'error', message: `auth: ${err.message}`, time: new Date().toISOString() });
    }
  }

  async function installGh() {
    if (!window.ghStats?.installGh || ghBusy) return;
    ghBusy = true;
    updateSetupActions(lastGhStatus || { installed: false });
    setGhBadge('Installing…', 'pending');
    appendLog({ level: 'info', message: 'Installing GitHub CLI…', time: new Date().toISOString() });
    try {
      const result = await window.ghStats.installGh();
      if (result.status) applyGhStatus(result.status);
      if (result.ok) {
        appendLog({ level: 'info', message: result.message || 'gh installed', time: new Date().toISOString() });
        await checkAuth();
      } else {
        setGhBadge('gh missing', 'error');
        appendLog({ level: 'error', message: result.error || 'Install failed', time: new Date().toISOString() });
      }
    } catch (err) {
      setGhBadge('Install failed', 'error');
      appendLog({ level: 'error', message: `install: ${err.message}`, time: new Date().toISOString() });
    } finally {
      ghBusy = false;
      updateSetupActions(lastGhStatus || { installed: false });
    }
  }

  async function authLogin() {
    if (!window.ghStats?.authLogin || ghBusy) return;
    ghBusy = true;
    updateSetupActions(lastGhStatus || { installed: true, authenticated: false });
    setAuthBadge('Sign in…', 'pending');
    appendLog({ level: 'info', message: 'Starting gh auth login…', time: new Date().toISOString() });
    try {
      const result = await window.ghStats.authLogin();
      if (result.ok) {
        appendLog({ level: 'info', message: result.message || 'auth login started', time: new Date().toISOString() });
        setAuthBadge('Complete in console', 'pending');
      } else {
        setAuthBadge('Sign in failed', 'error');
        appendLog({ level: 'error', message: result.error || 'auth login failed', time: new Date().toISOString() });
      }
    } catch (err) {
      setAuthBadge('Sign in failed', 'error');
      appendLog({ level: 'error', message: `auth login: ${err.message}`, time: new Date().toISOString() });
    } finally {
      ghBusy = false;
      updateSetupActions(lastGhStatus || { installed: true, authenticated: false });
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

  els.btnCopyIssues?.addEventListener('click', () => {
    copyText(formatIssuesCopy(lastDashboard?.health?.issues), els.btnCopyIssues);
  });
  els.btnCopyBuilds?.addEventListener('click', () => {
    copyText(formatBuildsCopy(lastDashboard?.health?.builds), els.btnCopyBuilds);
  });
  els.btnCopyReleases?.addEventListener('click', () => {
    copyText(formatReleasesCopy(lastDashboard?.health?.releases), els.btnCopyReleases);
  });

  function bindOpsListCopy(listEl) {
    listEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy]');
      if (!btn) return;
      e.preventDefault();
      let decoded = '';
      try {
        decoded = decodeURIComponent(btn.getAttribute('data-copy') || '');
      } catch (_) {
        decoded = btn.getAttribute('data-copy') || '';
      }
      copyText(decoded, btn);
    });
  }
  bindOpsListCopy(els.issuesList);
  bindOpsListCopy(els.buildsList);
  bindOpsListCopy(els.releasesList);

  els.btnInstallGh?.addEventListener('click', () => {
    installGh();
  });

  els.btnAuthLogin?.addEventListener('click', async () => {
    await authLogin();
  });

  // Re-check after user may have finished console auth (when window gains focus).
  let focusRecheckTimer = null;
  window.addEventListener('focus', () => {
    if (lastGhStatus?.authenticated || lastGhStatus?.ok) return;
    if (!lastGhStatus?.installed) return;
    if (focusRecheckTimer) clearTimeout(focusRecheckTimer);
    focusRecheckTimer = setTimeout(() => {
      checkAuth();
    }, 800);
  });

  els.rangeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.range-tab');
    if (!btn) return;
    els.rangeTabs.querySelectorAll('.range-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    loadDashboard();
  });

  els.viewTabs?.addEventListener('click', (e) => {
    const btn = e.target.closest('.view-tab');
    if (!btn?.dataset.view) return;
    setView(btn.dataset.view);
  });

  function showFetchError(message) {
    stopTimer();
    timerMode = null;
    els.btnRefresh.disabled = false;
    els.btnStarHistory.disabled = false;
    els.progressBar.classList.remove('hidden');
    els.progressText.textContent = message || 'Fetch failed';
    els.progressElapsed.textContent = '';
  }

  async function startFetch(includeStarHistory, pendingMessage) {
    setFetching(true, pendingMessage);
    try {
      const result = await window.ghStats.runFetch({ includeStarHistory });
      if (!result?.ok || result.started === false) {
        showFetchError(result?.error || 'Fetch failed');
      }
      // Success path is event-driven: fetch:progress / fetch:done
    } catch (err) {
      showFetchError(err.message);
      appendLog({ level: 'error', message: err.message, time: new Date().toISOString() });
    }
  }

  els.btnOnboardingStart?.addEventListener('click', () => {
    hideOnboarding();
    if (!lastGhStatus?.authenticated) {
      authLogin();
    } else {
      startFetch(false, 'Fetching your repos…');
    }
  });

  els.btnOnboardingDismiss?.addEventListener('click', () => {
    hideOnboarding();
  });

  els.btnDismissDemo?.addEventListener('click', async () => {
    await window.ghStats?.dismissDemo?.();
    if (!lastGhStatus?.authenticated) {
      authLogin();
    } else {
      startFetch(false, 'Fetching your repos…');
    }
  });

  els.btnRefresh.addEventListener('click', () => {
    startFetch(false, 'Fetching stars, releases, and builds…');
  });

  els.btnStarHistory.addEventListener('click', () => {
    startFetch(true, 'Fetching star history…');
  });

  if (window.ghStats) {
    window.ghStats.onFetchProgress((p) => {
      if (p.phase === 'error') {
        showFetchError(p.message || 'Fetch failed');
        setAuthBadge('Error', 'error');
        return;
      }
      if (p.message) {
        if (p.phase === 'auth') startAuthTimer();
        else setFetching(true, p.message, p.startedAt);
      }
    });
    window.ghStats.onFetchDone((payload) => {
      if (payload?.timing) timingStats = payload.timing;
      setFetching(false);
      loadDashboard();
      loadTimings();
      checkAuth();
    });
    window.ghStats.onDashboardUpdated((data) => renderDashboard(data));
    window.ghStats.onLogEntry((entry) => appendLog(entry));
  }

  const resizeObserver = new ResizeObserver(() => {
    if (currentView === 'analytics' && lastDashboard) renderCharts(lastDashboard);
  });
  document.querySelectorAll('.chart-body').forEach((el) => resizeObserver.observe(el));

  // Show empty UI immediately, then connect to main process.
  renderDashboard(EMPTY_DASHBOARD);
  initSplitters();
  setView('analytics', { persist: false });

  if (!window.ghStats) {
    if (!window.__ghStatsWebMode) {
      setAuthBadge('No bridge', 'error');
      appendLog({ level: 'error', message: 'preload bridge missing', time: new Date().toISOString() });
    }
    return;
  }

  (async () => {
    try {
      await window.ghStats.ready();
      try {
        const settings = await window.ghStats.getSettings();
        applyDebugBar(!!settings.showDebugBar);
        if (settings.layout) applyLayout(settings.layout);
        if (settings.activeView) setView(settings.activeView, { persist: false });
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
