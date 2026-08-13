use std::path::Path;
use std::sync::atomic::Ordering;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_tray_base::{emit_to_renderer, TrayBaseState};

use crate::analytics::build_dashboard;
use crate::collector::{self, load_all_star_histories};
use crate::store::{self, Snapshot};
use crate::AppRuntime;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FetchOptions {
    pub include_star_history: Option<bool>,
}

fn user_data(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| ".".into())
}

fn maybe_auto_fetch(app: &AppHandle) {
    let runtime = app.state::<AppRuntime>();
    if !runtime.renderer_ready.load(Ordering::SeqCst)
        || !runtime.pending_auto_fetch.load(Ordering::SeqCst)
        || runtime.fetch_in_progress.load(Ordering::SeqCst)
    {
        return;
    }
    runtime
        .pending_auto_fetch
        .store(false, Ordering::SeqCst);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let _ = run_fetch_blocking(&app2, false);
    });
}

pub fn run_fetch_blocking(app: &AppHandle, include_star_history: bool) -> Value {
    let runtime = app.state::<AppRuntime>();
    if runtime
        .fetch_in_progress
        .swap(true, Ordering::SeqCst)
    {
        return json!({ "ok": false, "error": "Fetch already in progress" });
    }

    let started = chrono::Utc::now().timestamp_millis();
    let log = runtime.log.clone();
    let tray_state = app.state::<TrayBaseState>();
    let data = user_data(app);

    let emit = |event: &str, payload: Value| {
        emit_to_renderer(app, event, payload);
    };

    emit(
        "fetch:progress",
        json!({ "phase": "auth", "message": "Checking gh authentication…", "startedAt": started }),
    );

    let result = (|| -> Result<Value, String> {
        let (ok, user, err, auth_ms) = collector::check_auth();
        store::record_timing(&tray_state, "auth", auth_ms, json!({}));
        emit(
            "fetch:progress",
            json!({
                "phase": "auth-done",
                "message": if ok { format!("Authenticated as {}", user.clone().unwrap_or_default()) } else { err.clone().unwrap_or_default() },
                "ms": auth_ms
            }),
        );
        if !ok {
            emit(
                "fetch:progress",
                json!({ "phase": "error", "message": err.clone().unwrap_or_default() }),
            );
            return Ok(json!({
                "ok": false,
                "error": if collector::find_gh().is_none() {
                    "gh not installed. Use Install gh, then Sign in."
                } else {
                    "gh not authenticated. Use Sign in, or run: gh auth login"
                },
                "ms": chrono::Utc::now().timestamp_millis() - started
            }));
        }

        emit(
            "fetch:progress",
            json!({
                "phase": "repos",
                "message": format!("Listing repos for {}…", user.unwrap_or_default()),
                "startedAt": started
            }),
        );

        let totals = collector::fetch_current_totals(|p| {
            emit(
                "fetch:progress",
                json!({
                    "phase": p.get("phase").cloned().unwrap_or(json!("releases")),
                    "message": format!(
                        "Releases & builds: {} ({}/{})",
                        p.get("repo").and_then(|v| v.as_str()).unwrap_or(""),
                        p.get("current").and_then(|v| v.as_u64()).unwrap_or(0),
                        p.get("total").and_then(|v| v.as_u64()).unwrap_or(0)
                    ),
                    "current": p.get("current"),
                    "total": p.get("total"),
                    "startedAt": started
                }),
            );
        })?;

        let snapshot = store::save_snapshot(
            &data,
            &tray_state,
            totals.repos.clone(),
            totals.totals.clone(),
        )?;
        let _ = collector::save_health(&data, &totals.health);

        if include_star_history {
            emit(
                "fetch:progress",
                json!({
                    "phase": "stars",
                    "message": "Fetching star history (rate-limit aware, may take a while)…",
                    "startedAt": started
                }),
            );
            for (i, repo) in totals.repos.iter().enumerate() {
                let hist = collector::fetch_star_history(&repo.name, |p| {
                    emit(
                        "fetch:progress",
                        json!({
                            "phase": "stars",
                            "message": format!(
                                "Star history: {} (page {}, {} stars)",
                                repo.name,
                                p.get("page").and_then(|v| v.as_u64()).unwrap_or(0),
                                p.get("fetched").and_then(|v| v.as_u64()).unwrap_or(0)
                            ),
                            "repo": repo.name,
                            "current": i + 1,
                            "total": totals.repos.len(),
                            "startedAt": started
                        }),
                    );
                })?;
                collector::save_star_history(&data, &hist)?;
                if i + 1 < totals.repos.len() {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
            {
                let mut settings = tray_state.settings.lock();
                settings
                    .extra
                    .insert("starHistoryLoaded".into(), json!(true));
                let _ = tauri_tray_base::save_settings(&tray_state.settings_path, &settings);
            }
        }

        let ms = (chrono::Utc::now().timestamp_millis() - started) as u64;
        let kind = if include_star_history {
            "history"
        } else {
            "fetch"
        };
        store::record_timing(
            &tray_state,
            kind,
            ms,
            json!({ "repos": totals.repos.len() }),
        );
        let timing = store::timing_stats(&tray_state);

        emit(
            "fetch:done",
            json!({ "snapshot": snapshot, "ms": ms, "kind": kind, "timing": timing }),
        );

        let snaps = store::load_all_snapshots(&data);
        let names: Vec<String> = totals.repos.iter().map(|r| r.name.clone()).collect();
        let histories = load_all_star_histories(&data, &names);
        let health = collector::load_health(&data).unwrap_or_else(collector::empty_health);
        let dashboard = build_dashboard(&snaps, &histories, json!(30), Some(&health));
        emit("dashboard:updated", dashboard);

        log.info(
            "runFetch done",
            json!({ "stars": snapshot.totals.stars, "downloads": snapshot.totals.downloads, "ms": ms, "kind": kind }),
        );

        Ok(json!({ "ok": true, "snapshot": snapshot, "ms": ms, "timing": timing }))
    })();

    runtime.fetch_in_progress.store(false, Ordering::SeqCst);

    match result {
        Ok(v) => v,
        Err(e) => {
            log.error("runFetch failed", json!({ "message": e }));
            emit(
                "fetch:progress",
                json!({ "phase": "error", "message": e }),
            );
            json!({ "ok": false, "error": e, "ms": chrono::Utc::now().timestamp_millis() - started })
        }
    }
}

#[tauri::command]
pub fn renderer_ready(app: AppHandle) -> Value {
    let runtime = app.state::<AppRuntime>();
    runtime.renderer_ready.store(true, Ordering::SeqCst);
    runtime.log.info("Renderer ready", json!({}));
    maybe_auto_fetch(&app);
    json!({ "ok": true })
}

#[tauri::command]
pub async fn auth_check(app: AppHandle) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let status = collector::gh_status();
        let ms = started.elapsed().as_millis() as u64;
        let tray_state = app.state::<TrayBaseState>();
        store::record_timing(&tray_state, "auth", ms, json!({}));
        json!({
            "ok": status.authenticated,
            "user": status.user,
            "error": status.message,
            "ms": ms,
            "installed": status.installed,
            "path": status.path,
            "version": status.version,
            "timing": store::timing_stats(&tray_state)
        })
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

#[tauri::command]
pub async fn gh_status() -> Value {
    tauri::async_runtime::spawn_blocking(collector::gh_status)
        .await
        .map(|status| json!(status))
        .unwrap_or_else(|e| json!({ "installed": false, "authenticated": false, "message": e.to_string() }))
}

#[tauri::command]
pub async fn gh_install() -> Value {
    tauri::async_runtime::spawn_blocking(|| match collector::install_gh() {
        Ok(message) => {
            let status = collector::gh_status();
            json!({ "ok": true, "message": message, "status": status })
        }
        Err(error) => {
            let status = collector::gh_status();
            json!({ "ok": false, "error": error, "status": status })
        }
    })
    .await
    .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }))
}

#[tauri::command]
pub fn auth_login() -> Value {
    match collector::start_auth_login() {
        Ok(message) => json!({ "ok": true, "message": message }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
pub async fn dashboard_get(app: AppHandle, range_days: Option<Value>) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let data = user_data(&app);
        let snaps = store::load_all_snapshots(&data);
        let names: Vec<String> = snaps
            .last()
            .map(|s| s.repos.iter().map(|r| r.name.clone()).collect())
            .unwrap_or_default();
        let histories = load_all_star_histories(&data, &names);
        let health = collector::load_health(&data);
        build_dashboard(
            &snaps,
            &histories,
            range_days.unwrap_or(json!(30)),
            health.as_ref(),
        )
    })
    .await
    .unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

/// Starts a background fetch and returns immediately so the UI stays responsive.
/// Progress/completion are delivered via `fetch:progress` and `fetch:done` events.
#[tauri::command]
pub fn fetch_run(app: AppHandle, options: Option<FetchOptions>) -> Value {
    let include = options
        .and_then(|o| o.include_star_history)
        .unwrap_or(false);
    let runtime = app.state::<AppRuntime>();
    if runtime.fetch_in_progress.load(Ordering::SeqCst) {
        return json!({ "ok": false, "started": false, "error": "Fetch already in progress" });
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        let _ = run_fetch_blocking(&app2, include);
    });
    json!({ "ok": true, "started": true })
}

#[tauri::command]
pub fn fetch_status(app: AppHandle) -> Value {
    let runtime = app.state::<AppRuntime>();
    json!({ "inProgress": runtime.fetch_in_progress.load(Ordering::SeqCst) })
}

#[tauri::command]
pub fn timings_get(app: AppHandle) -> Value {
    store::timing_stats(&app.state::<TrayBaseState>())
}

#[tauri::command]
pub fn logs_get(app: AppHandle, limit: Option<usize>) -> Value {
    let runtime = app.state::<AppRuntime>();
    json!(runtime.log.get_logs(limit.unwrap_or(80)))
}

#[tauri::command]
pub fn logs_path(app: AppHandle) -> Value {
    let runtime = app.state::<AppRuntime>();
    json!(runtime
        .log
        .log_path()
        .map(|p| p.to_string_lossy().to_string()))
}

#[allow(dead_code)]
fn _snap(_: Snapshot) {}
#[allow(dead_code)]
fn _path(_: &Path) {}
