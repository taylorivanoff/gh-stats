const { dateKey } = require('./collector');

function sumDailyMap(daily, startDate, endDate) {
  let total = 0;
  for (const [day, count] of Object.entries(daily || {})) {
    if (day >= startDate && day <= endDate) total += count;
  }
  return total;
}

function cumulativeStarSeries(daily) {
  const days = Object.keys(daily || {}).sort();
  let running = 0;
  return days.map((day) => {
    running += daily[day];
    return { date: day, value: running };
  });
}

function dailyStarSeries(daily, startDate, endDate) {
  const days = Object.keys(daily || {})
    .filter((d) => d >= startDate && d <= endDate)
    .sort();
  return days.map((day) => ({ date: day, value: daily[day] }));
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
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function deltaTotals(current, past) {
  if (!past) return { stars: current.stars, downloads: current.downloads };
  return {
    stars: current.stars - (past.totals?.stars || 0),
    downloads: current.downloads - (past.totals?.downloads || 0)
  };
}

function buildDownloadSeries(snapshots, startDate, endDate) {
  const filtered = snapshots.filter((s) => s.date >= startDate && s.date <= endDate);
  return filtered.map((s) => ({
    date: s.date,
    value: s.totals?.downloads || 0
  }));
}

function buildDownloadDeltaSeries(snapshots, startDate, endDate) {
  const filtered = snapshots.filter((s) => s.date >= startDate && s.date <= endDate);
  const out = [];
  for (let i = 0; i < filtered.length; i++) {
    const prev = i > 0 ? filtered[i - 1].totals?.downloads || 0 : filtered[i].totals?.downloads || 0;
    const cur = filtered[i].totals?.downloads || 0;
    const delta = i === 0 ? 0 : cur - prev;
    out.push({ date: filtered[i].date, value: Math.max(0, delta) });
  }
  return out;
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
  const startDate = rangeDays === 'all'
    ? (snapshots[0]?.date || daysAgo(90))
    : daysAgo(rangeDays === 7 ? 7 : rangeDays === 90 ? 90 : 30);

  const latestSnapshot = snapshots.length
    ? snapshots[snapshots.length - 1]
    : null;

  const current = currentTotals || latestSnapshot?.totals || { stars: 0, downloads: 0 };
  const currentRepos = currentTotals?.repos || latestSnapshot?.repos || [];

  const mergedStars = mergeStarHistories(starHistories);
  const hasStarHistory = Object.keys(mergedStars).length > 0;

  const snapshotToday = snapshots.find((s) => s.date === today) || findSnapshotOnOrBefore(snapshots, today);
  const snapshot7d = findSnapshotOnOrBefore(snapshots, daysAgo(7));
  const snapshot30d = findSnapshotOnOrBefore(snapshots, daysAgo(30));

  const starsTodayFromHistory = sumDailyMap(mergedStars, today, today);
  const stars7dFromHistory = sumDailyMap(mergedStars, daysAgo(7), today);
  const stars30dFromHistory = sumDailyMap(mergedStars, daysAgo(30), today);

  const downloadsToday = snapshotToday && latestSnapshot
    ? Math.max(0, (latestSnapshot.totals?.downloads || 0) - (snapshotToday.totals?.downloads || 0))
    : 0;
  const downloads7d = deltaTotals(
    latestSnapshot?.totals || current,
    snapshot7d?.totals
  ).downloads;
  const downloads30d = deltaTotals(
    latestSnapshot?.totals || current,
    snapshot30d?.totals
  ).downloads;

  const metrics = {
    totalStars: current.stars,
    totalDownloads: current.downloads,
    starsToday: hasStarHistory ? starsTodayFromHistory : deltaTotals(current, snapshotToday?.totals).stars,
    stars7d: hasStarHistory ? stars7dFromHistory : deltaTotals(current, snapshot7d?.totals).stars,
    stars30d: hasStarHistory ? stars30dFromHistory : deltaTotals(current, snapshot30d?.totals).stars,
    downloadsToday,
    downloads7d: Math.max(0, downloads7d),
    downloads30d: Math.max(0, downloads30d)
  };

  const starDailySeries = hasStarHistory
    ? dailyStarSeries(mergedStars, startDate, today)
    : [];

  let starCumulativeSeries = [];
  if (hasStarHistory) {
    const baseline = sumDailyMap(mergedStars, '1970-01-01', startDate);
    const daysInRange = Object.keys(mergedStars)
      .filter((d) => d >= startDate && d <= today)
      .sort();
    let running = baseline;
    starCumulativeSeries = daysInRange.map((day) => {
      running += mergedStars[day];
      return { date: day, value: running };
    });
  }

  const downloadTotalSeries = buildDownloadSeries(snapshots, startDate, today);
  const downloadDailySeries = buildDownloadDeltaSeries(snapshots, startDate, today);

  const repos = currentRepos.map((r) => {
    const hist = starHistories?.[r.name];
    const starDaily = hist?.daily || {};
    return {
      name: r.name,
      stars: r.stars,
      downloads: r.downloads,
      stars7d: sumDailyMap(starDaily, daysAgo(7), today),
      stars30d: sumDailyMap(starDaily, daysAgo(30), today)
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
      snapshotCount: snapshots.length,
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
  sumDailyMap
};
