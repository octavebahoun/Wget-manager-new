'use strict';
// Configuration centralisée (lue depuis .env)
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const env = process.env;

const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback = false) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(String(value).trim());
const list = (value) =>
  String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// Découpe une chaîne d'arguments en respectant les guillemets ("a b" 'c d')
function splitArgs(value) {
  if (!value) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(value))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const DOWNLOADS_DIR = path.resolve(ROOT, env.DOWNLOADS_DIR || 'downloads');

module.exports = Object.freeze({
  VERSION: '4.0.0',
  ROOT,
  PORT: int(env.PORT, 3000),
  HOST: env.HOST || undefined,

  DOWNLOADS_DIR,
  // Fichiers temporaires : dossier caché (non listé, non servi)
  TMP_DIR: path.join(DOWNLOADS_DIR, '.wget-tmp'),
  STATE_FILE: path.resolve(ROOT, env.STATE_FILE || 'active_downloads.json'),
  LOG_FILE: path.resolve(ROOT, env.LOG_FILE || 'server.log'),

  // Sécurité
  ALLOWED_DOMAINS: list(env.ALLOWED_DOMAINS),
  ALLOWED_ORIGINS: list(env.ALLOWED_ORIGIN),
  API_KEY: env.API_KEY || null,
  TRUST_LOCALHOST: bool(env.TRUST_LOCALHOST, true),
  ALLOW_PRIVATE_NETWORKS: bool(env.ALLOW_PRIVATE_NETWORKS, false),

  // Téléchargements
  DOWNLOAD_TIMEOUT: int(env.DOWNLOAD_TIMEOUT, 14400), // secondes (0 = illimité)
  MAX_FILE_SIZE: env.MAX_FILE_SIZE ?? '5G', // "0" = illimité
  MAX_CONCURRENT_DOWNLOADS: Math.max(1, int(env.MAX_CONCURRENT_DOWNLOADS, 5)),
  RETRY_ATTEMPTS: Math.max(0, int(env.RETRY_ATTEMPTS, 2)),
  RETRY_DELAY: Math.max(0, int(env.RETRY_DELAY, 3000)),
  ARIA2_CONNECTIONS: clamp(int(env.ARIA2_CONNECTIONS, 16), 1, 16),
  YTDLP_FRAGMENTS: clamp(int(env.YTDLP_CONCURRENT_FRAGMENTS, 8), 1, 32),
  YTDLP_EXTRA_ARGS: splitArgs(env.YTDLP_EXTRA_ARGS),
  // Runtime JS pour yt-dlp (YouTube) : node fourni par défaut, "" pour désactiver
  YTDLP_JS_RUNTIME: env.YTDLP_JS_RUNTIME ?? `node:${process.execPath}`,
  // Conteneur final des vidéos (mp4 = compatible partout)
  MERGE_FORMAT: env.MERGE_FORMAT || 'mp4',
  JOBS_HISTORY_LIMIT: Math.max(10, int(env.JOBS_HISTORY_LIMIT, 100)),
  DELETE_AFTER_TRANSFER: bool(env.DELETE_AFTER_TRANSFER, true),

  DEBUG: bool(env.DEBUG),

  BIN: Object.freeze({
    aria2c: env.ARIA2C_PATH || 'aria2c',
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    ytdlp: env.YTDLP_PATH || 'yt-dlp',
  }),

  _splitArgs: splitArgs,
});
