const { dateKey } = require('./collector');

function sumDailyMap(daily, startDate, endDate) {
  let total = 0;
  for (const [day, count] of Object.entries(daily || {})) {
    if (day >= startDate && day <= endDate) total += count;
  }
  return total;
}

function findSnapshotOnOrBefore(snapshots, targetDate) {
  let best = null;
  for (const s of snapshots) {
    if (s.date <= targetDate) best = s;
    else break;
  }
  return best;
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function eachDay(startDate, endDate) {
  const out = [];
  const cur = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function deltaTotals(current, pastTotals) {
  if (!pastTotals) return { stars: null, downloads: null };
  return {
    stars: Math.max(0, (current.stars || 0) - (pastTotals.stars || 0)),
    downloads: Math.max(0, (current.downloads || 0) - (pastTotals.downloads || 0))
  };
}

function metricOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

/** Snapshot points for a totals field within [start, end]. */
function snapshotFieldPoints(snapshots, field, startDate, endDate) {
  return snapshots
    .filter((s) => s.date >= startDate && s.date <= endDate)
    .map((s) => ({
      date: s.date,
      value: s.totals?.[field] || 0
    }));
}

function repoMap(snapshot) {
  const map = new Map();
  for (const r of snapshot?.repos || []) {
    map.set(r.name, { stars: r.stars || 0, downloads: r.downloads || 0 });
  }
  return map;
}

function repoFieldDeltas(prevSnap, curSnap, field) {
  const prev = repoMap(prevSnap);
  const cur = repoMap(curSnap);
  const names = new Set([...prev.keys(), ...cur.keys()]);
  const changes = [];
  for (const name of names) {
    const a = prev.get(name)?.[field] || 0;
    const b = cur.get(name)?.[field] || 0;
    const delta = b - a;
    if (delta !== 0) changes.push({ name, delta });
  }
  return changes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

/**
 * Daily deltas between consecutive snapshots in range, with per-repo breakdown.
 */
function snapshotDeltaPoints(snapshots, field, startDate, endDate) {
  const inRange = snapshots.filter((s) => s.date >= startDate && s.date <= endDate);
  if (!inRange.length) return [];

  const before = findSnapshotOnOrBefore(
    snapshots.filter((s) => s.date < startDate),
    startDate
  );

  const out = [];
  for (let i = 0; i < inRange.length; i++) {
    const prevSnap = i === 0 ? before : inRange[i - 1];
    const curSnap = inRange[i];
    const prevTotal = prevSnap?.totals?.[field]
      ?? (i === 0 && !before ? (curSnap.totals?.[field] || 0) : 0);
    const curTotal = curSnap.totals?.[field] || 0;
    const noBaseline = i === 0 && !before;
    const delta = noBaseline ? 0 : Math.max(0, curTotal - prevTotal);
    const repos = noBaseline || !prevSnap
      ? []
      : repoFieldDeltas(prevSnap, curSnap, field).filter((r) => r.delta > 0);
    out.push({ date: curSnap.date, value: delta, repos });
  }
  return out;
}

/**
 * Per-day star deltas from stargazer history, with which repos gained stars.
 */
function starHistoryDailyPoints(starHistories, startDate, endDate) {
  const byDay = new Map(); // day -> { value, repos: Map(name->count) }
  for (const [repo, hist] of Object.entries(starHistories || {})) {
    for (const [day, count] of Object.entries(hist.daily || {})) {
      if (day < startDate || day > endDate) continue;
      if (!byDay.has(day)) byDay.set(day, { value: 0, repos: new Map() });
      const entry = byDay.get(day);
      entry.value += count;
      entry.repos.set(repo, (entry.repos.get(repo) || 0) + count);
    }
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, entry]) => ({
      date,
      value: entry.value,
      repos: [...entry.repos.entries()]
        .map(([name, delta]) => ({ name, delta }))
        .sort((a, b) => b.delta - a.delta)
    }));
}

/**
 * Fill every day in range, carrying forward known cumulative values.
 * Before the first snapshot, uses that first known total so a brand-new
 * install still draws a full visible line across the selected window.
 */
function fillCarryForward(points, startDate, endDate) {
  if (!points.length) return [];
  const byDate = new Map(points.map((p) => [p.date, p.value]));
  let last = points[0].value;
  return eachDay(startDate, endDate).map((day) => {
    if (byDate.has(day)) last = byDate.get(day);
    return { date: day, value: last };
  });
}

/**
 * Fill every day in range for sparse daily deltas (0 on missing days),
 * starting at the first point date. Preserves `repos` metadata when present.
 */
function fillDailyZeros(points, startDate, endDate) {
  if (!points.length) return [];
  const byDate = new Map(points.map((p) => [p.date, p]));
  const firstDate = points[0].date;
  return eachDay(startDate, endDate)
    .filter((day) => day >= firstDate)
    .map((day) => {
      const hit = byDate.get(day);
      if (hit) return { date: day, value: hit.value || 0, repos: hit.repos || [] };
      return { date: day, value: 0, repos: [] };
    });
}

function mergeStarHistories(histories) {
  const merged = {};
  for (const hist of Object.values(histories || {})) {
    for (const [day, count] of Object.entries(hist.daily || {})) {
      merged[day] = (merged[day] || 0) + count;
    }
  }
  return merged;
}

function buildDashboard({
  snapshots,
  starHistories,
  currentTotals,
  rangeDays = 30
}) {
  const today = dateKey();
  const sorted = [...(snapshots || [])].sort((a, b) => a.date.localeCompare(b.date));

  let startDate;
  if (rangeDays === 'all') {
    startDate = sorted[0]?.date || daysAgo(90);
  } else {
    const n = rangeDays === 7 ? 7 : rangeDays === 90 ? 90 : 30;
    startDate = daysAgo(n);
  }

  const latestSnapshot = sorted.length ? sorted[sorted.length - 1] : null;
  const current = currentTotals?.stars != null
    ? { stars: currentTotals.stars, downloads: currentTotals.downloads }
    : (latestSnapshot?.totals || { stars: 0, downloads: 0 });
  const currentRepos = currentTotals?.repos || latestSnapshot?.repos || [];

  const mergedStars = mergeStarHistories(starHistories);
  const hasStarHistory = Object.keys(mergedStars).length > 0;

  // Baselines for period deltas: prefer a snapshot *before* the window.
  const beforeToday = findSnapshotOnOrBefore(
    sorted.filter((s) => s.date < today),
    daysAgo(1)
  );
  const before7d = findSnapshotOnOrBefore(sorted, daysAgo(7));
  const before30d = findSnapshotOnOrBefore(sorted, daysAgo(30));

  const starsTodayFromHistory = sumDailyMap(mergedStars, today, today);
  const stars7dFromHistory = sumDailyMap(mergedStars, daysAgo(7), today);
  const stars30dFromHistory = sumDailyMap(mergedStars, daysAgo(30), today);

  const dlToday = deltaTotals(current, beforeToday?.totals).downloads;
  const dl7d = deltaTotals(current, before7d?.totals).downloads;
  const dl30d = deltaTotals(current, before30d?.totals).downloads;
  const stToday = deltaTotals(current, beforeToday?.totals).stars;
  const st7d = deltaTotals(current, before7d?.totals).stars;
  const st30d = deltaTotals(current, before30d?.totals).stars;

  const metrics = {
    totalStars: current.stars || 0,
    totalDownloads: current.downloads || 0,
    starsToday: hasStarHistory ? starsTodayFromHistory : metricOrZero(stToday),
    stars7d: hasStarHistory ? stars7dFromHistory : metricOrZero(st7d),
    stars30d: hasStarHistory ? stars30dFromHistory : metricOrZero(st30d),
    downloadsToday: metricOrZero(dlToday),
    downloads7d: metricOrZero(dl7d),
    downloads30d: metricOrZero(dl30d)
  };

  // Star series: prefer stargazer history; fall back to snapshot totals/deltas.
  let starDailySeries;
  let starCumulativeSeries;
  if (hasStarHistory) {
    starDailySeries = fillDailyZeros(
      starHistoryDailyPoints(starHistories, startDate, today),
      startDate,
      today
    );
    const dayBeforeStart = (() => {
      const d = new Date(`${startDate}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    })();
    const beforeStart = sumDailyMap(mergedStars, '1970-01-01', dayBeforeStart);
    const daysInRange = Object.keys(mergedStars)
      .filter((d) => d >= startDate && d <= today)
      .sort();
    let running = beforeStart;
    const points = daysInRange.map((day) => {
      running += mergedStars[day];
      return { date: day, value: running };
    });
    if (!points.length && current.stars) {
      starCumulativeSeries = fillCarryForward(
        [{ date: today, value: current.stars }],
        startDate,
        today
      );
    } else {
      starCumulativeSeries = fillCarryForward(points, startDate, today);
    }
  } else {
    const starPoints = snapshotFieldPoints(sorted, 'stars', startDate, today);
    // If latest totals exist but no in-range snapshot point, seed with today.
    if (!starPoints.length && (current.stars || latestSnapshot)) {
      starPoints.push({
        date: latestSnapshot?.date || today,
        value: current.stars || 0
      });
    }
    starCumulativeSeries = fillCarryForward(starPoints, startDate, today);
    starDailySeries = fillDailyZeros(
      snapshotDeltaPoints(sorted, 'stars', startDate, today),
      startDate,
      today
    );
  }

  let downloadPoints = snapshotFieldPoints(sorted, 'downloads', startDate, today);
  if (!downloadPoints.length && (current.downloads || latestSnapshot)) {
    downloadPoints = [{
      date: latestSnapshot?.date || today,
      value: current.downloads || 0
    }];
  }
  const downloadTotalSeries = fillCarryForward(downloadPoints, startDate, today);
  const downloadDailySeries = fillDailyZeros(
    snapshotDeltaPoints(sorted, 'downloads', startDate, today),
    startDate,
    today
  );

  const repos = currentRepos.map((r) => {
    const hist = starHistories?.[r.name];
    const starDaily = hist?.daily || {};
    return {
      name: r.name,
      stars: r.stars,
      downloads: r.downloads,
      stars7d: hasStarHistory ? sumDailyMap(starDaily, daysAgo(7), today) : 0,
      stars30d: hasStarHistory ? sumDailyMap(starDaily, daysAgo(30), today) : 0
    };
  });

  return {
    metrics,
    series: {
      starsDaily: starDailySeries,
      starsCumulative: starCumulativeSeries,
      downloadsTotal: downloadTotalSeries,
      downloadsDaily: downloadDailySeries
    },
    repos,
    meta: {
      snapshotCount: sorted.length,
      hasStarHistory,
      rangeStart: startDate,
      rangeEnd: today,
      lastSnapshotAt: latestSnapshot?.timestamp || null
    }
  };
}

module.exports = {
  buildDashboard,
  mergeStarHistories,
  sumDailyMap,
  fillCarryForward,
  snapshotFieldPoints
};
