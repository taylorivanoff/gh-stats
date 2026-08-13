#!/usr/bin/env node
/**
 * Bump the workspace version (Cargo.toml [workspace.package]), then mirror
 * it into package.json. Tauri reads the Cargo package version; member crates
 * inherit via version.workspace = true.
 *
 * Usage:
 *   bun run bump
 *   bun run bump -- minor
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const cargoPath = path.join(root, 'Cargo.toml');
const pkgPath = path.join(root, 'package.json');
const level = (process.argv[2] || 'patch').toLowerCase();

if (!['patch', 'minor', 'major'].includes(level)) {
  console.error(`Invalid bump level "${level}". Use patch, minor, or major.`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
}

function runCapture(cmd) {
  return run(cmd, { silent: true }).trim();
}

function readWorkspaceVersion() {
  const text = fs.readFileSync(cargoPath, 'utf8');
  const match = text.match(/\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
  if (!match) throw new Error('Could not find [workspace.package] version in Cargo.toml');
  return match[1];
}

function writeWorkspaceVersion(version) {
  let text = fs.readFileSync(cargoPath, 'utf8');
  text = text.replace(
    /(\[workspace\.package\][\s\S]*?)^version = "[^"]+"/m,
    `$1version = "${version}"`
  );
  fs.writeFileSync(cargoPath, text);
}

function bumpSemver(version, kind) {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Invalid semver "${version}"`);
  }
  if (kind === 'major') return `${parts[0] + 1}.0.0`;
  if (kind === 'minor') return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function writePackageJsonVersion(version) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function writePackagingVersions(version) {
  const brew = path.join(root, 'packaging', 'homebrew', 'GhStats.rb');
  if (fs.existsSync(brew)) {
    let text = fs.readFileSync(brew, 'utf8');
    text = text.replace(/^version: .*$/m, `version: ${version}`);
    fs.writeFileSync(brew, text);
  }

  const winget = path.join(root, 'packaging', 'winget', 'taylorivanoff.gh-stats.yaml');
  if (fs.existsSync(winget)) {
    let text = fs.readFileSync(winget, 'utf8');
    text = text.replace(/^PackageVersion: .*$/m, `PackageVersion: ${version}`);
    text = text.replace(/\/download\/v[\d.]+/g, `/download/v${version}`);
    text = text.replace(/GhStats_[\d.]+_/g, `GhStats_${version}_`);
    fs.writeFileSync(winget, text);
  }
}

const branch = runCapture('git rev-parse --abbrev-ref HEAD');
if (branch !== 'master' && branch !== 'main') {
  console.error(`Must be on master/main (currently on ${branch}).`);
  process.exit(1);
}

const status = runCapture('git status --porcelain');
if (status) {
  console.error('Working tree is not clean. Commit or stash changes first, then bump.');
  console.error(status);
  process.exit(1);
}

runCapture('git fetch origin');
const behind = runCapture(`git rev-list --count HEAD..origin/${branch}`);
if (behind !== '0') {
  console.error(`Local ${branch} is behind origin/${branch}. Pull first.`);
  process.exit(1);
}

const oldVersion = readWorkspaceVersion();
const newVersion = bumpSemver(oldVersion, level);
writeWorkspaceVersion(newVersion);
writePackageJsonVersion(newVersion);
writePackagingVersions(newVersion);

const toAdd = ['Cargo.toml', 'package.json'];
for (const extra of [
  'packaging/homebrew/GhStats.rb',
  'packaging/winget/taylorivanoff.gh-stats.yaml',
  'bun.lock'
]) {
  if (fs.existsSync(path.join(root, extra))) toAdd.push(extra);
}

run(`git add -- ${toAdd.join(' ')}`);
run(`git commit -m "chore: bump version to ${newVersion}"`);
run(`git push origin ${branch}`);

console.log(`\nBumped ${oldVersion} → ${newVersion} and pushed to ${branch}.`);
console.log('GitHub Actions will build and publish the release if the version changed.');
