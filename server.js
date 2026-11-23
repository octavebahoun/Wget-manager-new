'use strict';
// Web Wget Pro — serveur de téléchargement (aria2c + yt-dlp + ffmpeg)
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fsp = require('fs').promises;

const config = require('./lib/config');
const { log } = require('./lib/logger');
const { binaries, detectBinaries, ytdlpAgeDays } = require('./lib/tools');
const { JobManager } = require('./lib/jobs');
const { analyze } = require('./lib/analyze');
const { checkUrl } = require('./lib/net');
const { normalizeUrl, extractUrl } = require('./lib/detect');
const { normalizeCookieJar } = require('./lib/cookies');
const util = require('./lib/util');

const app = express();
const jobs = new JobManager();
const serverOrigins = new Set();
let server = null;

app.disable('x-powered-by');

// ================= SÉCURITÉ =================
function isAllowedOrigin(origin, req) {
  if (!origin) return true;
  if (/^(chrome|moz|safari-web)-extension:\/\//.test(origin)) return true;
  if (config.ALLOWED_ORIGINS.includes(origin.toLowerCase())) return true;
  if (serverOrigins.has(origin)) return true;
  const host = req.headers.host;
  return origin === `http://${host}` || origin === `https://${host}`;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthorized(req) {
  if (!config.API_KEY) return true;
  const key = req.get('x-api-key') || req.query.api_key;
  if (key && safeEqual(key, config.API_KEY)) return true;
  // Requêtes locales (même machine, sans proxy) : confiance par défaut
  return config.TRUST_LOCALHOST && util.isLoopback(req.socket.remoteAddress) && !req.get('x-forwarded-for');
}

function requireAuth(req, res, next) {
  if (isAuthorized(req)) return next();
  return res.status(401).json({ error: 'Clé API manquante ou invalide', authRequired: true });
}

app.use(cors((req, cb) => cb(null, { origin: isAllowedOrigin(req.headers.origin, req), maxAge: 600 })));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.use(express.json({ limit: '5mb' }));

if (config.DEBUG) {
  app.use((req, res, next) => {
    log('DEBUG', `${req.method} ${req.url}`);
    next();
  });
}

// ================= VALIDATION DES REQUÊTES =================
const QUALITY_RE = /^(best|audio|\d{3,4})$/;
const FORMAT_RE = /^[\w[\]<>=!*+/.,:?|&^$~()\- ]{1,200}$/;
const KIND_HINTS = new Set(['platform', 'hls', 'dash', 'stream', 'vimeo-json', 'direct', 'page']);
const FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'range', 'te', 'upgrade', 'expect',
  'keep-alive', 'proxy-authorization', 'proxy-connection', 'cookie', 'user-agent', 'referer', 'origin',
]);

function str(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function httpUrl(value) {
  const s = str(value, 8192);
  if (!s) return null;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function buildJobConfig(body, source) {
  const url = extractUrl(body.url);
  if (!url) return { error: 'URL manquante ou invalide' };
  const format = str(body.format, 200);
  if (format && !FORMAT_RE.test(format)) return { error: 'Format yt-dlp invalide' };
  const headers = {};
  if (body.headers && typeof body.headers === 'object') {
    for (const [k, v] of Object.entries(body.headers).slice(0, 20)) {
      if (/^[A-Za-z0-9-]{1,64}$/.test(k) && !FORBIDDEN_HEADERS.has(k.toLowerCase())) {
        headers[k] = util.cleanHeaderValue(v).slice(0, 4096);
      }
    }
  }
  const quality = QUALITY_RE.test(String(body.quality ?? '')) ? String(body.quality) : body.audioOnly ? 'audio' : 'best';
  const pageUrl = httpUrl(body.pageUrl);
  return {
    config: {
      url: normalizeUrl(url),
      customFilename: str(body.customFilename, 200),
      referer: httpUrl(body.referer) || pageUrl,
      origin: str(body.origin, 300),
      ua: str(body.ua, 600),
      cookies: str(body.cookies, 32768),
      cookieJar: normalizeCookieJar(body.cookieJar),
      headers,
      noCheckCert: !!body.noCheckCert,
      singleSegment: !!body.singleSegment,
      quality,
      format,
      playlist: !!body.playlist,
      subtitles: !!body.subtitles,
      pageUrl,
      title: str(body.title, 300),
      kind: KIND_HINTS.has(body.kind) ? body.kind : null,
      source: str(body.source, 30) || source,
    },
  };
}

// ================= SSE (temps réel) =================
const sseClients = new Set();

function broadcast(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(msg);
    } catch {
      sseClients.delete(res);
    }
  }
}

jobs.on('update', (info) => broadcast({ type: 'update', download: info }));
jobs.on('removed', (id) => broadcast({ type: 'removed', id }));
jobs.on('library-changed', () => broadcast({ type: 'library-changed' }));

setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}, 25000).unref();

app.get('/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  res.write(`data: ${JSON.stringify({ type: 'snapshot', downloads: jobs.list(), version: config.VERSION })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ================= INFOS =================
function binariesInfo() {
  return {
    aria2c: binaries.aria2c,
    ffmpeg: binaries.ffmpeg,
    ytdlp: binaries.ytdlp,
    ytdlpAgeDays: ytdlpAgeDays(),
  };
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: config.VERSION, jobs: jobs.counts(), maxConcurrent: config.MAX_CONCURRENT_DOWNLOADS, binaries: binariesInfo() });
});

app.get('/config', (req, res) => {
  res.json({
    version: config.VERSION,
    allowedDomains: config.ALLOWED_DOMAINS,
    maxFileSize: config.MAX_FILE_SIZE,
    downloadTimeout: config.DOWNLOAD_TIMEOUT,
    maxConcurrent: config.MAX_CONCURRENT_DOWNLOADS,
    retryAttempts: config.RETRY_ATTEMPTS,
    queueSize: jobs.queue.length,
    authRequired: !!config.API_KEY,
    authorized: isAuthorized(req),
    deleteAfterTransfer: config.DELETE_AFTER_TRANSFER,
    binaries: binariesInfo(),
  });
});

// ================= TÉLÉCHARGEMENTS =================
async function handleDownload(req, res) {
  const body = req.body || {};
  const source = req.path.includes('capture') ? 'extension' : 'web';
  const raw = Array.isArray(body.urls) ? body.urls : [body.url];
  const list = raw
    .flatMap((u) => String(u ?? '').split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 200);
  if (!list.length) return res.status(400).json({ error: 'URL manquante' });

  const created = [];
  const errors = [];
  for (const item of list) {
    const { config: cfg, error } = buildJobConfig({ ...body, url: item, customFilename: list.length === 1 ? body.customFilename : null }, source);
    if (error) {
      errors.push({ url: item, error, status: 400 });
      continue;
    }
    const check = await checkUrl(cfg.url);
    if (!check.ok) {
      log('WARN', `URL refusée: ${check.error}`, util.truncate(cfg.url, 120));
      errors.push({ url: item, error: check.error, status: check.status });
      continue;
    }
    const job = jobs.add(cfg);
    created.push({ id: job.id, url: cfg.url, status: job.info.status, queuePosition: jobs.queue.indexOf(job.id) + 1 });
  }

  if (!created.length) {
    const first = errors[0] || {};
    return res.status(first.status || 400).json({ error: first.error || 'Aucune URL valide', errors });
  }
  const first = created[0];
  return res.json({
    id: first.id,
    status: first.status,
    queuePosition: first.queuePosition,
    message: created.length > 1 ? `${created.length} téléchargements ajoutés` : 'Téléchargement ajouté à la file d\'attente',
    jobs: created,
    errors,
  });
}

app.post('/download', requireAuth, handleDownload);
app.post('/api/download', requireAuth, handleDownload);
app.post('/api/capture', requireAuth, handleDownload); // compatibilité extension v3

let analysesRunning = 0;
app.post('/api/analyze', requireAuth, async (req, res) => {
  const { config: cfg, error } = buildJobConfig(req.body || {}, 'analyze');
  if (error) return res.status(400).json({ error });
  if (analysesRunning >= 4) return res.status(429).json({ error: 'Trop d\'analyses en cours, réessayez dans un instant' });
  analysesRunning++;
  try {
    res.json(await analyze(cfg));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  } finally {
    analysesRunning--;
  }
});

app.get('/api/jobs', requireAuth, (req, res) => {
  let list = jobs.list();
  if (req.query.ids) {
    const ids = new Set(String(req.query.ids).split(','));
    list = list.filter((j) => ids.has(j.id));
  }
  res.json(list.slice(0, 300));
});

app.post('/cancel', requireAuth, (req, res) => {
  const id = str(req.body?.id, 100);
  if (!id) return res.status(400).json({ error: 'ID manquant' });
  const job = jobs.cancel(id);
  if (!job) return res.status(404).json({ error: 'Téléchargement introuvable' });
  res.json({ success: true, status: job.info.status, message: 'Annulation demandée' });
});

app.post('/cancel-all', requireAuth, (req, res) => {
  const cancelled = jobs.cancelAll();
  log('WARN', `Annulation de tous les téléchargements (${cancelled})`);
  res.json({ cancelled, message: `${cancelled} téléchargement(s) annulé(s)` });
});

app.post('/retry', requireAuth, (req, res) => {
  const job = jobs.retry(str(req.body?.id, 100) || '');
  if (!job) return res.status(404).json({ error: 'Rien à relancer (introuvable ou encore actif)' });
  res.json({ success: true, id: job.id });
});

app.delete('/api/jobs/:id', requireAuth, (req, res) => {
  if (!jobs.remove(req.params.id)) return res.status(409).json({ error: 'Introuvable ou encore en cours' });
  res.json({ success: true });
});

app.post('/api/jobs/clear', requireAuth, (req, res) => {
  res.json({ removed: jobs.clearFinished() });
});

// ================= BIBLIOTHÈQUE =================
const TEMP_FILE_RE = /\.(aria2|part|ytdl|tmp|temp)$|\.part-Frag\d+/i;

async function listLibrary() {
  const out = [];
  async function walk(dir, rel, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || TEMP_FILE_RE.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 2) await walk(abs, r, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = await fsp.stat(abs);
        out.push({
          id: r, filename: r, name: e.name, size: st.size, date: st.mtime,
          type: util.mediaCategory(e.name), status: 'completed', progress: 100,
        });
      } catch { /* supprimé entre-temps */ }
    }
  }
  await walk(config.DOWNLOADS_DIR, '', 0);
  return out.sort((a, b) => b.date - a.date);
}

function resolveLibraryPath(parts) {
  const segs = (Array.isArray(parts) ? parts : String(parts || '').split('/')).filter((s) => s !== '');
  if (!segs.length || segs.some((s) => s.startsWith('.') || s.includes('\0'))) return null;
  const abs = path.resolve(config.DOWNLOADS_DIR, ...segs);
  if (abs === config.DOWNLOADS_DIR || !util.isPathInside(config.DOWNLOADS_DIR, abs)) return null;
  return abs;
}

async function isFile(abs) {
  try {
    return (await fsp.stat(abs)).isFile();
  } catch {
    return false;
  }
}

// Suppression via lien seulement si la requête ne vient pas d'un autre site (anti-CSRF)
function crossSiteSafe(req) {
  const site = req.get('sec-fetch-site');
  return !site || site === 'same-origin' || site === 'none';
}

app.get('/history', requireAuth, async (req, res) => {
  try {
    res.json(await listLibrary());
  } catch (e) {
    log('ERROR', 'Erreur lecture bibliothèque', e.message);
    res.status(500).json({ error: 'Impossible de lire la bibliothèque' });
  }
});
app.get('/api/library', requireAuth, async (req, res) => res.json(await listLibrary()));

// Téléchargement vers le PC (sans suppression)
app.get('/dl/*path', requireAuth, async (req, res) => {
  const abs = resolveLibraryPath(req.params.path);
  if (!abs || !(await isFile(abs))) return res.status(404).json({ error: 'Fichier introuvable' });
  res.download(abs, path.basename(abs));
});

// Récupérer puis supprimer du serveur
app.get('/transfer/*path', requireAuth, async (req, res) => {
  const abs = resolveLibraryPath(req.params.path);
  if (!abs || !(await isFile(abs))) return res.status(404).json({ error: 'Fichier introuvable' });
  res.download(abs, path.basename(abs), async (err) => {
    if (err) return;
    if (!config.DELETE_AFTER_TRANSFER || !crossSiteSafe(req)) return;
    try {
      await fsp.unlink(abs);
      log('INFO', `Fichier transféré puis supprimé: ${path.basename(abs)}`);
      broadcast({ type: 'library-changed' });
    } catch (e) {
      log('WARN', `Suppression impossible après transfert: ${path.basename(abs)}`, e.message);
    }
  });
});

app.delete('/files/*path', requireAuth, async (req, res) => {
  const abs = resolveLibraryPath(req.params.path);
  if (!abs || !(await isFile(abs))) return res.status(404).json({ error: 'Fichier introuvable' });
  await fsp.unlink(abs);
  log('INFO', `Fichier supprimé: ${path.relative(config.DOWNLOADS_DIR, abs)}`);
  broadcast({ type: 'library-changed' });
  res.json({ success: true });
});

app.delete('/clear-history', requireAuth, async (req, res) => {
  try {
    const files = await listLibrary();
    let deleted = 0;
    for (const f of files) {
      const abs = resolveLibraryPath(f.filename);
      if (!abs) continue;
      try {
        await fsp.unlink(abs);
        deleted++;
      } catch (e) {
        log('WARN', `Suppression impossible: ${f.filename}`, e.message);
      }
    }
    // Supprime les sous-dossiers devenus vides
    for (const e of await fsp.readdir(config.DOWNLOADS_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) await fsp.rmdir(path.join(config.DOWNLOADS_DIR, e.name)).catch(() => {});
    }
    log('INFO', `Bibliothèque vidée: ${deleted} fichier(s) supprimé(s)`);
    broadcast({ type: 'library-changed' });
    res.json({ deleted, message: `${deleted} fichier(s) supprimé(s)` });
  } catch (e) {
    log('ERROR', 'Erreur nettoyage bibliothèque', e.message);
    res.status(500).json({ error: 'Impossible de vider la bibliothèque' });
  }
});

// Lecture/streaming des fichiers (Range supporté → lecture vidéo dans le navigateur)
const RISKY_EXT = /\.(html?|xhtml|svg|xml|js|mjs)$/i;
app.use('/files', requireAuth, express.static(config.DOWNLOADS_DIR, {
  dotfiles: 'ignore',
  index: false,
  setHeaders: (res, filePath) => {
    if (RISKY_EXT.test(filePath)) {
      res.setHeader('Content-Security-Policy', 'sandbox');
      res.setHeader('Content-Disposition', 'attachment');
    }
  },
}));

// Interface web
app.use(express.static(path.join(config.ROOT, 'public'), { index: 'index.html' }));

// ================= ERREURS =================
app.use((req, res) => res.status(404).json({ error: 'Introuvable' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse' });
  log('ERROR', 'Erreur serveur', err.stack || err.message);
  if (res.headersSent) return res.end();
  return res.status(500).json({ error: 'Erreur interne du serveur' });
});

// ================= DÉMARRAGE =================
async function start() {
  await util.ensureDir(config.DOWNLOADS_DIR);
  await util.ensureDir(config.TMP_DIR);
  detectBinaries();
  await jobs.load();

  // Nettoie les dossiers temporaires orphelins (garde ceux des jobs à reprendre)
  for (const name of await fsp.readdir(config.TMP_DIR).catch(() => [])) {
    if (!jobs.jobs.has(name)) await util.removePath(path.join(config.TMP_DIR, name));
  }

  await new Promise((resolve, reject) => {
    server = app.listen(config.PORT, config.HOST, resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  for (const host of ['localhost', '127.0.0.1', '[::1]']) serverOrigins.add(`http://${host}:${port}`);
  log('SUCCESS', `Web Wget Pro v${config.VERSION} démarré sur http://localhost:${port}`);
  log('INFO', `Config : ${config.MAX_CONCURRENT_DOWNLOADS} téléchargements simultanés, ${config.ALLOWED_DOMAINS.length ? `${config.ALLOWED_DOMAINS.length} domaine(s) autorisé(s)` : 'tous domaines autorisés'}${config.API_KEY ? ', clé API active' : ''}`);
  const age = ytdlpAgeDays();
  if (age !== null && age > 60) {
    log('WARN', `yt-dlp date de ${age} jours : mettez-le à jour (pip install -U "yt-dlp[default]") sinon certains sites échoueront`);
  }
  jobs.schedule();
  return server;
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log('INFO', `Signal ${signal} reçu, arrêt propre…`);
  for (const res of sseClients) {
    try {
      res.end();
    } catch { /* ignore */ }
  }
  server?.close();
  await jobs.shutdown();
  process.exit(0);
}

process.on('unhandledRejection', (e) => log('ERROR', 'Promesse rejetée non gérée', e?.stack || String(e)));

if (require.main === module) {
  // SIGUSR2 = redémarrage nodemon : on arrête proprement les outils pour reprendre ensuite
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR2']) process.on(sig, () => shutdown(sig));
  start().catch((e) => {
    log('ERROR', 'Démarrage impossible', e.code === 'EADDRINUSE' ? `Le port ${config.PORT} est déjà utilisé` : e.message);
    process.exit(1);
  });
}

module.exports = { app, jobs, start, shutdown, buildJobConfig, listLibrary };
