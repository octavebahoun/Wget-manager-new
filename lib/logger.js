'use strict';
// Logger console + fichier (avec rotation simple à 5 Mo)
const fs = require('fs');
const config = require('./config');

const COLORS = {
  DEBUG: '\x1b[90m',
  INFO: '\x1b[36m',
  WARN: '\x1b[33m',
  ERROR: '\x1b[31m',
  SUCCESS: '\x1b[32m',
};
const MAX_LOG_SIZE = 5 * 1024 * 1024;
const TO_FILE = process.env.NODE_ENV !== 'test';

let stream = null;

function getStream() {
  if (stream) return stream;
  try {
    if (fs.statSync(config.LOG_FILE).size > MAX_LOG_SIZE) {
      fs.renameSync(config.LOG_FILE, `${config.LOG_FILE}.1`);
    }
  } catch { /* fichier absent */ }
  stream = fs.createWriteStream(config.LOG_FILE, { flags: 'a' });
  stream.on('error', (e) => console.error('Erreur écriture log:', e.message));
  return stream;
}

function serialize(data) {
  if (data === undefined || data === null || data === '') return '';
  if (typeof data === 'string') return data;
  if (data instanceof Error) return data.message;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function log(level, message, data) {
  if (level === 'DEBUG' && !config.DEBUG) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const extra = serialize(data);
  if (process.env.NODE_ENV !== 'test' || config.DEBUG) {
    console.log(`${ts} ${COLORS[level] || ''}[${level}]\x1b[0m ${message}${extra ? `\n  ↳ ${extra}` : ''}`);
  }
  if (TO_FILE) getStream().write(`${ts} [${level}] ${message}${extra ? ` | ${extra}` : ''}\n`);
}

module.exports = { log };
