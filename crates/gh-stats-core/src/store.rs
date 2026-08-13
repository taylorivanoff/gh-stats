use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::collector::{RepoTotals, Totals};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub timestamp: i64,
    pub date: String,
    pub repos: Vec<RepoTotals>,
    pub totals: Totals,
}

pub fn snapshots_dir(user_data: &Path) -> PathBuf {
    let dir = user_data.join("snapshots");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn load_all_snapshots(user_data: &Path) -> Vec<Snapshot> {
    let dir = snapshots_dir(user_data);
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .map(|e| e.path())
        .collect();
    files.sort();
    let mut out = Vec::new();
    for f in files {
        if let Ok(text) = std::fs::read_to_string(&f) {
            if let Ok(s) = serde_json::from_str::<Snapshot>(&text) {
                out.push(s);
            }
        }
    }
    out.sort_by_key(|s| s.timestamp);
    out
}

pub fn save_snapshot(
    user_data: &Path,
    repos: Vec<RepoTotals>,
    totals: Totals,
) -> Result<Snapshot, String> {
    let snapshot = Snapshot {
        timestamp: chrono::Utc::now().timestamp_millis(),
        date: crate::collector::date_key(),
        repos,
        totals,
    };
    let file = snapshots_dir(user_data).join(format!("{}.json", snapshot.date));
    let text = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
    std::fs::write(file, text).map_err(|e| e.to_string())?;
    Ok(snapshot)
}

pub fn import_snapshots_dir(user_data: &Path, source: &Path) -> Result<usize, String> {
    if !source.is_dir() {
        return Ok(0);
    }
    let dest = snapshots_dir(user_data);
    let mut count = 0usize;
    for entry in std::fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().map(|x| x == "json").unwrap_or(false) {
            let name = path.file_name().ok_or("invalid snapshot name")?;
            std::fs::copy(&path, dest.join(name)).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    Ok(count)
}

pub fn sync_from_dot_gh_stats(user_data: &Path) -> Result<usize, String> {
    let dot = PathBuf::from(".gh-stats");
    if !dot.is_dir() {
        return Ok(0);
    }
    let mut count = import_snapshots_dir(user_data, &dot.join("snapshots"))?;
    let star_src = dot.join("star-history");
    if star_src.is_dir() {
        let star_dest = user_data.join("star-history");
        let _ = std::fs::create_dir_all(&star_dest);
        for entry in std::fs::read_dir(&star_src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().map(|x| x == "json").unwrap_or(false) {
                if let Some(name) = path.file_name() {
                    std::fs::copy(&path, star_dest.join(name)).map_err(|e| e.to_string())?;
                    count += 1;
                }
            }
        }
    }
    let traffic_src = dot.join("traffic");
    if traffic_src.is_dir() {
        let traffic_dest = user_data.join("traffic");
        let _ = std::fs::create_dir_all(&traffic_dest);
        for entry in std::fs::read_dir(&traffic_src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().map(|x| x == "json").unwrap_or(false) {
                if let Some(name) = path.file_name() {
                    std::fs::copy(&path, traffic_dest.join(name)).map_err(|e| e.to_string())?;
                    count += 1;
                }
            }
        }
    }
    Ok(count)
}
