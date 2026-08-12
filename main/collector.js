const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { buildProcessEnv, whichExecutable } = require('./env');
const logger = require('./logger');

const execFileAsync = promisify(execFile);

const RELEASE_DELAY_MS = 200;
const STAR_PAGE_DELAY_MS = 150;
const STAR_HISTORY_HEADER = 'Accept: application/vnd.github.v3.star+json';
const DEFAULT_GH_TIMEOUT_MS = 45_000;
const AUTH_TIMEOUT_MS = 20_000;

let resolvedGhPath = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ghCandidates() {
  return [
    resolvedGhPath,
    whichExecutable('gh'),
    process.platform === 'win32' ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : null,
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe')
      : null,
    process.platform === 'win32' ? 'gh.exe' : 'gh'
  ].filter(Boolean);
}

function resolveGhBinary() {
  if (resolvedGhPath) return resolvedGhPath;
  for (const candidate of ghCandidates()) {
    if (candidate.includes(path.sep) || candidate.includes('/') || candidate.includes('\\')) {
      if (fs.existsSync(candidate)) {
        resolvedGhPath = candidate;
        logger.info('Resolved gh binary', { path: candidate });
        return candidate;
      }
    }
  }
  const found = whichExecutable('gh');
  if (found) {
    resolvedGhPath = found;
    logger.info('Resolved gh via PATH', { path: found });
    return found;
  }
  logger.warn('gh binary not found in PATH or common install locations');
  return process.platform === 'win32' ? 'gh.exe' : 'gh';
}

function clearGhCache() {
  resolvedGhPath = null;
}

async function runGh(args, options = {}) {
  const bin = resolveGhBinary();
  const timeout = options.timeout ?? DEFAULT_GH_TIMEOUT_MS;
  const env = buildProcessEnv();
  const started = Date.now();

  logger.debug('gh exec start', { bin, args, timeout });

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout,
      env: {
        ...env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GH_PROMPT_DISABLED: '1'
      },
      windowsHide: true
    });
    const ms = Date.now() - started;
    if (stderr?.trim()) {
      logger.debug('gh stderr', { args: args.slice(0, 3), stderr: stderr.trim().slice(0, 500) });
    }
    logger.debug('gh exec ok', { ms, bytes: stdout?.length || 0 });
    return stdout;
  } catch (err) {
    const ms = Date.now() - started;
    const code = err.code;
    const killed = err.killed;
    const msg = err.message || String(err);
    logger.error('gh exec failed', {
      bin,
      args: args.slice(0, 4),
      ms,
      code,
      killed,
      message: msg.slice(0, 500)
    });
    if (code === 'ENOENT') {
      clearGhCache();
      throw new Error(`gh not found (${bin}). Install GitHub CLI or ensure it is on PATH.`);
    }
    if (killed || /timed out/i.test(msg)) {
      throw new Error(`gh timed out after ${timeout}ms: ${args.slice(0, 3).join(' ')}`);
    }
    throw err;
  }
}

async function checkAuth() {
  logger.info('checkAuth start');
  const started = Date.now();
  try {
    const user = (await runGh(['api', 'user', '-q', '.login'], { timeout: AUTH_TIMEOUT_MS })).trim();
    const ms = Date.now() - started;
    if (!user) {
      logger.warn('checkAuth empty user response');
      return { ok: false, error: 'gh returned empty user — run: gh auth login', ms };
    }
    logger.info('checkAuth ok', { user, ms });
    return { ok: true, user, ms };
  } catch (err) {
    const ms = Date.now() - started;
    const message = err.message || String(err);
    logger.error('checkAuth failed', { message, ms });
    return { ok: false, error: message, ms };
  }
}

const REQUIRED_REPO_JSON_FIELDS = ['nameWithOwner', 'stargazerCount'];
const DEFAULT_REPO_LIST_QUERY =
  'repo list --visibility public --limit 1000 --json nameWithOwner,stargazerCount,updatedAt';

function splitCommandArgs(input) {
  const args = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(input || ''))) !== null) {
    if (match[1] != null) args.push(match[1].replace(/\\(.)/g, '$1'));
    else if (match[2] != null) args.push(match[2].replace(/\\(.)/g, '$1'));
    else args.push(match[3]);
  }
  return args;
}

function ensureRepoListArgs(query) {
  let args = splitCommandArgs(String(query || '').trim().replace(/^gh\s+/i, ''));
  if (!args.length) args = splitCommandArgs(DEFAULT_REPO_LIST_QUERY);

  if (args[0] !== 'repo') args = ['repo', ...args];
  if (args[1] !== 'list') args = [args[0], 'list', ...args.slice(1)];

  let jsonIdx = args.indexOf('--json');
  const fields = new Set(REQUIRED_REPO_JSON_FIELDS);
  if (jsonIdx >= 0 && args[jsonIdx + 1] && !String(args[jsonIdx + 1]).startsWith('-')) {
    for (const f of String(args[jsonIdx + 1]).split(',')) {
      const name = f.trim();
      if (name) fields.add(name);
    }
    args[jsonIdx + 1] = [...fields].join(',');
  } else {
    if (jsonIdx >= 0) args.splice(jsonIdx, 1);
    args.push('--json', [...fields].join(','));
  }

  return args;
}

async function listRepos(query = DEFAULT_REPO_LIST_QUERY) {
  const args = ensureRepoListArgs(query);
  logger.info('listRepos start', { query: args.join(' ') });
  const stdout = await runGh(args);
  const repos = JSON.parse(stdout);
  if (!Array.isArray(repos)) {
    throw new Error('gh repo list did not return a JSON array — check --json fields');
  }
  logger.info('listRepos ok', { count: repos.length });
  return repos;
}

async function getReleaseDownloadTotal(repo) {
  try {
    const stdout = await runGh([
      'api', `repos/${repo}/releases`, '--paginate',
      '--jq', '[.[].assets[].download_count] | add // 0'
    ], { timeout: 60_000 });
    let total = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const n = parseInt(line.trim(), 10);
      if (Number.isFinite(n)) total += n;
    }
    return total;
  } catch (err) {
    logger.warn('release downloads failed', { repo, message: err.message });
    return 0;
  }
}

async function fetchCurrentTotals(onProgress, options = {}) {
  const repos = await listRepos(options.repoListQuery || DEFAULT_REPO_LIST_QUERY);
  const results = [];
  let stars = 0;
  let downloads = 0;

  logger.info('fetchCurrentTotals start', { repos: repos.length });

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i].nameWithOwner;
    const repoStars = repos[i].stargazerCount || 0;
    const repoDownloads = await getReleaseDownloadTotal(repo);
    stars += repoStars;
    downloads += repoDownloads;
    results.push({ name: repo, stars: repoStars, downloads: repoDownloads });
    if (onProgress) {
      onProgress({
        phase: 'releases',
        current: i + 1,
        total: repos.length,
        repo
      });
    }
    if (i < repos.length - 1) await delay(RELEASE_DELAY_MS);
  }

  logger.info('fetchCurrentTotals done', { stars, downloads, repos: repos.length });

  return {
    repos: results.sort((a, b) => b.downloads - a.downloads || b.stars - a.stars),
    totals: { stars, downloads }
  };
}

function dateKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function fetchStarHistory(repo, onProgress) {
  logger.info('fetchStarHistory start', { repo });
  const daily = {};
  let page = 1;
  let fetched = 0;

  while (true) {
    const stdout = await runGh([
      'api', `repos/${repo}/stargazers?per_page=100&page=${page}`,
      '-H', STAR_HISTORY_HEADER,
      '--jq', '.[] | .starred_at'
    ], { timeout: 60_000 });
    const dates = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!dates.length) break;

    for (const starredAt of dates) {
      const day = starredAt.slice(0, 10);
      daily[day] = (daily[day] || 0) + 1;
      fetched += 1;
    }

    if (onProgress) {
      onProgress({ phase: 'stars', repo, page, fetched });
    }

    if (dates.length < 100) break;
    page += 1;
    await delay(STAR_PAGE_DELAY_MS);
  }

  logger.info('fetchStarHistory done', { repo, fetched, days: Object.keys(daily).length });
  return { repo, fetchedAt: Date.now(), daily, totalStars: fetched };
}

function starHistoryDir(userDataPath) {
  const dir = path.join(userDataPath, 'star-history');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeRepoFile(repo) {
  return repo.replace(/[/\\]/g, '--');
}

function loadStarHistory(userDataPath, repo) {
  const file = path.join(starHistoryDir(userDataPath), `${safeRepoFile(repo)}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveStarHistory(userDataPath, data) {
  const file = path.join(starHistoryDir(userDataPath), `${safeRepoFile(data.repo)}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadAllStarHistories(userDataPath, repos) {
  const out = {};
  for (const r of repos) {
    const name = r.name || r;
    const hist = loadStarHistory(userDataPath, name);
    if (hist) out[name] = hist;
  }
  return out;
}

module.exports = {
  DEFAULT_REPO_LIST_QUERY,
  ensureRepoListArgs,
  checkAuth,
  listRepos,
  fetchCurrentTotals,
  fetchStarHistory,
  loadStarHistory,
  saveStarHistory,
  loadAllStarHistories,
  resolveGhBinary,
  clearGhCache,
  dateKey,
  RELEASE_DELAY_MS
};
