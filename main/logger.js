const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 400;
const entries = [];
const listeners = new Set();
let seq = 0;
let logFilePath = null;

function setLogFile(filePath) {
  logFilePath = filePath;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

function timestamp() {
  return new Date().toISOString();
}

function writeFileLine(line) {
  if (!logFilePath) return;
  try {
    fs.appendFileSync(logFilePath, `${line}\n`, 'utf8');
  } catch (_) {}
}

/**
 * @param {'info'|'warn'|'error'|'debug'} level
 * @param {string} message
 * @param {Record<string, unknown>} [meta]
 */
function log(level, message, meta = {}) {
  const entry = {
    id: `log-${Date.now()}-${++seq}`,
    time: timestamp(),
    ts: Date.now(),
    level,
    message: String(message || ''),
    meta: meta && typeof meta === 'object' ? meta : {}
  };
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();

  const metaText = Object.keys(entry.meta).length
    ? ` ${JSON.stringify(entry.meta)}`
    : '';
  const line = `[${entry.time}] [${level}] ${entry.message}${metaText}`;

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  writeFileLine(line);

  for (const listener of listeners) {
    try {
      listener(entry);
    } catch (_) {}
  }
  return entry;
}

function getLogs(limit = 100) {
  return entries.slice(-limit);
}

function onLog(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = {
  setLogFile,
  log,
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
  debug: (msg, meta) => log('debug', msg, meta),
  getLogs,
  onLog,
  get logFilePath() { return logFilePath; }
};
