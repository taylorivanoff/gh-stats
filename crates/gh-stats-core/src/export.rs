use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::analytics::build_dashboard;
use crate::collector::load_all_star_histories;
use crate::collector::load_health;
use crate::store::load_all_snapshots;
use crate::traffic::load_all_traffic;

pub fn export_csv(user_data: &Path, output: &Path) -> Result<(), String> {
    let snapshots = load_all_snapshots(user_data);
    let latest = snapshots.last().ok_or("No snapshots to export")?;

    let mut lines = vec!["repository,stars,downloads,npm,pypi,crates".to_string()];
    for repo in &latest.repos {
        lines.push(format!(
            "{},{},{},{},{},{}",
            repo.name,
            repo.stars,
            repo.downloads,
            repo.npm_downloads.unwrap_or(0),
            repo.pypi_downloads.unwrap_or(0),
            repo.crate_downloads.unwrap_or(0),
        ));
    }
    if let Some(parent) = output.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(output, lines.join("\n")).map_err(|e| e.to_string())
}

pub fn export_static_site(user_data: &Path, output: &Path, range_days: Value) -> Result<(), String> {
    let snapshots = load_all_snapshots(user_data);
    let names: Vec<String> = snapshots
        .last()
        .map(|s| s.repos.iter().map(|r| r.name.clone()).collect())
        .unwrap_or_default();
    let histories = load_all_star_histories(user_data, &names);
    let health = load_health(user_data);
    let traffic = load_all_traffic(user_data);
    let dashboard = build_dashboard(
        &snapshots,
        &histories,
        range_days,
        health.as_ref(),
        &traffic,
    );

    let renderer = find_renderer_dir();
    if !renderer.is_dir() {
        return Err(format!("Renderer directory not found at {}", renderer.display()));
    }

    copy_dir_recursive(&renderer, output)?;
    let data_path = output.join("dashboard-data.json");
    let text = serde_json::to_string_pretty(&dashboard).map_err(|e| e.to_string())?;
    fs::write(data_path, text).map_err(|e| e.to_string())?;

    let bootstrap = r#"(function(){
  fetch('dashboard-data.json').then(r=>r.json()).then(data=>{
    if(window.__ghStatsRender) window.__ghStatsRender(data);
  }).catch(e=>console.error('Failed to load dashboard data', e));
})();"#;
    fs::write(output.join("web-bootstrap.js"), bootstrap).map_err(|e| e.to_string())?;

    let index_path = output.join("index.html");
    if index_path.is_file() {
        let mut html = fs::read_to_string(&index_path).map_err(|e| e.to_string())?;
        if !html.contains("web-bootstrap.js") {
            html = html.replace(
                "<script src=\"app.js\"></script>",
                "<script src=\"app.js\"></script>\n  <script src=\"web-bootstrap.js\"></script>",
            );
        }
        fs::write(index_path, html).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn find_renderer_dir() -> std::path::PathBuf {
    let candidates = [
        Path::new("renderer"),
        Path::new("../renderer"),
        Path::new("../../renderer"),
    ];
    for c in candidates {
        if c.join("index.html").is_file() {
            return c.to_path_buf();
        }
    }
    Path::new("renderer").to_path_buf()
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let dest = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn export_dot_gh_stats(user_data: &Path, output: &Path) -> Result<usize, String> {
    fs::create_dir_all(output).map_err(|e| e.to_string())?;
    let mut count = 0usize;

    let snap_src = user_data.join("snapshots");
    if snap_src.is_dir() {
        let snap_dst = output.join("snapshots");
        copy_dir_recursive(&snap_src, &snap_dst)?;
        count += fs::read_dir(&snap_dst).map(|d| d.count()).unwrap_or(0);
    }

    let star_src = user_data.join("star-history");
    if star_src.is_dir() {
        let star_dst = output.join("star-history");
        copy_dir_recursive(&star_src, &star_dst)?;
    }

    let traffic_src = user_data.join("traffic");
    if traffic_src.is_dir() {
        let traffic_dst = output.join("traffic");
        copy_dir_recursive(&traffic_src, &traffic_dst)?;
    }

    let health = user_data.join("health-latest.json");
    if health.is_file() {
        fs::copy(&health, output.join("health-latest.json")).map_err(|e| e.to_string())?;
        count += 1;
    }

    Ok(count)
}
