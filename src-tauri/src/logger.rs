use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Serialize)]
pub struct LogEntry {
    pub id: String,
    pub time: String,
    pub ts: i64,
    pub level: String,
    pub message: String,
    pub meta: Value,
}

pub struct Logger {
    entries: Mutex<Vec<LogEntry>>,
    seq: Mutex<u64>,
    file: Mutex<Option<PathBuf>>,
}

impl Logger {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            seq: Mutex::new(0),
            file: Mutex::new(None),
        }
    }

    pub fn set_file(&self, path: PathBuf) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        *self.file.lock().unwrap() = Some(path);
    }

    pub fn log_path(&self) -> Option<PathBuf> {
        self.file.lock().unwrap().clone()
    }

    pub fn log(&self, level: &str, message: &str, meta: Value) -> LogEntry {
        let mut seq = self.seq.lock().unwrap();
        *seq += 1;
        let entry = LogEntry {
            id: format!("log-{}-{}", chrono::Utc::now().timestamp_millis(), *seq),
            time: chrono::Utc::now().to_rfc3339(),
            ts: chrono::Utc::now().timestamp_millis(),
            level: level.into(),
            message: message.into(),
            meta,
        };
        {
            let mut entries = self.entries.lock().unwrap();
            entries.push(entry.clone());
            while entries.len() > 400 {
                entries.remove(0);
            }
        }
        let meta_text = if entry.meta.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
            format!(" {}", entry.meta)
        } else {
            String::new()
        };
        let line = format!(
            "[{}] [{}] {}{}",
            entry.time, entry.level, entry.message, meta_text
        );
        match level {
            "error" => eprintln!("{line}"),
            "warn" => eprintln!("{line}"),
            _ => println!("{line}"),
        }
        if let Some(path) = self.file.lock().unwrap().as_ref() {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                let _ = writeln!(f, "{line}");
            }
        }
        entry
    }

    pub fn info(&self, message: &str, meta: Value) {
        let _ = self.log("info", message, meta);
    }

    pub fn error(&self, message: &str, meta: Value) {
        let _ = self.log("error", message, meta);
    }

    pub fn debug(&self, message: &str, meta: Value) {
        let _ = self.log("debug", message, meta);
    }

    pub fn get_logs(&self, limit: usize) -> Vec<LogEntry> {
        let entries = self.entries.lock().unwrap();
        let start = entries.len().saturating_sub(limit);
        entries[start..].to_vec()
    }
}

#[allow(dead_code)]
pub type SharedLogger = Arc<Logger>;

#[allow(dead_code)]
fn _map() -> BTreeMap<String, String> {
    BTreeMap::new()
}
