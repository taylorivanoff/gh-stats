use std::sync::atomic::Ordering;

use gh_stats_core::analytics::build_dashboard;
use gh_stats_core::collector::{
    self, fetch_current_totals_with_options, fetch_star_history, fetch_traffic_for_repos,
    load_all_star_histories, save_health, save_star_history, FetchOptions,
};
use gh_stats_core::demo::{clear_demo_data, is_demo_snapshot, purge_demo_files, seed_demo_data};
use gh_stats_core::settings::{
    load_settings, record_timing, save_settings, timing_stats, update_last_fetch, AppSettings,
};
use gh_stats_core::store::{load_all_snapshots, save_snapshot};
use gh_stats_core::traffic::load_all_traffic;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_tray_base::{emit_to_renderer, TrayBaseState};

use crate::user_data;
use crate::AppRuntime;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FetchOptionsPayload {
    pub include_star_history: Option<bool>,
}

fn sync_settings_from_tray(data_dir: &std::path::Path, tray_state: &TrayBaseState) -> AppSettings {
    let mut settings = load_settings(data_dir);
    let tray = tray_state.settings.lock();
    if let Some(v) = tray.extra.get("starHistoryLoaded") {
        settings.star_history_loaded = v.as_bool().unwrap_or(false);
    }
    if let Some(v) = tray.extra.get("lastFetchAt") {
        settings.last_fetch_at = v.as_i64();
    }
    if let Some(v) = tray.extra.get("repoVisibility").and_then(|v| v.as_str()) {
        settings.repo_visibility = v.to_string();
    }
    if let Some(v) = tray.extra.get("onboardingComplete") {
        settings.onboarding_complete = v.as_bool().unwrap_or(false);
    }
    if let Some(v) = tray.extra.get("demoMode") {
        settings.demo_mode = v.as_bool().unwrap_or(false);
    }
    if let Some(v) = tray.extra.get("autoStarHistory") {
        settings.auto_star_history = v.as_bool().unwrap_or(true);
    }
    settings
}

fn persist_settings(data_dir: &std::path::Path, settings: &AppSettings, tray_state: &TrayBaseState) {
    let _ = save_settings(data_dir, settings);
    let mut tray = tray_state.settings.lock();
    tray.extra.insert("starHistoryLoaded".into(), json!(settings.star_history_loaded));
    tray.extra.insert("lastFetchAt".into(), json!(settings.last_fetch_at));
    tray.extra.insert("repoVisibility".into(), json!(settings.repo_visibility));
    tray.extra.insert("onboardingComplete".into(), json!(settings.onboarding_complete));
    tray.extra.insert("demoMode".into(), json!(settings.demo_mode));
    tray.extra.insert("autoStarHistory".into(), json!(settings.auto_star_history));
    let _ = tauri_tray_base::save_settings(&tray_state.settings_path, &tray);
}

fn maybe_auto_fetch(app: &AppHandle) {
    let runtime = app.state::<AppRuntime>();
    if !runtime.renderer_ready.load(Ordering::SeqCst)
        || !runtime.pending_auto_fetch.load(Ordering::SeqCst)
        || runtime.fetch_in_progress.load(Ordering::SeqCst)
    {
        return;
    }
    runtime.pending_auto_fetch.store(false, Ordering::SeqCst);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let _ = run_fetch_blocking(&app2, false, false);
    });
}

fn maybe_auto_history(app: &AppHandle) {
    let runtime = app.state::<AppRuntime>();
    if !runtime.renderer_ready.load(Ordering::SeqCst)
        || !runtime.pending_auto_history.load(Ordering::SeqCst)
        || runtime.fetch_in_progress.load(Ordering::SeqCst)
    {
        return;
    }
    let data = user_data(app);
    let settings = load_settings(&data);
    if settings.star_history_loaded {
        runtime.pending_auto_history.store(false, Ordering::SeqCst);
        return;
    }
    runtime.pending_auto_history.store(false, Ordering::SeqCst);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let _ = run_fetch_blocking(&app2, true, false);
    });
}

pub fn run_fetch_blocking(app: &AppHandle, include_star_history: bool, _seed_demo_first: bool) -> Value {
    let runtime = app.state::<AppRuntime>();
    if runtime.fetch_in_progress.swap(true, Ordering::SeqCst) {
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
        let _ = record_timing(&data, "auth", auth_ms, json!({}));
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

        let mut settings = sync_settings_from_tray(&data, &tray_state);
        if settings.demo_mode {
            let _ = clear_demo_data(&data);
            settings.demo_mode = false;
        }

        emit(
            "fetch:progress",
            json!({
                "phase": "repos",
                "message": format!("Listing repos for {}…", user.unwrap_or_default()),
                "startedAt": started
            }),
        );

        let fetch_opts = FetchOptions {
            visibility: settings.repo_visibility.clone(),
            include_traffic: true,
            include_registries: true,
        };

        let totals = fetch_current_totals_with_options(fetch_opts, |p| {
            emit(
                "fetch:progress",
                json!({
                    "phase": p.get("phase").cloned().unwrap_or(json!("releases")),
                    "message": format!(
                        "Fetching: {} ({}/{})",
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

        let repo_names: Vec<String> = totals.repos.iter().map(|r| r.name.clone()).collect();
        emit(
            "fetch:progress",
            json!({
                "phase": "traffic",
                "message": "Fetching GitHub traffic (views, clones, referrers)…",
                "startedAt": started
            }),
        );
        let _ = fetch_traffic_for_repos(&data, &repo_names, |p| {
            emit(
                "fetch:progress",
                json!({
                    "phase": "traffic",
                    "message": format!(
                        "Traffic: {} ({}/{})",
                        p.get("repo").and_then(|v| v.as_str()).unwrap_or(""),
                        p.get("current").and_then(|v| v.as_u64()).unwrap_or(0),
                        p.get("total").and_then(|v| v.as_u64()).unwrap_or(0)
                    ),
                    "current": p.get("current"),
                    "total": p.get("total"),
                    "startedAt": started
                }),
            );
        });

        let snapshot = save_snapshot(&data, totals.repos.clone(), totals.totals.clone())?;
        let _ = update_last_fetch(&data, snapshot.timestamp);
        let _ = save_health(&data, &totals.health);

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
                let hist = fetch_star_history(&repo.name, |p| {
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
                save_star_history(&data, &hist)?;
                if i + 1 < totals.repos.len() {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
            settings.star_history_loaded = true;
        }

        settings.onboarding_complete = true;
        persist_settings(&data, &settings, &tray_state);

        let ms = (chrono::Utc::now().timestamp_millis() - started) as u64;
        let kind = if include_star_history { "history" } else { "fetch" };
        let _ = record_timing(
            &data,
            kind,
            ms,
            json!({ "repos": totals.repos.len() }),
        );
        let timing = timing_stats(&data);

        emit(
            "fetch:done",
            json!({ "snapshot": snapshot, "ms": ms, "kind": kind, "timing": timing }),
        );

        let snaps = load_all_snapshots(&data);
        let names: Vec<String> = totals.repos.iter().map(|r| r.name.clone()).collect();
        let histories = load_all_star_histories(&data, &names);
        let health = collector::load_health(&data).unwrap_or_else(collector::empty_health);
        let traffic = load_all_traffic(&data);
        let dashboard = build_dashboard(&snaps, &histories, json!(30), Some(&health), &traffic);
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

    let data = user_data(&app);
    let _ = purge_demo_files(&data);
    let snaps = load_all_snapshots(&data);
    if is_demo_snapshot(&snaps) {
        let _ = clear_demo_data(&data);
        let mut settings = load_settings(&data);
        settings.demo_mode = false;
        let _ = save_settings(&data, &settings);
    }

    maybe_auto_fetch(&app);
    maybe_auto_history(&app);
    json!({ "ok": true })
}

#[tauri::command]
pub async fn auth_check(app: AppHandle) -> Value {
    tauri::async_runtime::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let status = collector::gh_status();
        let ms = started.elapsed().as_millis() as u64;
        let data = user_data(&app);
        let _ = record_timing(&data, "auth", ms, json!({}));
        json!({
            "ok": status.authenticated,
            "user": status.user,
            "error": status.message,
            "ms": ms,
            "installed": status.installed,
            "path": status.path,
            "version": status.version,
            "timing": timing_stats(&data)
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
        let snaps = load_all_snapshots(&data);
        let names: Vec<String> = snaps
            .last()
            .map(|s| s.repos.iter().map(|r| r.name.clone()).collect())
            .unwrap_or_default();
        let histories = load_all_star_histories(&data, &names);
        let health = collector::load_health(&data);
        let traffic = load_all_traffic(&data);
        let mut dashboard = build_dashboard(
            &snaps,
            &histories,
            range_days.unwrap_or(json!(30)),
            health.as_ref(),
            &traffic,
        );
        let settings = load_settings(&data);
        if let Some(obj) = dashboard.as_object_mut() {
            obj.insert("demoMode".into(), json!(settings.demo_mode || is_demo_snapshot(&snaps)));
            obj.insert("onboardingComplete".into(), json!(settings.onboarding_complete));
        }
        dashboard
    })
    .await
    .unwrap_or_else(|e| json!({ "error": e.to_string() }))
}

#[tauri::command]
pub fn fetch_run(app: AppHandle, options: Option<FetchOptionsPayload>) -> Value {
    let include = options
        .and_then(|o| o.include_star_history)
        .unwrap_or(false);
    let runtime = app.state::<AppRuntime>();
    if runtime.fetch_in_progress.load(Ordering::SeqCst) {
        return json!({ "ok": false, "started": false, "error": "Fetch already in progress" });
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        let _ = run_fetch_blocking(&app2, include, false);
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
    timing_stats(&user_data(&app))
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

#[tauri::command]
pub fn seed_demo(app: AppHandle) -> Value {
    let data = user_data(&app);
    match seed_demo_data(&data) {
        Ok(result) => {
            let mut settings = load_settings(&data);
            settings.demo_mode = true;
            let _ = save_settings(&data, &settings);
            json!({ "ok": true, "snapshots": result.snapshots, "starHistories": result.star_histories })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn complete_onboarding(app: AppHandle) -> Value {
    let data = user_data(&app);
    let mut settings = load_settings(&data);
    settings.onboarding_complete = true;
    let _ = save_settings(&data, &settings);
    json!({ "ok": true })
}

#[tauri::command]
pub fn dismiss_demo(app: AppHandle) -> Value {
    let data = user_data(&app);
    let _ = clear_demo_data(&data);
    let mut settings = load_settings(&data);
    settings.demo_mode = false;
    let _ = save_settings(&data, &settings);
    json!({ "ok": true })
}
