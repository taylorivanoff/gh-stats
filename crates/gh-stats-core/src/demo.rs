use std::path::Path;

use chrono::{Duration, Utc};

use crate::collector::{date_key, save_health, save_star_history, StarHistory, Totals};
use crate::collector::{RepoTotals, empty_health, HealthSnapshot};
use crate::store::{save_snapshot, Snapshot};

const DEMO_REPOS: &[(&str, u64, u64)] = &[
    ("demo-user/awesome-cli", 1240, 8500),
    ("demo-user/dev-dashboard", 890, 4200),
    ("demo-user/rust-tools", 456, 12000),
    ("demo-user/js-utils", 2100, 15600),
    ("demo-user/python-kit", 678, 3100),
];

#[derive(Debug)]
pub struct DemoSeedResult {
    pub snapshots: usize,
    pub star_histories: usize,
}

pub fn seed_demo_data(user_data: &Path) -> Result<DemoSeedResult, String> {
    let _ = std::fs::create_dir_all(user_data);
    let today = Utc::now();
    let mut snapshot_count = 0usize;

    for day_offset in (0..30).rev() {
        let date = (today - Duration::days(day_offset))
            .format("%Y-%m-%d")
            .to_string();
        let progress = (30 - day_offset) as f64 / 30.0;

        let repos: Vec<RepoTotals> = DEMO_REPOS
            .iter()
            .map(|(name, base_stars, base_downloads)| {
                let growth = (progress * 100.0) as u64;
                RepoTotals {
                    name: (*name).into(),
                    stars: base_stars + growth,
                    downloads: base_downloads + growth * 10,
                    npm_downloads: Some(base_downloads / 2 + growth * 5),
                    pypi_downloads: Some(base_downloads / 4 + growth * 2),
                    crate_downloads: None,
                }
            })
            .collect();

        let totals = Totals {
            stars: repos.iter().map(|r| r.stars).sum(),
            downloads: repos.iter().map(|r| r.downloads).sum(),
        };

        let snapshot = Snapshot {
            timestamp: (today - Duration::days(day_offset))
                .timestamp_millis(),
            date: date.clone(),
            repos: repos.clone(),
            totals,
        };

        let file = crate::store::snapshots_dir(user_data).join(format!("{date}.json"));
        let text = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
        std::fs::write(file, text).map_err(|e| e.to_string())?;
        snapshot_count += 1;
    }

    let mut star_count = 0usize;
    for (name, base_stars, _) in DEMO_REPOS {
        let mut daily = serde_json::Map::new();
        for day_offset in (0..30).rev() {
            let date = (today - Duration::days(day_offset))
                .format("%Y-%m-%d")
                .to_string();
            let stars_today = (*base_stars as f64 / 30.0).max(1.0) as u64;
            daily.insert(date, serde_json::json!(stars_today));
        }
        let hist = StarHistory {
            repo: (*name).into(),
            fetched_at: Utc::now().timestamp_millis(),
            daily,
            total_stars: *base_stars + 100,
        };
        save_star_history(user_data, &hist)?;
        star_count += 1;
    }

    let health = HealthSnapshot {
        fetched_at: Utc::now().timestamp_millis(),
        repos: vec![],
        issues: vec![serde_json::json!({
            "repo": "demo-user/dev-dashboard",
            "kind": "ci_failed",
            "severity": "error",
            "message": "Demo: CI build failed (sample data)",
        })],
        builds: vec![],
        releases: vec![],
    };
    let _ = save_health(user_data, &health);

    let _ = save_snapshot(
        user_data,
        DEMO_REPOS
            .iter()
            .map(|(name, stars, downloads)| RepoTotals {
                name: (*name).into(),
                stars: *stars + 100,
                downloads: *downloads + 1000,
                npm_downloads: Some(*downloads / 2),
                pypi_downloads: Some(*downloads / 4),
                crate_downloads: None,
            })
            .collect(),
        Totals {
            stars: DEMO_REPOS.iter().map(|(_, s, _)| s + 100).sum(),
            downloads: DEMO_REPOS.iter().map(|(_, _, d)| d + 1000).sum(),
        },
    );

    let _ = date_key();
    Ok(DemoSeedResult {
        snapshots: snapshot_count,
        star_histories: star_count,
    })
}

pub fn clear_demo_data(user_data: &Path) -> Result<(), String> {
    for sub in ["snapshots", "star-history", "traffic"] {
        let dir = user_data.join(sub);
        if dir.is_dir() {
            for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let health = user_data.join("health-latest.json");
    if health.is_file() {
        let _ = std::fs::remove_file(health);
    }
    Ok(())
}

pub fn purge_demo_files(user_data: &Path) -> Result<(), String> {
    let snap_dir = crate::store::snapshots_dir(user_data);
    if snap_dir.is_dir() {
        for entry in std::fs::read_dir(&snap_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().map(|x| x == "json").unwrap_or(false) {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    if let Ok(s) = serde_json::from_str::<Snapshot>(&text) {
                        if s.repos.iter().any(|r| r.name.starts_with("demo-user/")) {
                            let _ = std::fs::remove_file(&path);
                        }
                    }
                }
            }
        }
    }
    let star_dir = user_data.join("star-history");
    if star_dir.is_dir() {
        for entry in std::fs::read_dir(&star_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("demo-user--") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

pub fn is_demo_snapshot(snapshots: &[Snapshot]) -> bool {
    snapshots
        .last()
        .and_then(|s| s.repos.first())
        .map(|r| r.name.starts_with("demo-user/"))
        .unwrap_or(false)
}

#[allow(dead_code)]
fn _empty() {
    let _ = empty_health();
}
