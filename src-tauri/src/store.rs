use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri_tray_base::{save_settings, TrayBaseState};

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
    state: &TrayBaseState,
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

    {
        let mut settings = state.settings.lock();
        settings
            .extra
            .insert("lastFetchAt".into(), json!(snapshot.timestamp));
        let _ = save_settings(&state.settings_path, &settings);
    }

    Ok(snapshot)
}

pub fn record_timing(state: &TrayBaseState, kind: &str, ms: u64, meta: Value) {
    let mut settings = state.settings.lock();
    let list = settings
        .extra
        .entry("timings")
        .or_insert_with(|| json!([]));
    if let Some(arr) = list.as_array_mut() {
        let mut entry = json!({
            "kind": kind,
            "ms": ms,
            "at": chrono::Utc::now().timestamp_millis()
        });
        if let Some(obj) = meta.as_object() {
            if let Some(e) = entry.as_object_mut() {
                for (k, v) in obj {
                    e.insert(k.clone(), v.clone());
                }
            }
        }
        arr.push(entry);
        while arr.len() > 50 {
            arr.remove(0);
        }
    }
    let _ = save_settings(&state.settings_path, &settings);
}

pub fn timing_stats(state: &TrayBaseState) -> Value {
    let settings = state.settings.lock();
    let list = settings
        .extra
        .get("timings")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    fn avg(items: &[&Value]) -> Value {
        if items.is_empty() {
            return Value::Null;
        }
        let sum: f64 = items.iter().filter_map(|t| t.get("ms")?.as_f64()).sum();
        json!((sum / items.len() as f64).round() as u64)
    }

    let auth: Vec<_> = list
        .iter()
        .filter(|t| t.get("kind").and_then(|k| k.as_str()) == Some("auth"))
        .collect();
    let fetch: Vec<_> = list
        .iter()
        .filter(|t| t.get("kind").and_then(|k| k.as_str()) == Some("fetch"))
        .collect();
    let history: Vec<_> = list
        .iter()
        .filter(|t| t.get("kind").and_then(|k| k.as_str()) == Some("history"))
        .collect();

    json!({
        "authAvgMs": avg(&auth),
        "fetchAvgMs": avg(&fetch),
        "historyAvgMs": avg(&history),
        "authCount": auth.len(),
        "fetchCount": fetch.len(),
        "historyCount": history.len(),
        "lastAuth": auth.last().cloned(),
        "lastFetch": fetch.last().cloned(),
        "lastHistory": history.last().cloned()
    })
}
