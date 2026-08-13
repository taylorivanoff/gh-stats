use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageStats {
    pub npm: Option<u64>,
    pub pypi: Option<u64>,
    pub crates_io: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct DetectedPackages {
    pub npm: Option<String>,
    pub pypi: Option<String>,
    pub crates_io: Option<String>,
}

pub fn fetch_package_stats(packages: &DetectedPackages) -> PackageStats {
    PackageStats {
        npm: packages
            .npm
            .as_deref()
            .and_then(fetch_npm_downloads),
        pypi: packages
            .pypi
            .as_deref()
            .and_then(fetch_pypi_downloads),
        crates_io: packages
            .crates_io
            .as_deref()
            .and_then(fetch_crate_downloads),
    }
}

fn fetch_npm_downloads(name: &str) -> Option<u64> {
    let url = format!("https://api.npmjs.org/downloads/point/last-month/{name}");
    let resp = ureq::get(&url)
        .set("Accept", "application/json")
        .call()
        .ok()?;
    let body: serde_json::Value = resp.into_json().ok()?;
    body.get("downloads")?.as_u64()
}

fn fetch_pypi_downloads(name: &str) -> Option<u64> {
    let url = format!("https://pypistats.org/api/packages/{name}/recent");
    let resp = ureq::get(&url)
        .set("Accept", "application/json")
        .call()
        .ok()?;
    let body: serde_json::Value = resp.into_json().ok()?;
    let data = body.get("data")?.as_object()?;
    let mut total = 0u64;
    for (_key, val) in data {
        if let Some(n) = val.as_u64() {
            total += n;
        }
    }
    if total > 0 {
        Some(total)
    } else {
        None
    }
}

fn fetch_crate_downloads(name: &str) -> Option<u64> {
    let url = format!("https://crates.io/api/v1/crates/{name}");
    let resp = ureq::get(&url)
        .set("Accept", "application/json")
        .set("User-Agent", "gh-stats/1.0 (https://github.com/taylorivanoff/gh-stats)")
        .call()
        .ok()?;
    let body: serde_json::Value = resp.into_json().ok()?;
    body.get("crate")?
        .get("downloads")?
        .as_u64()
}

pub fn detect_from_manifests(
    package_json: Option<&str>,
    pyproject: Option<&str>,
    cargo_toml: Option<&str>,
    _repo: &str,
) -> DetectedPackages {
    let mut detected = DetectedPackages::default();

    if let Some(content) = package_json {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(content) {
            if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
                if !name.is_empty() {
                    detected.npm = Some(name.to_string());
                }
            }
        }
    }

    if let Some(content) = pyproject {
        if let Some(name) = extract_toml_name(content) {
            detected.pypi = Some(name.replace('_', "-"));
        }
    }

    if let Some(content) = cargo_toml {
        if let Some(name) = extract_toml_name(content) {
            detected.crates_io = Some(name);
        }
    }

    detected
}

fn extract_toml_name(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("name = ") {
            let val = rest.trim().trim_matches('"').trim_matches('\'');
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}
