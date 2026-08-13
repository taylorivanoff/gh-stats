#!/usr/bin/env node
/**
 * Generate a shields.io badge URL from a GhStats dashboard JSON export.
 * Usage: node scripts/generate-badge.cjs [dashboard.json] [metric]
 * Metrics: stars, downloads, views, clones, npm, pypi
 */
const fs = require('fs');
const path = require('path');

const dashboardPath = process.argv[2] || '.gh-stats/dashboard.json';
const metric = (process.argv[3] || 'stars').toLowerCase();

const map = {
  stars: ['totalStars', 'stars', 'blue'],
  downloads: ['totalDownloads', 'downloads', 'orange'],
  views: ['views14d', 'views (14d)', 'blueviolet'],
  clones: ['clones14d', 'clones (14d)', 'blueviolet'],
  npm: ['npmDownloads', 'npm', 'red'],
  pypi: ['pypiDownloads', 'pypi', 'yellow'],
};

const [key, label, color] = map[metric] || map.stars;

let metrics = {};
try {
  const data = JSON.parse(fs.readFileSync(path.resolve(dashboardPath), 'utf8'));
  metrics = data.metrics || {};
} catch (e) {
  console.error(`Could not read ${dashboardPath}: ${e.message}`);
  process.exit(1);
}

const value = metrics[key] ?? 0;
const formatted = Number(value).toLocaleString('en-US');
const badgeUrl = `https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(formatted)}-${color}`;

console.log(badgeUrl);
console.log('');
console.log(`Markdown: ![${label}](${badgeUrl})`);
