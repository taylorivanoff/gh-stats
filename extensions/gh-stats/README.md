# gh-stats gh CLI extension

Install as a [GitHub CLI extension](https://cli.github.com/manual/gh_extension):

```bash
gh extension install taylorivanoff/gh-stats/extensions/gh-stats
```

Or from a local clone:

```bash
gh extension install ./extensions/gh-stats
```

## Usage

```bash
gh stats status          # Portfolio KPIs
gh stats fetch           # Pull latest data
gh stats history         # Backfill star timelines
gh stats export --format csv --output repos.csv
gh stats serve --port 3847
```

Requires the `gh-stats-cli` binary on PATH or built locally (`cargo build --release -p gh-stats-cli`).
