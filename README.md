# GhStats - GitHub Stars & Downloads Analytics

[![Release](https://img.shields.io/github/v/release/taylorivanoff/gh-stats)](https://github.com/taylorivanoff/gh-stats/releases)
[![Downloads](https://img.shields.io/github/downloads/taylorivanoff/gh-stats/total)](https://github.com/taylorivanoff/gh-stats/releases)
[![Stars](https://img.shields.io/github/stars/taylorivanoff/gh-stats)](https://github.com/taylorivanoff/gh-stats/stargazers)
[![License](https://img.shields.io/github/license/taylorivanoff/gh-stats)](LICENSE)
[![Live Demo](https://img.shields.io/badge/demo-live-blue)](https://taylorivanoff.github.io/gh-stats/)

**GhStats** is an open-source, cross-platform **desktop analytics platform** for your GitHub repositories. Track stars, release downloads, GitHub traffic, npm/PyPI stats, and CI/release health - totals, daily deltas, and rolling windows stored entirely on your machine.

Ideal for indie developers who want a lightweight **Google Analytics–style view** of GitHub engagement without shipping data to a third party.

## Features

### Analytics
- KPI strip: stars, downloads, npm/PyPI, views/clones, today/7d/30d windows
- Time ranges: **7d · 30d · 90d · All**
- Charts: new stars, download deltas, cumulative stars, total downloads
- **Traffic tab**: page views, clones, top referrers - preserved beyond GitHub's 14-day limit
- Per-repo table with registry download stats

### Health triage
- Attention panel: failed CI, missing assets, draft releases, no releases
- Recent builds and releases with copy-paste triage notes

### Platform
- **Desktop app** (Tauri 2): Windows, macOS, Linux - tray icon, auto-fetch, updater
- **CLI** (`gh-stats`): fetch, history, status, export, serve
- **GitHub Action**: daily snapshot collection to `.gh-stats/`
- **Web export**: static dashboard for GitHub Pages

### Onboarding
- Demo data on first launch so charts render immediately
- Auto star-history backfill in the background after first fetch
- First-run wizard

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) - install and sign in from the app header, or run `gh auth login`

## Installation

### Windows

1. Download the latest installer from [Releases](https://github.com/taylorivanoff/gh-stats/releases)
2. Or: `winget install taylorivanoff.gh-stats` (see [packaging/winget](packaging/winget/))

### macOS

1. Download the `.dmg` from [Releases](https://github.com/taylorivanoff/gh-stats/releases)
2. Or: `brew install --cask ghstats` (see [packaging/homebrew](packaging/homebrew/))

### Linux

1. Download `.AppImage` or `.deb` from [Releases](https://github.com/taylorivanoff/gh-stats/releases)
2. Install `gh` via your package manager

### CLI only

```bash
# From releases (Linux x86_64)
curl -fsSL -o gh-stats https://github.com/taylorivanoff/gh-stats/releases/latest/download/gh-stats-linux-x86_64
chmod +x gh-stats && sudo mv gh-stats /usr/local/bin/

# Or build from source
cargo build --release -p gh-stats-cli
```

### gh CLI extension

```bash
gh extension install taylorivanoff/gh-stats/extensions/gh-stats
gh stats status
```

## Development

```bash
bun install
bun run start
```

Requires [tauri-tray-base](https://github.com/taylorivanoff/tauri-tray-base) checked out as a sibling directory.

```bash
bun run release    # Build desktop installers
cargo run -p gh-stats-cli -- status   # CLI
bun run lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details.

## Usage

1. Sign in with `gh auth login` if needed
2. Launch GhStats and click Refresh to pull your real GitHub data
3. Use range tabs and view tabs (**Analytics · Traffic · Health**)
4. Star history backfills automatically; use **History** to force a refresh
5. Export: `gh-stats-cli export --format site --output ./dashboard`

## Data collection

| Metric | Source | Notes |
| --- | --- | --- |
| Stars | `gh repo list` | Configurable visibility: public, private, all |
| Release downloads | `gh api repos/{repo}/releases` | Summed asset download counts |
| GitHub traffic | `gh api repos/{repo}/traffic/*` | Snapshotted daily - preserved beyond 14 days |
| npm / PyPI / crates.io | Public registry APIs | Auto-detected from repo manifests |
| CI / releases | `gh api actions/runs`, releases | Health triage panels |
| Star history | `gh api stargazers` | On-demand or auto backfill |

Logs: `%APPDATA%/gh-stats/logs/` (Windows), `~/Library/Application Support/gh-stats/` (macOS), `~/.local/share/gh-stats/` (Linux).

## GitHub Action

Daily snapshots are collected by [`.github/workflows/collect.yml`](.github/workflows/collect.yml), which runs the local action at [`action/`](action/).

```yaml
- uses: taylorivanoff/gh-stats/action@master
  with:
    visibility: public
    commit-snapshots: 'true'
    include-traffic: 'true'
    github-token: ${{ secrets.GH_STATS_TOKEN }}
```

`GITHUB_TOKEN` only sees the current repository. Use a PAT (`GH_STATS_TOKEN`) with `repo` scope to collect your full public (or private) portfolio and traffic.

## Keywords

GitHub analytics, stars over time, release downloads, gh CLI dashboard, Tauri desktop app, local GitHub stats, repository metrics, traffic preservation

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
