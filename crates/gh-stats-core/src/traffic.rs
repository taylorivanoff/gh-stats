use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferrerEntry {
    pub referrer: String,
    pub count: u64,
    pub uniques: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathEntry {
    pub path: String,
    pub count: u64,
    pub uniques: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSnapshot {
    pub repo: String,
    pub date: String,
    pub timestamp: i64,
    pub views: u64,
    pub unique_views: u64,
    pub clones: u64,
    pub unique_clones: u64,
    pub referrers: Vec<ReferrerEntry>,
    pub paths: Vec<PathEntry>,
}

pub fn traffic_dir(user_data: &Path) -> PathBuf {
    let dir = user_data.join("traffic");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn safe_repo_file(repo: &str) -> String {
    repo.replace(['/', '\\'], "--")
}

pub fn traffic_file(user_data: &Path, repo: &str, date: &str) -> PathBuf {
    traffic_dir(user_data).join(format!("{}--{}.json", safe_repo_file(repo), date))
}

pub fn save_traffic_snapshot(user_data: &Path, snapshot: &TrafficSnapshot) -> Result<(), String> {
    let file = traffic_file(user_data, &snapshot.repo, &snapshot.date);
    let text = serde_json::to_string_pretty(snapshot).map_err(|e| e.to_string())?;
    std::fs::write(file, text).map_err(|e| e.to_string())
}

pub fn load_traffic_for_repo(user_data: &Path, repo: &str) -> Vec<TrafficSnapshot> {
    let dir = traffic_dir(user_data);
    let prefix = format!("{}--", safe_repo_file(repo));
    let mut out: Vec<TrafficSnapshot> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && name.ends_with(".json") {
                if let Ok(text) = std::fs::read_to_string(entry.path()) {
                    if let Ok(s) = serde_json::from_str::<TrafficSnapshot>(&text) {
                        out.push(s);
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.date.cmp(&b.date));
    out
}

pub fn load_all_traffic(user_data: &Path) -> Vec<TrafficSnapshot> {
    let dir = traffic_dir(user_data);
    let mut out: Vec<TrafficSnapshot> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                if let Ok(text) = std::fs::read_to_string(entry.path()) {
                    if let Ok(s) = serde_json::from_str::<TrafficSnapshot>(&text) {
                        out.push(s);
                    }
                }
            }
        }
    }
    out.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.repo.cmp(&b.repo)));
    out
}

pub fn aggregate_traffic_series(snapshots: &[TrafficSnapshot], start: &str, end: &str) -> Value {
    use serde_json::json;
    use std::collections::BTreeMap;

    let mut by_day: BTreeMap<String, (u64, u64, u64, u64)> = BTreeMap::new();
    for s in snapshots {
        if s.date.as_str() >= start && s.date.as_str() <= end {
            let e = by_day.entry(s.date.clone()).or_insert((0, 0, 0, 0));
            e.0 += s.views;
            e.1 += s.unique_views;
            e.2 += s.clones;
            e.3 += s.unique_clones;
        }
    }
    let daily: Vec<Value> = by_day
        .into_iter()
        .map(|(date, (views, unique_views, clones, unique_clones))| {
            json!({
                "date": date,
                "views": views,
                "uniqueViews": unique_views,
                "clones": clones,
                "uniqueClones": unique_clones,
            })
        })
        .collect();

    let mut referrer_map: std::collections::HashMap<String, (u64, u64)> =
        std::collections::HashMap::new();
    for s in snapshots {
        if s.date.as_str() >= start && s.date.as_str() <= end {
            for r in &s.referrers {
                let e = referrer_map
                    .entry(r.referrer.clone())
                    .or_insert((0, 0));
                e.0 += r.count;
                e.1 += r.uniques;
            }
        }
    }
    let mut referrers: Vec<(String, u64, u64)> = referrer_map
        .into_iter()
        .map(|(k, (c, u))| (k, c, u))
        .collect();
    referrers.sort_by(|a, b| b.1.cmp(&a.1));
    referrers.truncate(20);

    json!({
        "daily": daily,
        "referrers": referrers.iter().map(|(r, c, u)| json!({
            "referrer": r,
            "count": c,
            "uniques": u,
        })).collect::<Vec<_>>(),
    })
}
