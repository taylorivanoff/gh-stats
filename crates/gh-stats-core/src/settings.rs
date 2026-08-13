use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_auto_fetch_hours")]
    pub auto_fetch_hours: u64,
    #[serde(default)]
    pub star_history_loaded: bool,
    #[serde(default)]
    pub show_debug_bar: bool,
    #[serde(default = "default_layout")]
    pub layout: Value,
    #[serde(default = "default_active_view")]
    pub active_view: String,
    #[serde(default)]
    pub timings: Vec<TimingEntry>,
    #[serde(default)]
    pub last_fetch_at: Option<i64>,
    #[serde(default = "default_repo_visibility")]
    pub repo_visibility: String,
    #[serde(default)]
    pub onboarding_complete: bool,
    #[serde(default)]
    pub demo_mode: bool,
    #[serde(default)]
    pub auto_star_history: bool,
}

fn default_auto_fetch_hours() -> u64 {
    24
}

fn default_layout() -> Value {
    json!({ "tableH": 140 })
}

fn default_active_view() -> String {
    "analytics".into()
}

fn default_repo_visibility() -> String {
    "public".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingEntry {
    pub kind: String,
    pub ms: u64,
    pub at: i64,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, Value>,
}

pub fn settings_path(user_data: &Path) -> PathBuf {
    user_data.join("gh-stats-settings.json")
}

pub fn load_settings(user_data: &Path) -> AppSettings {
    let path = settings_path(user_data);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(s) = serde_json::from_str(&text) {
            return s;
        }
    }
    AppSettings::default()
}

pub fn save_settings(user_data: &Path, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(user_data);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

pub fn record_timing(user_data: &Path, kind: &str, ms: u64, meta: Value) -> Result<(), String> {
    let mut settings = load_settings(user_data);
    let mut extra = std::collections::HashMap::new();
    if let Some(obj) = meta.as_object() {
        for (k, v) in obj {
            extra.insert(k.clone(), v.clone());
        }
    }
    settings.timings.push(TimingEntry {
        kind: kind.into(),
        ms,
        at: chrono::Utc::now().timestamp_millis(),
        extra,
    });
    while settings.timings.len() > 50 {
        settings.timings.remove(0);
    }
    save_settings(user_data, &settings)
}

pub fn timing_stats(user_data: &Path) -> Value {
    let settings = load_settings(user_data);
    let list = &settings.timings;

    fn avg(items: &[&TimingEntry]) -> Value {
        if items.is_empty() {
            return Value::Null;
        }
        let sum: f64 = items.iter().map(|t| t.ms as f64).sum();
        json!((sum / items.len() as f64).round() as u64)
    }

    let auth: Vec<&TimingEntry> = list.iter().filter(|t| t.kind == "auth").collect();
    let fetch: Vec<&TimingEntry> = list.iter().filter(|t| t.kind == "fetch").collect();
    let history: Vec<&TimingEntry> = list.iter().filter(|t| t.kind == "history").collect();
    let traffic: Vec<&TimingEntry> = list.iter().filter(|t| t.kind == "traffic").collect();

    json!({
        "authAvgMs": avg(&auth),
        "fetchAvgMs": avg(&fetch),
        "historyAvgMs": avg(&history),
        "trafficAvgMs": avg(&traffic),
        "authCount": auth.len(),
        "fetchCount": fetch.len(),
        "historyCount": history.len(),
        "trafficCount": traffic.len(),
        "lastAuth": auth.last().map(|t| json!({"kind": t.kind, "ms": t.ms, "at": t.at})),
        "lastFetch": fetch.last().map(|t| json!({"kind": t.kind, "ms": t.ms, "at": t.at})),
        "lastHistory": history.last().map(|t| json!({"kind": t.kind, "ms": t.ms, "at": t.at})),
        "lastTraffic": traffic.last().map(|t| json!({"kind": t.kind, "ms": t.ms, "at": t.at})),
    })
}

pub fn update_last_fetch(user_data: &Path, timestamp: i64) -> Result<(), String> {
    let mut settings = load_settings(user_data);
    settings.last_fetch_at = Some(timestamp);
    save_settings(user_data, &settings)
}

pub fn needs_auto_fetch(user_data: &Path) -> bool {
    let settings = load_settings(user_data);
    match settings.last_fetch_at {
        None => true,
        Some(ts) => {
            let now = chrono::Utc::now().timestamp_millis();
            now - ts > (settings.auto_fetch_hours as i64) * 60 * 60 * 1000
        }
    }
}
