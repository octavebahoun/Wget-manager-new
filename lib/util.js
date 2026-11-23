'use strict';
// Fonctions utilitaires pures (noms de fichiers, tailles, durées, lignes...)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const VIDEO_EXT = ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'ts', '3gp', 'ogv', 'mpg', 'mpeg'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba', 'wma', 'alac'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'];
const DOC_EXT = ['pdf', 'epub', 'txt', 'csv', 'json', 'xml', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'srt', 'vtt'];
const ARCHIVE_EXT = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'dmg', 'exe', 'msi', 'deb', 'rpm', 'apk', 'appimage', 'torrent'];
const KNOWN_EXT = new Set([...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT, ...DOC_EXT, ...ARCHIVE_EXT, 'm3u8', 'mpd', 'bin']);

const MIME_EXT = {
  'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
  'video/quicktime': 'mov', 'video/x-msvideo': 'avi', 'video/x-flv': 'flv', 'video/mp2t': 'ts',
  'video/3gpp': '3gp', 'video/ogg': 'ogv', 'video/mpeg': 'mpg', 'video/x-ms-wmv': 'wmv',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/webm': 'weba',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'application/zip': 'zip',
  'application/x-zip-compressed': 'zip', 'application/x-7z-compressed': '7z', 'application/vnd.rar': 'rar',
  'application/x-rar-compressed': 'rar', 'application/gzip': 'gz', 'application/x-gzip': 'gz',
  'application/x-tar': 'tar', 'application/epub+zip': 'epub', 'application/json': 'json',
  'application/vnd.android.package-archive': 'apk', 'application/x-msdownload': 'exe',
  'application/x-iso9660-image': 'iso', 'application/x-bittorrent': 'torrent', 'text/plain': 'txt',
  'text/csv': 'csv', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

function stripDiacritics(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

// Nom de fichier sûr : garde lettres/chiffres (unicode), retire accents et caractères dangereux
function sanitizeFilename(name, maxLen = 150) {
  if (name === undefined || name === null) return '';
  let s = stripDiacritics(String(name))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\p{L}\p{N}._\-()[\] ]+/gu, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._\-]+/, '')
    .replace(/[._\-]+$/, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[._\-]+$/, '');
  return s;
}

// Sépare base/extension uniquement si l'extension est connue ("www.site.com" garde son nom)
function splitExt(name) {
  const m = /^(.*?)\.([A-Za-z0-9]{1,9})$/.exec(String(name || ''));
  if (m && m[1] && KNOWN_EXT.has(m[2].toLowerCase())) return { base: m[1], ext: m[2].toLowerCase() };
  return { base: String(name || ''), ext: '' };
}

function extFromMime(mime) {
  if (!mime) return '';
  return MIME_EXT[String(mime).split(';')[0].trim().toLowerCase()] || '';
}

function extFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').pop() || '';
    return splitExt(decodeURIComponent(last)).ext;
  } catch {
    return '';
  }
}

function mediaCategory(name) {
  const { ext } = splitExt(name);
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (DOC_EXT.includes(ext)) return 'document';
  if (ARCHIVE_EXT.includes(ext)) return 'archive';
  return 'file';
}

// "a1b2c3d4e5f6..." ou "x_Yz-123..." : nom généré, peu parlant
function looksLikeHash(s) {
  const v = String(s || '');
  if (/^[0-9a-f_\-]{16,}$/i.test(v)) return true;
  return /^[A-Za-z0-9_\-]{24,}$/.test(v) && !/[_\-][a-z]{3,}/i.test(v);
}

const GENERIC_NAMES = new Set([
  'index', 'master', 'playlist', 'manifest', 'video', 'videoplayback', 'stream', 'media', 'chunklist',
  'prog_index', 'main', 'default', 'download', 'file', 'get', 'play', 'output', 'source', 'hls', 'dash',
]);
function isGenericName(base) {
  const b = String(base || '').toLowerCase();
  return !b || GENERIC_NAMES.has(b) || /^\d+$/.test(b) || b.length < 3;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${parseFloat((n / 1024 ** i).toFixed(2))} ${units[i]}`;
}

// "5G", "500M", "1.5GiB", "0" → octets (0 = illimité)
function parseSize(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Math.max(0, Math.round(value));
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(String(value));
  if (!m) return 0;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}

function truncate(str, max = 120) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Découpe un flux de données en lignes (\n, \r\n ou \r)
function lineSplitter(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split(/\r\n|\r|\n/);
    buffer = parts.pop();
    for (const p of parts) if (p.trim()) onLine(p);
    if (buffer.length > 65536) {
      onLine(buffer);
      buffer = '';
    }
  };
}

function isPathInside(baseDir, target) {
  const rel = path.relative(baseDir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function removePath(p) {
  try {
    await fsp.rm(p, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// Déplacement robuste (rename, ou copie si disques différents)
async function moveFile(src, dst) {
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dst);
    await fsp.unlink(src);
  }
}

// Trouve un nom libre : "nom.mp4", "nom_1.mp4"... (anyExt: ignore l'extension pour comparer)
async function uniqueBaseName(dir, base, ext = '', reserved = new Set(), anyExt = false) {
  let taken = new Set();
  try {
    const files = await fsp.readdir(dir);
    taken = new Set(files.map((f) => (anyExt ? splitExt(f).base : f).toLowerCase()));
  } catch { /* dossier absent */ }
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? base : `${base}_${i}`;
    const key = anyExt || !ext ? candidate : `${candidate}.${ext}`;
    if (reserved.has(candidate.toLowerCase()) || taken.has(key.toLowerCase())) continue;
    return candidate;
  }
  return `${base}_${Date.now()}`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Annulé'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(signal.reason || new Error('Annulé'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isLoopback(address) {
  if (!address) return false;
  const a = String(address).replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a);
}

// Retire \r \n (anti-injection d'en-têtes)
function cleanHeaderValue(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
}

module.exports = {
  VIDEO_EXT,
  AUDIO_EXT,
  KNOWN_EXT,
  sanitizeFilename,
  splitExt,
  extFromMime,
  extFromUrl,
  mediaCategory,
  looksLikeHash,
  isGenericName,
  formatBytes,
  parseSize,
  formatDuration,
  truncate,
  lineSplitter,
  isPathInside,
  exists,
  ensureDir,
  removePath,
  moveFile,
  uniqueBaseName,
  sleep,
  isLoopback,
  cleanHeaderValue,
};
