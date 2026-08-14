mod commands;
mod logger;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gh_stats_core::settings::{load_settings, needs_auto_fetch};
use serde_json::json;
use tauri::{Listener, Manager};
use tauri_tray_base::{
    apply_window_settings, install_state, setup_tray, sync_autostart, TrayBaseOptions,
    TrayExtraItem, TraySetupOptions,
};

pub struct AppRuntime {
    pub fetch_in_progress: AtomicBool,
    pub renderer_ready: AtomicBool,
    pub pending_auto_fetch: AtomicBool,
    pub pending_auto_history: AtomicBool,
    pub log: Arc<logger::Logger>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log = Arc::new(logger::Logger::new());

    let builder = tauri_tray_base::with_common_plugins(tauri::Builder::default())
        .manage(AppRuntime {
            fetch_in_progress: AtomicBool::new(false),
            renderer_ready: AtomicBool::new(false),
            pending_auto_fetch: AtomicBool::new(false),
            pending_auto_history: AtomicBool::new(false),
            log: log.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            tauri_tray_base::settings_get,
            tauri_tray_base::settings_set,
            tauri_tray_base::app_get_state,
            commands::renderer_ready,
            commands::auth_check,
            commands::gh_status,
            commands::gh_install,
            commands::auth_login,
            commands::dashboard_get,
            commands::fetch_run,
            commands::fetch_status,
            commands::timings_get,
            commands::logs_get,
            commands::logs_path,
            commands::seed_demo,
            commands::complete_onboarding,
            commands::dismiss_demo,
        ])
        .setup(move |app| {
            let mut defaults = HashMap::new();
            defaults.insert("autoFetchHours".into(), json!(24));
            defaults.insert("opacity".into(), json!(1.0));
            defaults.insert("starHistoryLoaded".into(), json!(false));
            defaults.insert("showDebugBar".into(), json!(false));
            defaults.insert("layout".into(), json!({ "tableH": 140 }));
            defaults.insert("activeView".into(), json!("analytics"));
            defaults.insert("timings".into(), json!([]));
            defaults.insert("lastFetchAt".into(), json!(null));
            defaults.insert("repoVisibility".into(), json!("public"));
            defaults.insert("onboardingComplete".into(), json!(false));
            defaults.insert("demoMode".into(), json!(false));
            defaults.insert("autoStarHistory".into(), json!(true));

            install_state(
                app.handle(),
                TrayBaseOptions {
                    app_name: "GhStats".into(),
                    settings_file_name: "gh-stats-settings.json".into(),
                    defaults,
                    extra_tray_items: vec![TrayExtraItem {
                        id: "refresh".into(),
                        label: "Refresh data".into(),
                    }],
                    ..Default::default()
                },
            )?;

            setup_tray(app.handle(), TraySetupOptions::default())?;
            apply_window_settings(app.handle());
            tauri_tray_base::enable_frameless_chrome(app.handle());
            sync_autostart(app.handle());

            let data_dir = user_data(app.handle());
            let _ = std::fs::create_dir_all(data_dir.join("logs"));
            log.set_file(data_dir.join("logs").join("gh-stats.log"));
            log.info("GhStats starting", json!({ "version": app.package_info().version.to_string() }));

            let handle = app.handle().clone();
            let log_for_tray = log.clone();
            app.listen("tray:action", move |event| {
                let action = event.payload().trim_matches('"');
                if action == "refresh" {
                    log_for_tray.info("Tray refresh", json!({}));
                    let app = handle.clone();
                    std::thread::spawn(move || {
                        let _ = commands::run_fetch_blocking(&app, false, false);
                    });
                }
            });

            let data_dir = user_data(app.handle());
            let _ = gh_stats_core::store::sync_from_dot_gh_stats(&data_dir);

            let settings = load_settings(&data_dir);
            if needs_auto_fetch(&data_dir) {
                app.state::<AppRuntime>()
                    .pending_auto_fetch
                    .store(true, Ordering::SeqCst);
            }
            if settings.auto_star_history && !settings.star_history_loaded {
                app.state::<AppRuntime>()
                    .pending_auto_history
                    .store(true, Ordering::SeqCst);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            tauri_tray_base::on_window_event(window, event);
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running gh-stats");
}

pub fn user_data(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| gh_stats_core::collector::default_data_dir())
}
