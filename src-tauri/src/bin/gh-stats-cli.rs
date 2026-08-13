use std::env;
use std::path::PathBuf;
use std::process;
use std::thread;
use std::time::Duration;

use gh_stats_core::analytics::build_dashboard;
use gh_stats_core::collector::{
    self, check_auth, default_data_dir, fetch_current_totals_with_options,
    fetch_star_history, fetch_traffic_for_repos, load_all_star_histories, save_health,
    save_star_history, FetchOptions,
};
use gh_stats_core::export::{export_csv, export_static_site};
use gh_stats_core::settings::{load_settings, record_timing, save_settings, update_last_fetch};
use gh_stats_core::store::{load_all_snapshots, save_snapshot, sync_from_dot_gh_stats};
use gh_stats_core::traffic::load_all_traffic;
use serde_json::json;

fn data_dir() -> PathBuf {
    env::var("GH_STATS_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_data_dir())
}

fn print_help() {
    eprintln!(
        r#"gh-stats — local GitHub portfolio analytics

Usage:
  gh-stats fetch [--visibility public|private|all] [--no-traffic] [--no-registries]
  gh-stats history
  gh-stats status [--json]
  gh-stats export [--format csv|json|site] [--output PATH] [--range 7|30|90|all]
  gh-stats serve [--port 3847] [--range 30]
  gh-stats sync

Commands:
  fetch     Pull latest stars, downloads, health, traffic, and registry stats
  history   Backfill star timelines (rate-limit aware)
  status    Print portfolio KPIs
  export    Export CSV, JSON dashboard, or static site
  serve     Local HTTP server for the web dashboard
  sync      Import snapshots from .gh-stats/ directory
"#
    );
}

fn cmd_fetch(args: &[String]) {
    let mut visibility = "public".to_string();
    let mut include_traffic = true;
    let mut include_registries = true;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--visibility" if i + 1 < args.len() => {
                visibility = args[i + 1].clone();
                i += 2;
            }
            "--no-traffic" => {
                include_traffic = false;
                i += 1;
            }
            "--no-registries" => {
                include_registries = false;
                i += 1;
            }
            _ => i += 1,
        }
    }

    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let (ok, user, err, _) = check_auth();
    if !ok {
        eprintln!("Auth failed: {}", err.unwrap_or_default());
        process::exit(1);
    }
    eprintln!("Authenticated as {}", user.unwrap_or_default());

    let started = std::time::Instant::now();
    let totals = fetch_current_totals_with_options(
        FetchOptions {
            visibility,
            include_traffic,
            include_registries,
        },
        |p| {
            eprintln!(
                "[{}] {} ({}/{})",
                p.get("phase").and_then(|v| v.as_str()).unwrap_or(""),
                p.get("repo").and_then(|v| v.as_str()).unwrap_or(""),
                p.get("current").and_then(|v| v.as_u64()).unwrap_or(0),
                p.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
            );
        },
    )
    .unwrap_or_else(|e| {
        eprintln!("Fetch failed: {e}");
        process::exit(1);
    });

    let repo_names: Vec<String> = totals.repos.iter().map(|r| r.name.clone()).collect();
    if include_traffic {
        let _ = fetch_traffic_for_repos(&dir, &repo_names, |p| {
            eprintln!(
                "traffic: {} ({}/{})",
                p.get("repo").and_then(|v| v.as_str()).unwrap_or(""),
                p.get("current").and_then(|v| v.as_u64()).unwrap_or(0),
                p.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
            );
        });
    }

    let snapshot = save_snapshot(&dir, totals.repos, totals.totals).unwrap_or_else(|e| {
        eprintln!("Save failed: {e}");
        process::exit(1);
    });
    let _ = update_last_fetch(&dir, snapshot.timestamp);
    let _ = save_health(&dir, &totals.health);
    let ms = started.elapsed().as_millis();
    let _ = record_timing(&dir, "fetch", ms as u64, json!({ "repos": repo_names.len() }));
    eprintln!(
        "Done — {} stars, {} downloads ({} repos, {}ms)",
        snapshot.totals.stars, snapshot.totals.downloads, repo_names.len(), ms
    );
}

fn cmd_history() {
    let dir = data_dir();
    let (ok, _, err, _) = check_auth();
    if !ok {
        eprintln!("Auth failed: {}", err.unwrap_or_default());
        process::exit(1);
    }
    let snaps = load_all_snapshots(&dir);
    let repos: Vec<String> = snaps
        .last()
        .map(|s| s.repos.iter().map(|r| r.name.clone()).collect())
        .unwrap_or_default();
    for (i, repo) in repos.iter().enumerate() {
        eprintln!("Star history {}/{}: {}", i + 1, repos.len(), repo);
        let hist = fetch_star_history(repo, |p| {
            eprintln!(
                "  page {} — {} stars",
                p.get("page").and_then(|v| v.as_u64()).unwrap_or(0),
                p.get("fetched").and_then(|v| v.as_u64()).unwrap_or(0),
            );
        })
        .unwrap_or_else(|e| {
            eprintln!("Failed for {repo}: {e}");
            process::exit(1);
        });
        save_star_history(&dir, &hist).unwrap_or_else(|e| {
            eprintln!("Save failed: {e}");
            process::exit(1);
        });
        thread::sleep(Duration::from_millis(200));
    }
    let mut settings = load_settings(&dir);
    settings.star_history_loaded = true;
    let _ = save_settings(&dir, &settings);
    eprintln!("Star history complete for {} repos", repos.len());
}

fn cmd_status(json_out: bool) {
    let dir = data_dir();
    let snaps = load_all_snapshots(&dir);
    let names: Vec<String> = snaps
        .last()
        .map(|s| s.repos.iter().map(|r| r.name.clone()).collect())
        .unwrap_or_default();
    let histories = load_all_star_histories(&dir, &names);
    let health = collector::load_health(&dir);
    let traffic = load_all_traffic(&dir);
    let dashboard = build_dashboard(&snaps, &histories, json!(30), health.as_ref(), &traffic);
    if json_out {
        println!("{}", serde_json::to_string_pretty(&dashboard).unwrap_or_default());
    } else {
        let m = dashboard.get("metrics").cloned().unwrap_or(json!({}));
        println!(
            "Stars: {} | Downloads: {} | 7d stars: {} | 30d stars: {} | Views (14d): {} | Clones (14d): {}",
            m.get("totalStars").and_then(|v| v.as_u64()).unwrap_or(0),
            m.get("totalDownloads").and_then(|v| v.as_u64()).unwrap_or(0),
            m.get("stars7d").and_then(|v| v.as_u64()).unwrap_or(0),
            m.get("stars30d").and_then(|v| v.as_u64()).unwrap_or(0),
            m.get("views14d").and_then(|v| v.as_u64()).unwrap_or(0),
            m.get("clones14d").and_then(|v| v.as_u64()).unwrap_or(0),
        );
        let issue_count = dashboard
            .get("health")
            .and_then(|h| h.get("issueCount"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        if issue_count > 0 {
            println!("Health issues: {}", issue_count);
        }
    }
}

fn cmd_export(args: &[String]) {
    let mut format = "csv".to_string();
    let mut output = PathBuf::from("gh-stats-export.csv");
    let mut range = json!(30);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--format" if i + 1 < args.len() => {
                format = args[i + 1].clone();
                i += 2;
            }
            "--output" if i + 1 < args.len() => {
                output = PathBuf::from(&args[i + 1]);
                i += 2;
            }
            "--range" if i + 1 < args.len() => {
                range = if args[i + 1] == "all" {
                    json!("all")
                } else {
                    json!(args[i + 1].parse::<u64>().unwrap_or(30))
                };
                i += 2;
            }
            _ => i += 1,
        }
    }
    let dir = data_dir();
    match format.as_str() {
        "csv" => export_csv(&dir, &output).unwrap_or_else(|e| {
            eprintln!("Export failed: {e}");
            process::exit(1);
        }),
        "json" => {
            let snaps = load_all_snapshots(&dir);
            let names: Vec<String> = snaps
                .last()
                .map(|s| s.repos.iter().map(|r| r.name.clone()).collect())
                .unwrap_or_default();
            let histories = load_all_star_histories(&dir, &names);
            let health = collector::load_health(&dir);
            let traffic = load_all_traffic(&dir);
            let dashboard = build_dashboard(&snaps, &histories, range, health.as_ref(), &traffic);
            std::fs::write(&output, serde_json::to_string_pretty(&dashboard).unwrap())
                .unwrap_or_else(|e| {
                    eprintln!("Write failed: {e}");
                    process::exit(1);
                });
        }
        "site" => export_static_site(&dir, &output, range).unwrap_or_else(|e| {
            eprintln!("Site export failed: {e}");
            process::exit(1);
        }),
        _ => {
            eprintln!("Unknown format: {format}");
            process::exit(1);
        }
    }
    eprintln!("Exported to {}", output.display());
}

fn cmd_serve(args: &[String]) {
    let mut port: u16 = 3847;
    let mut range = json!(30);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" if i + 1 < args.len() => {
                port = args[i + 1].parse().unwrap_or(3847);
                i += 2;
            }
            "--range" if i + 1 < args.len() => {
                range = if args[i + 1] == "all" {
                    json!("all")
                } else {
                    json!(args[i + 1].parse::<u64>().unwrap_or(30))
                };
                i += 2;
            }
            _ => i += 1,
        }
    }

    let dir = data_dir();
    let addr = format!("127.0.0.1:{port}");
    let server = tiny_http::Server::http(&addr).unwrap_or_else(|e| {
        eprintln!("Failed to start server: {e}");
        process::exit(1);
    });
    eprintln!("Serving GhStats dashboard at http://{addr}");

    for request in server.incoming_requests() {
        let url = request.url().to_string();
        let response = if url == "/dashboard-data.json" || url.starts_with("/api/dashboard") {
            let snaps = load_all_snapshots(&dir);
            let names: Vec<String> = snaps
                .last()
                .map(|s| s.repos.iter().map(|r| r.name.clone()).collect())
                .unwrap_or_default();
            let histories = load_all_star_histories(&dir, &names);
            let health = collector::load_health(&dir);
            let traffic = load_all_traffic(&dir);
            let dashboard = build_dashboard(&snaps, &histories, range.clone(), health.as_ref(), &traffic);
            tiny_http::Response::from_string(serde_json::to_string(&dashboard).unwrap())
                .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
        } else if url == "/" || url.starts_with("/index") {
            serve_renderer_file("index.html", "text/html")
        } else if url.starts_with('/') {
            let path = url.trim_start_matches('/');
            let (file, mime) = match path {
                p if p.ends_with(".css") => (p, "text/css"),
                p if p.ends_with(".js") => (p, "application/javascript"),
                _ => (path, "application/octet-stream"),
            };
            serve_renderer_file(file, mime)
        } else {
            tiny_http::Response::from_string("Not found").with_status_code(404)
        };
        let _ = request.respond(response);
    }
}

fn serve_renderer_file(name: &str, mime: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let candidates = [
        PathBuf::from("renderer").join(name),
        PathBuf::from("../renderer").join(name),
    ];
    for path in candidates {
        if path.is_file() {
            if let Ok(data) = std::fs::read(&path) {
                return tiny_http::Response::from_data(data).with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()).unwrap(),
                );
            }
        }
    }
    tiny_http::Response::from_string(format!("Missing file: {name}")).with_status_code(404)
}

fn cmd_sync() {
    let dir = data_dir();
    let count = sync_from_dot_gh_stats(&dir).unwrap_or_else(|e| {
        eprintln!("Sync failed: {e}");
        process::exit(1);
    });
    eprintln!("Synced {count} files from .gh-stats/");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || args[0] == "--help" || args[0] == "-h" {
        print_help();
        return;
    }
    match args[0].as_str() {
        "fetch" => cmd_fetch(&args[1..]),
        "history" => cmd_history(),
        "status" => {
            let json_out = args.iter().any(|a| a == "--json");
            cmd_status(json_out);
        }
        "export" => cmd_export(&args[1..]),
        "serve" => cmd_serve(&args[1..]),
        "sync" => cmd_sync(),
        other => {
            eprintln!("Unknown command: {other}");
            print_help();
            process::exit(1);
        }
    }
}
