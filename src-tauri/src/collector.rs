use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const RELEASE_DELAY_MS: u64 = 200;
const STAR_PAGE_DELAY_MS: u64 = 150;
const DEFAULT_GH_TIMEOUT_SECS: u64 = 45;
const AUTH_TIMEOUT_SECS: u64 = 20;

static GH_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoTotals {
    pub name: String,
    pub stars: u64,
    pub downloads: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub tag: String,
    pub name: Option<String>,
    pub published_at: Option<String>,
    pub draft: bool,
    pub prerelease: bool,
    pub url: Option<String>,
    pub asset_count: u64,
    pub downloads: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunInfo {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub branch: Option<String>,
    pub created_at: Option<String>,
    pub url: Option<String>,
    pub event: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIssue {
    pub kind: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoHealth {
    pub name: String,
    pub stars: u64,
    pub downloads: u64,
    pub latest_release: Option<ReleaseInfo>,
    pub latest_run: Option<WorkflowRunInfo>,
    pub recent_runs: Vec<WorkflowRunInfo>,
    pub issues: Vec<RepoIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    pub fetched_at: i64,
    pub repos: Vec<RepoHealth>,
    pub issues: Vec<Value>,
    pub builds: Vec<Value>,
    pub releases: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchTotals {
    pub repos: Vec<RepoTotals>,
    pub totals: Totals,
    pub health: HealthSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Totals {
    pub stars: u64,
    pub downloads: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarHistory {
    pub repo: String,
    pub fetched_at: i64,
    pub daily: serde_json::Map<String, Value>,
    pub total_stars: u64,
}

pub fn date_key() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub authenticated: bool,
    pub user: Option<String>,
    pub message: Option<String>,
}

pub fn clear_gh_cache() {
    let _ = GH_PATH.lock().map(|mut g| *g = None);
}

pub fn find_gh() -> Option<PathBuf> {
    if let Ok(guard) = GH_PATH.lock() {
        if let Some(ref p) = *guard {
            if p.exists() {
                return Some(p.clone());
            }
        }
    }

    if let Ok(found) = which::which("gh") {
        if let Ok(mut guard) = GH_PATH.lock() {
            *guard = Some(found.clone());
        }
        return Some(found);
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        candidates.push(PathBuf::from(r"C:\Program Files\GitHub CLI\gh.exe"));
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join(r"Programs\GitHub CLI\gh.exe"));
        }
    } else if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/opt/homebrew/bin/gh"));
        candidates.push(PathBuf::from("/usr/local/bin/gh"));
    }

    for c in candidates {
        if c.is_file() {
            if let Ok(mut guard) = GH_PATH.lock() {
                *guard = Some(c.clone());
            }
            return Some(c);
        }
    }

    None
}

fn resolve_gh() -> PathBuf {
    find_gh().unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "gh.exe" } else { "gh" }))
}

fn probe_gh_version(bin: &Path) -> Option<String> {
    let mut c = Command::new(bin);
    c.args(["--version"])
        .env("NO_COLOR", "1")
        .env("GH_PROMPT_DISABLED", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    let output = c.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    // "gh version 2.45.0 (2024-...)" → "2.45.0"
    let ver = line
        .strip_prefix("gh version ")
        .and_then(|s| s.split_whitespace().next())
        .unwrap_or(line);
    if ver.is_empty() {
        None
    } else {
        Some(ver.to_string())
    }
}

pub fn gh_status() -> GhStatus {
    let Some(path) = find_gh() else {
        return GhStatus {
            installed: false,
            path: None,
            version: None,
            authenticated: false,
            user: None,
            message: Some("GitHub CLI (gh) is not installed.".into()),
        };
    };

    let version = probe_gh_version(&path);
    let (ok, user, err, _) = check_auth();
    GhStatus {
        installed: true,
        path: Some(path.display().to_string()),
        version,
        authenticated: ok,
        user,
        message: err,
    }
}

fn find_winget() -> Option<PathBuf> {
    which::which("winget")
        .or_else(|_| which::which("winget.exe"))
        .ok()
        .or_else(|| {
            let local = std::env::var_os("LOCALAPPDATA")?;
            let base = PathBuf::from(local).join(r"Microsoft\WindowsApps\winget.exe");
            base.is_file().then_some(base)
        })
}

/// Install GitHub CLI. On Windows prefers winget; macOS uses brew; otherwise returns a download URL hint.
pub fn install_gh() -> Result<String, String> {
    if find_gh().is_some() {
        return Ok("GitHub CLI is already installed.".into());
    }

    #[cfg(windows)]
    {
        let winget = find_winget().ok_or_else(|| {
            "winget not found. Install GitHub CLI from https://cli.github.com/ or enable App Installer."
                .to_string()
        })?;
        let mut c = Command::new(&winget);
        c.args([
            "install",
            "--id",
            "GitHub.cli",
            "-e",
            "--source",
            "winget",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ]);
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            c.creation_flags(CREATE_NO_WINDOW);
        }
        let output = c
            .output()
            .map_err(|e| format!("Failed to start winget: {e}"))?;
        clear_gh_cache();
        if find_gh().is_some() {
            return Ok("GitHub CLI installed successfully.".into());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let code = output.status.code().unwrap_or(-1);
        if output.status.success() {
            return Err(
                "winget finished but gh.exe was not found yet. Restart GhStats or sign out/in, then retry."
                    .into(),
            );
        }
        return Err(format!(
            "winget install failed (exit {code}). {} {}",
            stdout.trim(),
            stderr.trim()
        ));
    }

    #[cfg(target_os = "macos")]
    {
        let brew = which::which("brew").map_err(|_| {
            "Homebrew not found. Install GitHub CLI from https://cli.github.com/ or run: brew install gh"
                .to_string()
        })?;
        let output = Command::new(brew)
            .args(["install", "gh"])
            .output()
            .map_err(|e| format!("Failed to start brew: {e}"))?;
        clear_gh_cache();
        if find_gh().is_some() {
            return Ok("GitHub CLI installed successfully.".into());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "brew install gh failed (exit {}). {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Err(
            "Install GitHub CLI from https://cli.github.com/ (or your distro package manager), then restart GhStats."
                .into(),
        )
    }
}

/// Opens an interactive `gh auth login` (web) so the user can authenticate.
pub fn start_auth_login() -> Result<String, String> {
    let bin = find_gh().ok_or_else(|| {
        "gh is not installed. Install GitHub CLI first.".to_string()
    })?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;
        Command::new(&bin)
            .args(["auth", "login", "-h", "github.com", "-p", "https", "-w"])
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("Failed to start gh auth login: {e}"))?;
        return Ok(
            "Opened a console for gh auth login. Complete sign-in there, then click Refresh status."
                .into(),
        );
    }

    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Terminal\" to do script \"{} auth login -h github.com -p https -w\"",
            bin.display()
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Failed to open Terminal for gh auth login: {e}"))?;
        return Ok(
            "Opened Terminal for gh auth login. Complete sign-in there, then click Refresh status."
                .into(),
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new(&bin)
            .args(["auth", "login", "-h", "github.com", "-p", "https", "-w"])
            .spawn()
            .map_err(|e| format!("Failed to start gh auth login: {e}"))?;
        Ok(
            "Started gh auth login. Complete sign-in in the terminal/browser, then click Refresh status."
                .into(),
        )
    }
}

fn run_gh(args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let bin = resolve_gh();
    let (tx, rx) = std::sync::mpsc::channel();
    let bin2 = bin.clone();
    let args2: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();

    std::thread::spawn(move || {
        let mut c = Command::new(&bin2);
        c.args(&args2)
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .env("GH_PROMPT_DISABLED", "1");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            c.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = tx.send(c.output());
    });

    match rx.recv_timeout(Duration::from_secs(timeout_secs)) {
        Ok(Ok(output)) => {
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(if stderr.trim().is_empty() {
                    format!("gh failed with status {}", output.status)
                } else {
                    stderr.trim().to_string()
                });
            }
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
        Ok(Err(e)) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                let _ = GH_PATH.lock().map(|mut g| *g = None);
                Err(format!(
                    "gh not found ({bin:?}). Install GitHub CLI or ensure it is on PATH."
                ))
            } else {
                Err(e.to_string())
            }
        }
        Err(_) => Err(format!(
            "gh timed out after {}ms: {}",
            timeout_secs * 1000,
            args.iter().take(3).cloned().collect::<Vec<_>>().join(" ")
        )),
    }
}

pub fn check_auth() -> (bool, Option<String>, Option<String>, u64) {
    let started = Instant::now();
    match run_gh(&["api", "user", "-q", ".login"], AUTH_TIMEOUT_SECS) {
        Ok(user) => {
            let user = user.trim().to_string();
            let ms = started.elapsed().as_millis() as u64;
            if user.is_empty() {
                (
                    false,
                    None,
                    Some("gh returned empty user — run: gh auth login".into()),
                    ms,
                )
            } else {
                (true, Some(user), None, ms)
            }
        }
        Err(e) => (false, None, Some(e), started.elapsed().as_millis() as u64),
    }
}

fn list_repos() -> Result<Vec<Value>, String> {
    let stdout = run_gh(
        &[
            "repo",
            "list",
            "--visibility",
            "public",
            "--limit",
            "1000",
            "--json",
            "nameWithOwner,stargazerCount,updatedAt",
        ],
        DEFAULT_GH_TIMEOUT_SECS,
    )?;
    let repos: Value = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
    repos
        .as_array()
        .cloned()
        .ok_or_else(|| "gh repo list did not return a JSON array".into())
}

fn parse_release_line(line: &str) -> Option<(u64, ReleaseInfo)> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let downloads = v.get("downloads").and_then(|x| x.as_u64()).unwrap_or(0);
    let tag = v.get("tag").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if tag.is_empty() {
        return None;
    }
    Some((
        downloads,
        ReleaseInfo {
            tag,
            name: v
                .get("name")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty()),
            published_at: v
                .get("publishedAt")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            draft: v.get("draft").and_then(|x| x.as_bool()).unwrap_or(false),
            prerelease: v.get("prerelease").and_then(|x| x.as_bool()).unwrap_or(false),
            url: v
                .get("url")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            asset_count: v.get("assetCount").and_then(|x| x.as_u64()).unwrap_or(0),
            downloads,
        },
    ))
}

/// Returns (total downloads across all releases, latest release if any).
fn fetch_release_summary(repo: &str) -> (u64, Option<ReleaseInfo>) {
    let path = format!("repos/{repo}/releases");
    match run_gh(
        &[
            "api",
            &path,
            "--paginate",
            "--jq",
            ".[] | {tag: .tag_name, name: .name, publishedAt: .published_at, draft: .draft, prerelease: .prerelease, url: .html_url, assetCount: (.assets | length), downloads: ([.assets[].download_count] | add // 0)}",
        ],
        60,
    ) {
        Ok(stdout) => {
            let mut total = 0u64;
            let mut latest: Option<ReleaseInfo> = None;
            for line in stdout.lines() {
                if let Some((dl, info)) = parse_release_line(line) {
                    total += dl;
                    if latest.is_none() {
                        latest = Some(info);
                    }
                }
            }
            (total, latest)
        }
        Err(_) => (0, None),
    }
}

fn parse_run_value(v: &Value) -> Option<WorkflowRunInfo> {
    let id = v.get("id").and_then(|x| x.as_u64())?;
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("workflow")
        .to_string();
    Some(WorkflowRunInfo {
        id,
        name,
        status: v
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string(),
        conclusion: v
            .get("conclusion")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty() && *s != "null")
            .map(|s| s.to_string()),
        branch: v
            .get("branch")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        created_at: v
            .get("createdAt")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        url: v
            .get("url")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
        event: v
            .get("event")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
    })
}

fn fetch_recent_runs(repo: &str) -> Vec<WorkflowRunInfo> {
    let path = format!("repos/{repo}/actions/runs?per_page=5");
    match run_gh(
        &[
            "api",
            &path,
            "--jq",
            "[.workflow_runs[:5][]? | {id, name, status, conclusion, branch: .head_branch, createdAt: .created_at, url: .html_url, event}]",
        ],
        45,
    ) {
        Ok(stdout) => {
            let trimmed = stdout.trim();
            if trimmed.is_empty() || trimmed == "null" {
                return vec![];
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(Value::Array(arr)) => arr.iter().filter_map(parse_run_value).collect(),
                _ => vec![],
            }
        }
        Err(_) => vec![],
    }
}

fn classify_issues(
    latest_release: &Option<ReleaseInfo>,
    recent_runs: &[WorkflowRunInfo],
) -> Vec<RepoIssue> {
    let mut issues = Vec::new();

    match latest_release {
        None => issues.push(RepoIssue {
            kind: "no_release".into(),
            severity: "warn".into(),
            message: "No releases published".into(),
        }),
        Some(rel) if rel.draft => issues.push(RepoIssue {
            kind: "draft_release".into(),
            severity: "warn".into(),
            message: format!("Latest release {} is still a draft", rel.tag),
        }),
        Some(rel) if rel.asset_count == 0 => issues.push(RepoIssue {
            kind: "no_assets".into(),
            severity: "error".into(),
            message: format!("Latest release {} has no assets", rel.tag),
        }),
        _ => {}
    }

    if let Some(run) = recent_runs.first() {
        let status = run.status.to_lowercase();
        let conclusion = run
            .conclusion
            .as_deref()
            .unwrap_or("")
            .to_lowercase();
        if status == "in_progress" || status == "queued" || status == "waiting" || status == "pending"
        {
            issues.push(RepoIssue {
                kind: "ci_pending".into(),
                severity: "info".into(),
                message: format!("{} is {}", run.name, status),
            });
        } else if matches!(
            conclusion.as_str(),
            "failure" | "timed_out" | "cancelled" | "startup_failure" | "action_required"
        ) {
            issues.push(RepoIssue {
                kind: "ci_failed".into(),
                severity: "error".into(),
                message: format!("{} ended with {}", run.name, conclusion),
            });
        }
    }

    issues
}

fn build_health_views(repos: &[RepoHealth]) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
    let mut issues = Vec::new();
    for repo in repos {
        for issue in &repo.issues {
            issues.push(json!({
                "repo": repo.name,
                "kind": issue.kind,
                "severity": issue.severity,
                "message": issue.message,
                "releaseTag": repo.latest_release.as_ref().map(|r| r.tag.clone()),
                "releaseUrl": repo.latest_release.as_ref().and_then(|r| r.url.clone()),
                "runUrl": repo.latest_run.as_ref().and_then(|r| r.url.clone()),
                "runName": repo.latest_run.as_ref().map(|r| r.name.clone()),
                "runConclusion": repo.latest_run.as_ref().and_then(|r| r.conclusion.clone()),
                "runStatus": repo.latest_run.as_ref().map(|r| r.status.clone()),
            }));
        }
    }
    issues.sort_by(|a, b| {
        let sev = |v: &Value| match v.get("severity").and_then(|x| x.as_str()) {
            Some("error") => 0,
            Some("warn") => 1,
            _ => 2,
        };
        sev(a).cmp(&sev(b)).then_with(|| {
            a.get("repo")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .cmp(b.get("repo").and_then(|x| x.as_str()).unwrap_or(""))
        })
    });

    let mut builds = Vec::new();
    for repo in repos {
        for run in &repo.recent_runs {
            builds.push(json!({
                "repo": repo.name,
                "id": run.id,
                "name": run.name,
                "status": run.status,
                "conclusion": run.conclusion,
                "branch": run.branch,
                "createdAt": run.created_at,
                "url": run.url,
                "event": run.event,
            }));
        }
    }
    builds.sort_by(|a, b| {
        b.get("createdAt")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .cmp(a.get("createdAt").and_then(|x| x.as_str()).unwrap_or(""))
    });
    builds.truncate(40);

    let mut releases = Vec::new();
    for repo in repos {
        if let Some(rel) = &repo.latest_release {
            releases.push(json!({
                "repo": repo.name,
                "tag": rel.tag,
                "name": rel.name,
                "publishedAt": rel.published_at,
                "draft": rel.draft,
                "prerelease": rel.prerelease,
                "url": rel.url,
                "assetCount": rel.asset_count,
                "downloads": rel.downloads,
            }));
        }
    }
    releases.sort_by(|a, b| {
        b.get("publishedAt")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .cmp(a.get("publishedAt").and_then(|x| x.as_str()).unwrap_or(""))
    });
    releases.truncate(40);

    (issues, builds, releases)
}

pub fn fetch_current_totals<F>(mut on_progress: F) -> Result<FetchTotals, String>
where
    F: FnMut(serde_json::Value),
{
    let repos = list_repos()?;
    let mut results = Vec::new();
    let mut health_repos = Vec::new();
    let mut stars = 0u64;
    let mut downloads = 0u64;
    let total = repos.len();

    for (i, repo_val) in repos.iter().enumerate() {
        let name = repo_val
            .get("nameWithOwner")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let repo_stars = repo_val
            .get("stargazerCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        on_progress(serde_json::json!({
            "phase": "releases",
            "current": i + 1,
            "total": total,
            "repo": name
        }));

        let (repo_downloads, latest_release) = fetch_release_summary(&name);
        let recent_runs = fetch_recent_runs(&name);
        let latest_run = recent_runs.first().cloned();
        let issues = classify_issues(&latest_release, &recent_runs);

        stars += repo_stars;
        downloads += repo_downloads;
        results.push(RepoTotals {
            name: name.clone(),
            stars: repo_stars,
            downloads: repo_downloads,
        });
        health_repos.push(RepoHealth {
            name: name.clone(),
            stars: repo_stars,
            downloads: repo_downloads,
            latest_release,
            latest_run,
            recent_runs,
            issues,
        });

        if i + 1 < total {
            std::thread::sleep(Duration::from_millis(RELEASE_DELAY_MS));
        }
    }

    results.sort_by(|a, b| {
        b.downloads
            .cmp(&a.downloads)
            .then_with(|| b.stars.cmp(&a.stars))
    });
    health_repos.sort_by(|a, b| {
        b.downloads
            .cmp(&a.downloads)
            .then_with(|| b.stars.cmp(&a.stars))
    });

    let (issues, builds, releases) = build_health_views(&health_repos);
    let health = HealthSnapshot {
        fetched_at: chrono::Utc::now().timestamp_millis(),
        repos: health_repos,
        issues,
        builds,
        releases,
    };

    Ok(FetchTotals {
        repos: results,
        totals: Totals { stars, downloads },
        health,
    })
}

pub fn health_path(user_data: &Path) -> PathBuf {
    user_data.join("health-latest.json")
}

pub fn save_health(user_data: &Path, health: &HealthSnapshot) -> Result<(), String> {
    let text = serde_json::to_string_pretty(health).map_err(|e| e.to_string())?;
    std::fs::write(health_path(user_data), text).map_err(|e| e.to_string())
}

pub fn load_health(user_data: &Path) -> Option<HealthSnapshot> {
    let text = std::fs::read_to_string(health_path(user_data)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn empty_health() -> HealthSnapshot {
    HealthSnapshot {
        fetched_at: 0,
        repos: vec![],
        issues: vec![],
        builds: vec![],
        releases: vec![],
    }
}

pub fn fetch_star_history<F>(repo: &str, mut on_progress: F) -> Result<StarHistory, String>
where
    F: FnMut(serde_json::Value),
{
    let mut daily = serde_json::Map::new();
    let mut page = 1u32;
    let mut fetched = 0u64;

    loop {
        let api = format!("repos/{repo}/stargazers?per_page=100&page={page}");
        let stdout = run_gh(
            &[
                "api",
                &api,
                "-H",
                "Accept: application/vnd.github.v3.star+json",
                "--jq",
                ".[] | .starred_at",
            ],
            60,
        )?;
        let dates: Vec<&str> = stdout
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        if dates.is_empty() {
            break;
        }
        for starred_at in &dates {
            let day = starred_at.get(0..10).unwrap_or(starred_at);
            let entry = daily.entry(day.to_string()).or_insert(Value::from(0u64));
            let n = entry.as_u64().unwrap_or(0) + 1;
            *entry = Value::from(n);
            fetched += 1;
        }
        on_progress(serde_json::json!({
            "phase": "stars",
            "repo": repo,
            "page": page,
            "fetched": fetched
        }));
        if dates.len() < 100 {
            break;
        }
        page += 1;
        std::thread::sleep(Duration::from_millis(STAR_PAGE_DELAY_MS));
    }

    Ok(StarHistory {
        repo: repo.to_string(),
        fetched_at: chrono::Utc::now().timestamp_millis(),
        daily,
        total_stars: fetched,
    })
}

pub fn star_history_dir(user_data: &Path) -> PathBuf {
    let dir = user_data.join("star-history");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn safe_repo_file(repo: &str) -> String {
    repo.replace(['/', '\\'], "--")
}

pub fn save_star_history(user_data: &Path, data: &StarHistory) -> Result<(), String> {
    let file = star_history_dir(user_data).join(format!("{}.json", safe_repo_file(&data.repo)));
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    std::fs::write(file, text).map_err(|e| e.to_string())
}

pub fn load_star_history(user_data: &Path, repo: &str) -> Option<StarHistory> {
    let file = star_history_dir(user_data).join(format!("{}.json", safe_repo_file(repo)));
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn load_all_star_histories(
    user_data: &Path,
    repos: &[String],
) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    for name in repos {
        if let Some(hist) = load_star_history(user_data, name) {
            if let Ok(v) = serde_json::to_value(hist) {
                out.insert(name.clone(), v);
            }
        }
    }
    out
}
