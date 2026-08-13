use serde_json::{json, Map, Value};

use crate::collector::{date_key, HealthSnapshot};
use crate::store::Snapshot;
use crate::traffic::{aggregate_traffic_series, TrafficSnapshot};

fn days_ago(n: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::days(n))
        .format("%Y-%m-%d")
        .to_string()
}

fn each_day(start: &str, end: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d").ok();
    let end_d = chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d").ok();
    while let (Some(c), Some(e)) = (cur, end_d) {
        if c > e {
            break;
        }
        out.push(c.format("%Y-%m-%d").to_string());
        cur = c.succ_opt();
    }
    out
}

fn sum_daily_map(daily: &Map<String, Value>, start: &str, end: &str) -> u64 {
    let mut total = 0u64;
    for (day, count) in daily {
        if day.as_str() >= start && day.as_str() <= end {
            total += count.as_u64().unwrap_or(0);
        }
    }
    total
}

fn find_snapshot_on_or_before<'a>(snapshots: &'a [Snapshot], target: &str) -> Option<&'a Snapshot> {
    let mut best = None;
    for s in snapshots {
        if s.date.as_str() <= target {
            best = Some(s);
        } else {
            break;
        }
    }
    best
}

fn fill_carry_forward(points: &[(String, u64)], start: &str, end: &str) -> Vec<Value> {
    if points.is_empty() {
        return vec![];
    }
    let by_date: std::collections::HashMap<_, _> =
        points.iter().map(|(d, v)| (d.clone(), *v)).collect();
    let mut last = points[0].1;
    each_day(start, end)
        .into_iter()
        .map(|day| {
            if let Some(v) = by_date.get(&day) {
                last = *v;
            }
            json!({ "date": day, "value": last })
        })
        .collect()
}

struct DailyPoint {
    date: String,
    value: u64,
    repos: Vec<Value>,
}

fn fill_daily_zeros(points: &[DailyPoint], start: &str, end: &str) -> Vec<Value> {
    if points.is_empty() {
        return vec![];
    }
    let by_date: std::collections::HashMap<_, _> = points
        .iter()
        .map(|p| (p.date.clone(), p))
        .collect();
    let first = points[0].date.clone();
    each_day(start, end)
        .into_iter()
        .filter(|d| d.as_str() >= first.as_str())
        .map(|day| {
            if let Some(hit) = by_date.get(&day) {
                json!({
                    "date": day,
                    "value": hit.value,
                    "repos": hit.repos.clone()
                })
            } else {
                json!({ "date": day, "value": 0, "repos": [] })
            }
        })
        .collect()
}

fn repo_field_deltas(prev: &Snapshot, cur: &Snapshot, field: &str) -> Vec<Value> {
    let mut prev_map = std::collections::HashMap::new();
    for r in &prev.repos {
        prev_map.insert(
            r.name.clone(),
            if field == "stars" { r.stars } else { r.downloads },
        );
    }
    let mut cur_map = std::collections::HashMap::new();
    for r in &cur.repos {
        cur_map.insert(
            r.name.clone(),
            if field == "stars" { r.stars } else { r.downloads },
        );
    }
    let mut names: std::collections::HashSet<_> = prev_map.keys().cloned().collect();
    names.extend(cur_map.keys().cloned());
    let mut changes: Vec<(String, i64)> = names
        .into_iter()
        .filter_map(|name| {
            let a = prev_map.get(&name).copied().unwrap_or(0) as i64;
            let b = cur_map.get(&name).copied().unwrap_or(0) as i64;
            let delta = b - a;
            if delta != 0 {
                Some((name, delta))
            } else {
                None
            }
        })
        .collect();
    changes.sort_by(|a, b| b.1.abs().cmp(&a.1.abs()));
    changes
        .into_iter()
        .map(|(name, delta)| json!({ "name": name, "delta": delta }))
        .collect()
}

fn merge_star_histories(histories: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = Map::new();
    for hist in histories.values() {
        if let Some(daily) = hist.get("daily").and_then(|d| d.as_object()) {
            for (day, count) in daily {
                let n = merged.get(day).and_then(|v| v.as_u64()).unwrap_or(0)
                    + count.as_u64().unwrap_or(0);
                merged.insert(day.clone(), json!(n));
            }
        }
    }
    merged
}

fn snapshot_field_points(snapshots: &[Snapshot], field: &str, start: &str, end: &str) -> Vec<(String, u64)> {
    snapshots
        .iter()
        .filter(|s| s.date.as_str() >= start && s.date.as_str() <= end)
        .map(|s| {
            let value = match field {
                "stars" => s.totals.stars,
                _ => s.totals.downloads,
            };
            (s.date.clone(), value)
        })
        .collect()
}

fn snapshot_delta_points(snapshots: &[Snapshot], field: &str, start: &str, end: &str) -> Vec<DailyPoint> {
    let in_range: Vec<_> = snapshots
        .iter()
        .filter(|s| s.date.as_str() >= start && s.date.as_str() <= end)
        .collect();
    if in_range.is_empty() {
        return vec![];
    }
    let before_range: Vec<_> = snapshots
        .iter()
        .filter(|s| s.date.as_str() < start)
        .cloned()
        .collect();
    let before = find_snapshot_on_or_before(&before_range, start);
    let mut out = Vec::new();
    for (i, cur) in in_range.iter().enumerate() {
        let prev = if i == 0 {
            before
        } else {
            Some(in_range[i - 1])
        };
        let prev_total = prev
            .map(|p| if field == "stars" { p.totals.stars } else { p.totals.downloads })
            .unwrap_or(if i == 0 && before.is_none() {
                if field == "stars" {
                    cur.totals.stars
                } else {
                    cur.totals.downloads
                }
            } else {
                0
            });
        let cur_total = if field == "stars" {
            cur.totals.stars
        } else {
            cur.totals.downloads
        };
        let no_baseline = i == 0 && before.is_none();
        let delta = if no_baseline {
            0
        } else {
            cur_total.saturating_sub(prev_total)
        };
        let repos = if no_baseline {
            vec![]
        } else if let Some(p) = prev {
            repo_field_deltas(p, cur, field)
                .into_iter()
                .filter(|r| r.get("delta").and_then(|d| d.as_i64()).unwrap_or(0) > 0)
                .collect()
        } else {
            vec![]
        };
        out.push(DailyPoint {
            date: cur.date.clone(),
            value: delta,
            repos,
        });
    }
    out
}

fn star_history_daily_points(
    histories: &Map<String, Value>,
    start: &str,
    end: &str,
) -> Vec<DailyPoint> {
    let mut by_day: std::collections::BTreeMap<String, (u64, std::collections::HashMap<String, u64>)> =
        std::collections::BTreeMap::new();
    for (repo, hist) in histories {
        if let Some(daily) = hist.get("daily").and_then(|d| d.as_object()) {
            for (day, count) in daily {
                if day.as_str() >= start && day.as_str() <= end {
                    let n = count.as_u64().unwrap_or(0);
                    let entry = by_day.entry(day.clone()).or_insert_with(|| (0, std::collections::HashMap::new()));
                    entry.0 += n;
                    *entry.1.entry(repo.clone()).or_insert(0) += n;
                }
            }
        }
    }
    by_day
        .into_iter()
        .map(|(date, (value, repos_map))| {
            let mut repos: Vec<(String, u64)> = repos_map.into_iter().collect();
            repos.sort_by(|a, b| b.1.cmp(&a.1));
            DailyPoint {
                date,
                value,
                repos: repos
                    .into_iter()
                    .map(|(name, delta)| json!({ "name": name, "delta": delta }))
                    .collect(),
            }
        })
        .collect()
}

fn health_payload(health: Option<&HealthSnapshot>) -> Value {
    match health {
        Some(h) if h.fetched_at > 0 => json!({
            "fetchedAt": h.fetched_at,
            "issueCount": h.issues.len(),
            "issues": h.issues,
            "builds": h.builds,
            "releases": h.releases,
        }),
        _ => json!({
            "fetchedAt": null,
            "issueCount": 0,
            "issues": [],
            "builds": [],
            "releases": [],
        }),
    }
}

pub fn build_dashboard(
    snapshots: &[Snapshot],
    star_histories: &Map<String, Value>,
    range_days: Value,
    health: Option<&HealthSnapshot>,
    traffic: &[TrafficSnapshot],
) -> Value {
    let today = date_key();
    let mut sorted = snapshots.to_vec();
    sorted.sort_by(|a, b| a.date.cmp(&b.date));

    let start_date = if range_days.as_str() == Some("all") {
        sorted
            .first()
            .map(|s| s.date.clone())
            .unwrap_or_else(|| days_ago(90))
    } else {
        let n = range_days.as_u64().unwrap_or(30);
        let n = if n == 7 {
            7
        } else if n == 90 {
            90
        } else {
            30
        };
        days_ago(n)
    };

    let latest = sorted.last().cloned();
    let current_stars = latest.as_ref().map(|s| s.totals.stars).unwrap_or(0);
    let current_downloads = latest.as_ref().map(|s| s.totals.downloads).unwrap_or(0);
    let current_repos = latest.as_ref().map(|s| s.repos.clone()).unwrap_or_default();

    let merged = merge_star_histories(star_histories);
    let has_star_history = !merged.is_empty();

    let before_today_snaps: Vec<_> = sorted
        .iter()
        .filter(|s| s.date.as_str() < today.as_str())
        .cloned()
        .collect();
    let before_today = find_snapshot_on_or_before(&before_today_snaps, &days_ago(1));
    let before_7d = find_snapshot_on_or_before(&sorted, &days_ago(7));
    let before_30d = find_snapshot_on_or_before(&sorted, &days_ago(30));

    let metric = |cur: u64, past: Option<u64>| -> u64 {
        past.map(|p| cur.saturating_sub(p)).unwrap_or(0)
    };

    let total_npm: u64 = current_repos.iter().filter_map(|r| r.npm_downloads).sum();
    let total_pypi: u64 = current_repos.iter().filter_map(|r| r.pypi_downloads).sum();
    let total_crates: u64 = current_repos.iter().filter_map(|r| r.crate_downloads).sum();

    let traffic_agg = aggregate_traffic_series(traffic, &start_date, &today);
    let traffic_daily = traffic_agg.get("daily").cloned().unwrap_or(json!([]));
    let traffic_views_14d: u64 = traffic_daily
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|d| d.get("views").and_then(|v| v.as_u64()))
                .sum()
        })
        .unwrap_or(0);
    let traffic_clones_14d: u64 = traffic_daily
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|d| d.get("clones").and_then(|v| v.as_u64()))
                .sum()
        })
        .unwrap_or(0);

    let metrics = json!({
        "totalStars": current_stars,
        "totalDownloads": current_downloads,
        "starsToday": if has_star_history {
            sum_daily_map(&merged, &today, &today)
        } else {
            metric(current_stars, before_today.map(|s| s.totals.stars))
        },
        "stars7d": if has_star_history {
            sum_daily_map(&merged, &days_ago(7), &today)
        } else {
            metric(current_stars, before_7d.map(|s| s.totals.stars))
        },
        "stars30d": if has_star_history {
            sum_daily_map(&merged, &days_ago(30), &today)
        } else {
            metric(current_stars, before_30d.map(|s| s.totals.stars))
        },
        "downloadsToday": metric(current_downloads, before_today.map(|s| s.totals.downloads)),
        "downloads7d": metric(current_downloads, before_7d.map(|s| s.totals.downloads)),
        "downloads30d": metric(current_downloads, before_30d.map(|s| s.totals.downloads)),
        "npmDownloads": total_npm,
        "pypiDownloads": total_pypi,
        "crateDownloads": total_crates,
        "views14d": traffic_views_14d,
        "clones14d": traffic_clones_14d,
    });

    let (star_daily, star_cum) = if has_star_history {
        let daily = fill_daily_zeros(
            &star_history_daily_points(star_histories, &start_date, &today),
            &start_date,
            &today,
        );
        let mut running = 0u64;
        for (day, count) in &merged {
            if day.as_str() < start_date.as_str() {
                running += count.as_u64().unwrap_or(0);
            }
        }
        let mut points = Vec::new();
        let mut days: Vec<_> = merged.keys().filter(|d| d.as_str() >= start_date.as_str() && d.as_str() <= today.as_str()).cloned().collect();
        days.sort();
        for day in days {
            running += merged.get(&day).and_then(|v| v.as_u64()).unwrap_or(0);
            points.push((day, running));
        }
        if points.is_empty() && current_stars > 0 {
            (
                daily,
                fill_carry_forward(&[(today.clone(), current_stars)], &start_date, &today),
            )
        } else {
            (daily, fill_carry_forward(&points, &start_date, &today))
        }
    } else {
        let mut star_points = snapshot_field_points(&sorted, "stars", &start_date, &today);
        if star_points.is_empty() {
            if let Some(l) = &latest {
                star_points.push((l.date.clone(), current_stars));
            }
        }
        (
            fill_daily_zeros(
                &snapshot_delta_points(&sorted, "stars", &start_date, &today),
                &start_date,
                &today,
            ),
            fill_carry_forward(&star_points, &start_date, &today),
        )
    };

    let mut download_points = snapshot_field_points(&sorted, "downloads", &start_date, &today);
    if download_points.is_empty() {
        if let Some(l) = &latest {
            download_points.push((l.date.clone(), current_downloads));
        }
    }

    let repos: Vec<Value> = current_repos
        .iter()
        .map(|r| {
            let hist_daily = star_histories
                .get(&r.name)
                .and_then(|h| h.get("daily"))
                .and_then(|d| d.as_object())
                .cloned()
                .unwrap_or_default();
            json!({
                "name": r.name,
                "stars": r.stars,
                "downloads": r.downloads,
                "npmDownloads": r.npm_downloads,
                "pypiDownloads": r.pypi_downloads,
                "crateDownloads": r.crate_downloads,
                "stars7d": if has_star_history { sum_daily_map(&hist_daily, &days_ago(7), &today) } else { 0 },
                "stars30d": if has_star_history { sum_daily_map(&hist_daily, &days_ago(30), &today) } else { 0 },
            })
        })
        .collect();

    json!({
        "metrics": metrics,
        "series": {
            "starsDaily": star_daily,
            "starsCumulative": star_cum,
            "downloadsTotal": fill_carry_forward(&download_points, &start_date, &today),
            "downloadsDaily": fill_daily_zeros(
                &snapshot_delta_points(&sorted, "downloads", &start_date, &today),
                &start_date,
                &today
            ),
            "traffic": traffic_agg,
        },
        "repos": repos,
        "health": health_payload(health),
        "meta": {
            "snapshotCount": sorted.len(),
            "hasStarHistory": has_star_history,
            "hasTraffic": !traffic.is_empty(),
            "rangeStart": start_date,
            "rangeEnd": today,
            "lastSnapshotAt": latest.map(|s| s.timestamp)
        }
    })
}
