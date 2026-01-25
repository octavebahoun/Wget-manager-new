require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

// ================= LOGGING =================
const LOG_LEVELS = {
  INFO: '\x1b[36m[INFO]\x1b[0m',
  WARN: '\x1b[33m[WARN]\x1b[0m',
  ERROR: '\x1b[31m[ERROR]\x1b[0m',
  SUCCESS: '\x1b[32m[SUCCESS]\x1b[0m'
};

async function log(level, message, data = null) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const logMessage = `${timestamp} ${LOG_LEVELS[level]} ${message}`;
  console.log(logMessage);
  if (data) console.log('  ↳', data);

  const logEntry = `${timestamp} [${level}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`;
  try {
    await fs.appendFile(path.join(__dirname, 'server.log'), logEntry, 'utf8');
  } catch (err) {
    console.error('Erreur écriture log:', err);
  }
}

// ================= CONFIG =================
const ALLOWED_DOMAINS = process.env.ALLOWED_DOMAINS ? process.env.ALLOWED_DOMAINS.split(",") : [];
const DOWNLOAD_TIMEOUT = parseInt(process.env.DOWNLOAD_TIMEOUT || "3600");
const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE || "5G";
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "5");
const RETRY_ATTEMPTS = parseInt(process.env.RETRY_ATTEMPTS || "2");
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || "3000");

// ================= MIDDLEWARE =================
app.use((req, res, next) => {
  console.log(`[DEBUG_REQ] ${req.method} ${req.url}`);
  next();
});
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static("public"));
app.use("/files", express.static("downloads"));

// Error handling middleware
app.use((err, req, res, next) => {
  log('ERROR', 'Erreur serveur', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// ================= STORAGE =================
const downloadsDir = path.join(__dirname, "downloads");
const STATE_FILE = path.join(__dirname, "active_downloads.json");
const HISTORY_FILE = path.join(__dirname, "history.json");
const RULES_FILE = path.join(__dirname, "rules.json");

let fileRules = {};

async function loadRules() {
  try {
    const content = await fs.readFile(RULES_FILE, 'utf8');
    fileRules = JSON.parse(content);
    log('SUCCESS', 'Règles de rangement chargées.');
  } catch (e) {
    if (e.code === 'ENOENT') {
      log('INFO', 'Aucun fichier de règles (rules.json) trouvé, rangement automatique désactivé.');
    } else {
      log('ERROR', 'Erreur chargement rules.json', { error: e.message });
    }
  }
}

// ================= DEPENDENCY CHECK =================
async function checkDependencies() {
  const dependencies = [
    { name: 'aria2c', flag: '--version' },
    { name: 'ffmpeg', flag: '-version' },
    { name: 'yt-dlp', flag: '--version' }
  ];
  const missing = [];

  log('INFO', 'Vérification des dépendances...');

  for (const { name, flag } of dependencies) {
    try {
      await new Promise((resolve, reject) => {
        exec(`${name} ${flag}`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      console.log(`  ✅ ${name} détecté`);
    } catch (e) {
      console.log(`  ❌ ${name} MANQUANT`);
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    log('WARN', `DEPENDENCES MANQUANTES: ${missing.join(', ')}. Certaines fonctionnalités seront indisponibles.`);
  } else {
    log('SUCCESS', 'Toutes les dépendances sont installées.');
  }
}

async function ensureDirectories() {
  try {
    await fs.access(downloadsDir);
  } catch {
    await fs.mkdir(downloadsDir, { recursive: true });
  }
}

// ================= STATE & PERSISTENCE =================
let activeDownloads = new Map(); // id -> { info, config, process, retryCount }
let downloadQueue = []; // Array of ids waiting to start
let historyList = []; // Persistent history
let clients = []; // SSE clients

function processQueue() {
  const runningCount = Array.from(activeDownloads.values()).filter(d =>
    d.info.status === 'downloading' || d.info.status === 'retrying'
  ).length;

  if (runningCount < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
    const nextId = downloadQueue.shift();
    log('INFO', `Dépilement file d'attente: démarrrage de ${nextId}`);
    startDownload(nextId);
    // Recursively check if we can start more
    processQueue();
  }
}

async function saveState() {
  const data = Array.from(activeDownloads.values()).map(dl => dl.info);
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log('ERROR', 'Erreur sauvegarde état:', e.message);
  }
}

async function saveHistory() {
  try {
    await fs.writeFile(HISTORY_FILE, JSON.stringify(historyList, null, 2));
  } catch (e) {
    log('ERROR', 'Erreur sauvegarde historique:', e.message);
  }
}

async function loadState() {
  // Load Active Downloads
  try {
    await fs.access(STATE_FILE);
    const content = await fs.readFile(STATE_FILE, 'utf8');
    const data = JSON.parse(content);

    data.forEach(info => {
      if (info.status === 'downloading' || info.status === 'retrying') {
        info.status = 'interrupted';
        info.error = 'Arrêt du serveur';
        info.speed = '0 KB/s';
        info.eta = '--';
      }
      activeDownloads.set(info.id, { info, process: null, retryCount: 0 });
    });

    log('INFO', `État restauré : ${activeDownloads.size} téléchargements actifs chargés`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log('ERROR', 'Erreur chargement état:', e.message);
    }
  }

  // Load History
  try {
    await fs.access(HISTORY_FILE);
    const histContent = await fs.readFile(HISTORY_FILE, 'utf8');
    historyList = JSON.parse(histContent);
    // Si format invalide ou tableau vide, on pourrait le réinitialiser, mais on laisse tel quel
    if (!Array.isArray(historyList)) historyList = [];
    log('INFO', `Historique restauré : ${historyList.length} entrées`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log('ERROR', 'Erreur chargement historique:', e.message);
    } else {
      historyList = [];
    }
  }
}

// ================= SSE =================
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const clientId = Date.now();
  clients.push({ id: clientId, res });

  // Envoyer l'état actuel au nouveau client
  const currentList = Array.from(activeDownloads.values()).map(dl => dl.info);
  currentList.forEach(info => {
    res.write(`data: ${JSON.stringify({ type: "update", download: info })}\n\n`);
  });

  req.on("close", () => {
    clients = clients.filter(c => c.id !== clientId);
  });
});

function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(c => {
    try {
      c.res.write(message);
    } catch (err) {
      log('WARN', 'Erreur broadcast SSE', { clientId: c.id });
    }
  });

  // Sauvegarder l'état sur changements importants
  if (data.type === 'status-change' ||
    (data.download && !['downloading'].includes(data.download.status))) {
    saveState();
  }
}

// ================= DOMAIN PROFILES =================
const DOMAIN_PROFILES = {
  "example.com": {
    referer: "https://example.com/",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    segments: 4
  }
};

function getDomainProfile(downloadUrl) {
  try {
    const host = new URL(downloadUrl).hostname;
    const domain = Object.keys(DOMAIN_PROFILES).find(d =>
      host === d || host.endsWith("." + d)
    );
    return domain ? DOMAIN_PROFILES[domain] : null;
  } catch {
    return null;
  }
}

function defaultUA(ua) {
  return ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
}

// ================= UTILITY FUNCTIONS =================
const FALLBACK_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce", "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce", "udp://tracker.moeking.me:6969/announce",
  "udp://exodus.desync.com:6969/announce", "udp://tracker.dler.org:6969/announce"
];
let BEST_TRACKERS = [...FALLBACK_TRACKERS];

async function fetchTrackers() {
  try {
    const response = await fetch('https://newtrackon.com/api/stable');
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const text = await response.text();
    const trackers = text.trim().split('\n\n').filter(Boolean);
    if (trackers.length > 5) {
      BEST_TRACKERS = trackers;
      log('SUCCESS', `Liste de trackers mise à jour: ${trackers.length} trackers chargés.`);
    }
  } catch (e) {
    log('WARN', 'Impossible de récupérer la liste de trackers, utilisation de la liste de secours.', { error: e.message });
  }
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 255);
}

function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function isAllowedProtocol(url) {
  if (url.startsWith("magnet:")) return true;
  try {
    const protocol = new URL(url).protocol;
    return ["http:", "https:"].includes(protocol);
  } catch {
    return false;
  }
}

function isDomainAllowed(url) {
  if (ALLOWED_DOMAINS.length === 0) return true;

  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_DOMAINS.some(domain =>
      hostname === domain || hostname.endsWith("." + domain)
    );
  } catch {
    return false;
  }
}

function isVideoPlatform(url) {
  const platforms = [
    'youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv'
  ];
  try {
    const hostname = new URL(url).hostname;
    return platforms.some(p => hostname.includes(p));
  } catch { return false; }
}

function isVideoPlatform(url) {
  const platforms = [
    'youtube.com/watch',
    'youtu.be/',
    'twitch.tv/',
    'vimeo.com/',
    'dailymotion.com/video',
    'facebook.com/watch',
    'instagram.com/p/',
    'tiktok.com/',
    'googlevideo.com' // direct Google video delivery links (videoplayback) - treat as video
  ];
  return platforms.some(platform => url.includes(platform));
}

// ================= ROUTES =================
app.get("/health", (req, res) => {
  res.json({
    status: 'ok',
    activeDownloads: activeDownloads.size,
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS
  });
});

app.get("/history", async (req, res) => {
  // Retourne l'historique persistent
  const sortedHistory = [...historyList].sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(sortedHistory);
});

app.get(/^\/transfer\/(.+)/, async (req, res) => {
  const relativePath = req.params[0];
  const filename = path.basename(relativePath);

  // Sécurité : s'assurer que le chemin ne remonte pas dans l'arborescence
  const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(downloadsDir, safePath);

  if (!fsSync.existsSync(filePath) || !filePath.startsWith(downloadsDir)) {
    return res.status(404).json({ error: "Fichier introuvable ou accès non autorisé" });
  }

  res.download(filePath, filename, async (err) => {
    if (!err) {
      try {
        await fs.unlink(filePath);
        log('INFO', `Fichier transféré et supprimé: ${filename}`);
      } catch (unlinkErr) {
        log('WARN', `Impossible de supprimer: ${filename}`, { error: unlinkErr.message });
      }
    }
  });
});

app.post("/cancel", async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: "ID manquant" });
  }

  log('INFO', `Demande d'annulation pour: ${id}`);
  const download = activeDownloads.get(id);

  if (!download) {
    log('WARN', `Téléchargement introuvable: ${id}`);
    return res.status(404).json({ error: "Téléchargement introuvable" });
  }

  try {
    if (download.process) {
      download.process.kill("SIGTERM");
    }

    // Nettoyage fichiers partiels
    const partialFiles = [
      path.join(downloadsDir, download.info.filename),
      path.join(downloadsDir, `${download.info.filename}.aria2`),
      path.join(downloadsDir, `${download.info.filename}.part`),
      path.join(downloadsDir, `${download.info.filename}.mp4.part`)
    ];

    setTimeout(async () => {
      for (const f of partialFiles) {
        try { await fs.unlink(f); } catch { }
      }
    }, 1000);

    download.info.status = "cancelled";
    broadcast({ type: "status-change", download: download.info });
    activeDownloads.delete(id);

    log('SUCCESS', `Téléchargement annulé: ${download.info.filename}`);
    res.json({ success: true, message: "Téléchargement annulé" });
  } catch (err) {
    log('ERROR', `Erreur annulation ${id}`, { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post("/cancel-all", async (req, res) => {
  log('WARN', `Annulation de tous les téléchargements (${activeDownloads.size} actifs)`);
  let cancelled = 0;

  activeDownloads.forEach((download, id) => {
    try {
      if (download.process) {
        download.process.kill("SIGTERM");
      }
      download.info.status = "cancelled";
      broadcast({ type: "status-change", download: download.info });
      cancelled++;
    } catch (err) {
      log('ERROR', `Erreur annulation ${id}`, { error: err.message });
    }
  });

  activeDownloads.clear();
  await saveState();

  log('SUCCESS', `${cancelled} téléchargements annulés`);
  res.json({ cancelled, message: `${cancelled} téléchargements annulés` });
});

app.delete("/clear-history", async (req, res) => {
  const keepFiles = req.query.keepFiles === 'true';
  try {
    let deletedCount = 0;

    if (!keepFiles) {
      // Suppression physique seulement si demandée
      await Promise.all(historyList.map(async (item) => {
        try {
          const paths = [
            path.join(downloadsDir, item.filename),
            path.join(downloadsDir, item.filename + '.mp4')
          ];
          for (const p of paths) {
            try { await fs.unlink(p); deletedCount++; } catch { }
          }
        } catch { }
      }));
    }

    const count = historyList.length;
    historyList = [];
    await saveHistory();

    log('INFO', `Historique nettoyé: ${count} entrées, ${deletedCount} fichiers supprimés (keepFiles=${keepFiles})`);
    res.json({ deleted: deletedCount, historyDeleted: count, message: `${deletedCount} fichiers supprimés, historique vidé` });
  } catch (err) {
    log('ERROR', 'Erreur nettoyage historique', { error: err.message });
    res.status(500).json({ error: "Impossible de nettoyer l'historique" });
  }
});

app.get("/config", (req, res) => {
  res.json({
    allowedDomains: ALLOWED_DOMAINS,
    maxFileSize: MAX_FILE_SIZE,
    downloadTimeout: DOWNLOAD_TIMEOUT,
    maxConcurrent: MAX_CONCURRENT_DOWNLOADS,
    retryAttempts: RETRY_ATTEMPTS,
    queueSize: downloadQueue.length
  });
});

app.post("/api/capture", async (req, res) => {
  const { url, type, tabId } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: "URL manquante" });
  }

  // Validation protocole & domaine
  if (!isAllowedProtocol(url) || !isDomainAllowed(url)) {
    return res.status(403).json({ error: "URL non autorisée" });
  }

  log('INFO', 'Flux capturé depuis extension', { type, url: url.substring(0, 120), tabId });

  // Heuristique :
  // - mp4 direct → aria2
  // - m3u8 / mpd → ffmpeg
  // - plateformes vidéo → yt-dlp

  const isStream = /\.(m3u8|mpd)(\?|$)/i.test(url);
  const isVideo = isVideoPlatform(url);

  // Délégation vers la route /download existante
  try {
    const resp = await fetch(`http://localhost:${PORT}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        ua: defaultUA(),
        singleSegment: isStream,
      })
    });

    const data = await resp.json();
    res.json({ ok: true, delegated: true, data });
  } catch (e) {
    log('ERROR', 'Échec délégation capture → download', { error: e.message });
    res.status(500).json({ error: 'Échec traitement capture' });
  }
});

app.post("/api/formats", async (req, res) => {
  const { url } = req.body;
  log('INFO', 'Demande /api/formats reçue', { url });

  if (!url || !isVideoPlatform(url)) {
    log('WARN', 'URL invalide pour /api/formats', { url });
    return res.status(400).json({ error: "URL de vidéo valide manquante" });
  }

  try {
    const command = 'yt-dlp'; // Utiliser le yt-dlp du PATH
    const args = ['--dump-json', '--batch-file', '-'];
    log('INFO', 'Exécution de yt-dlp via stdin', { command: `${command} ${args.join(' ')}` });

    const formatsJson = await new Promise((resolve, reject) => {
      const proc = spawn(command, args);
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => stdout += data);
      proc.stderr.on('data', (data) => stderr += data);

      proc.on('close', (code) => {
        log('INFO', 'yt-dlp terminé', { code });
        if (code !== 0) {
          log('ERROR', 'yt-dlp stderr', { stderr });
          return reject(new Error(stderr || `yt-dlp a quitté avec le code ${code}`));
        }
        log('INFO', 'yt-dlp stdout', { stdout: stdout.substring(0, 100) + '...' });
        resolve(stdout);
      });

      proc.stdin.write(url);
      proc.stdin.end();
    });

    const data = JSON.parse(formatsJson);
    const formats = data.formats.map(f => ({
      formatId: f.format_id,
      resolution: f.resolution,
      ext: f.ext,
      fps: f.fps,
      vcodec: f.vcodec,
      acodec: f.acodec,
      fileSize: f.filesize || f.filesize_approx,
      note: f.format_note,
    })).filter(f => f.vcodec !== 'none' || f.acodec !== 'none');

    res.json({ title: data.title, formats });

  } catch (e) {
    log('ERROR', 'Impossible de récupérer les formats', { error: e.message });
    res.status(500).json({ error: "Impossible de récupérer les formats pour cette URL" });
  }
});

// ================= DOWNLOAD LOGIC =================
function startDownload(id) {
  const download = activeDownloads.get(id);
  if (!download) return;

  const { url, filename, ua, referer, cookies, noCheckCert, singleSegment, forceVideo, formatCode } = download.config;
  let { retryCount } = download;
  const isVideo = !!forceVideo || isVideoPlatform(url);
  const isTorrent = url.startsWith("magnet:");

  download.info.status = 'downloading';
  download.info.startedAt = new Date().toISOString();
  broadcast({ type: "status-change", download: download.info });

  log('INFO', `Démarrage téléchargement: ${filename} (Retry: ${retryCount})`, {
    url: url.substring(0, 100),
    type: isVideo ? 'video' : isTorrent ? 'torrent' : url.match(/\.(m3u8|mpd)/i) ? 'stream' : 'direct'
  });

  let proc;
  let lastError = "";
  const isRetry = retryCount > 0;

  if (isVideo && !isTorrent) {
    // YT-DLP pour plateformes vidéo
    log('INFO', `Utilisation de yt-dlp${isRetry ? ' (retry ' + retryCount + ')' : ''}`);

    const format = formatCode || "bestvideo+bestaudio/best";
    const ytArgs = [
      "--newline", "--no-playlist", "--format", format,
      "--merge-output-format", "mp4", "--output", path.join(downloadsDir, `${filename}.mp4`),
      url
    ];
    if (cookies) ytArgs.push("--add-header", `Cookie: ${cookies}`);
    if (noCheckCert) ytArgs.push("--no-check-certificate");

    proc = spawn("yt-dlp", ytArgs);

    proc.stdout.on("data", d => {
      const line = d.toString();
      const progress = line.match(/(\d+\.?\d*)%/);
      const size = line.match(/of\s+(~?[0-9.]+[KMGTiB]+)/);
      const speed = line.match(/at\s+([0-9.]+[KMGTiB]+\/s)/);
      const eta = line.match(/ETA\s+([0-9:]+)/);

      if (progress) {
        download.info.progress = Math.min(100, Math.floor(parseFloat(progress[1])));
        if (size) download.info.fullSize = size[1];
        if (speed) download.info.speed = speed[1];
        if (eta) download.info.eta = eta[1];
        broadcast({ type: "update", download: download.info });
      }
    });
    proc.stderr.on("data", d => { lastError += d.toString(); });

  } else if (url.match(/\.(m3u8|mpd)/i) && !isTorrent) {
    // FFMPEG pour streams
    log('INFO', `Utilisation de ffmpeg${isRetry ? ' (retry ' + retryCount + ')' : ''}`);
    const ffmpegArgs = [
      "-headers", `User-Agent: ${defaultUA(ua)}\r\n`, "-i", url, "-c", "copy",
      "-bsf:a", "aac_adtstoasc", path.join(downloadsDir, `${filename}.mp4`)
    ];
    proc = spawn("ffmpeg", ffmpegArgs);

    proc.stderr.on("data", d => {
      const line = d.toString();
      const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
      if (timeMatch) {
        const totalSeconds = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseInt(timeMatch[3]);
        download.info.eta = `${totalSeconds}s encodées`;
        download.info.progress = Math.min(99, Math.floor(totalSeconds / 10));
        broadcast({ type: "update", download: download.info });
      }
      lastError += line;
    });

  } else {
    // ARIA2C pour téléchargements directs et torrents
    log('INFO', `Utilisation d'aria2c${isRetry ? ' (retry ' + retryCount + ')' : ''}`);
    const conns = Math.max(1, Math.min(parseInt(connections) || (isTorrent ? 4 : 16), 16));

    const args = [
      "--console-log-level=notice", "--summary-interval=1", "--dir", downloadsDir,
      "--out", filename, "--user-agent", defaultUA(ua), "--max-tries", "5", "--retry-wait", "3",
      `--max-connection-per-server=${conns}`, `--split=${conns}`
    ];

    if (referer && !isTorrent) args.push("--referer", referer);
    if (isTorrent) {
      args.push("--bt-tracker=" + BEST_TRACKERS.join(','));
      args.push("--seed-time=0");
    }
    if (cookies) args.push("--header", `Cookie: ${cookies}`);
    if (noCheckCert) args.push("--check-certificate=false");

    args.push(url);
    proc = spawn("aria2c", args);

    proc.stdout.on("data", d => {
      const line = d.toString();

      // Parser aria2c output
      const progressMatch = line.match(/\[#\d+\s+([^\s]+)\/([^\s]+)\((\d+)%\)\s+CN:(\d+)\s+DL:([^\s]+)\s+ETA:([^\]]+)\]/);

      if (progressMatch) {
        download.info.currentSize = progressMatch[1];
        download.info.fullSize = progressMatch[2];
        download.info.progress = parseInt(progressMatch[3]);
        download.info.speed = progressMatch[5] + "/s";
        download.info.eta = progressMatch[6];
        broadcast({ type: "update", download: download.info });
      } else {
        const simpleProgress = line.match(/\((\d+)%\)/);
        if (simpleProgress) {
          download.info.progress = parseInt(simpleProgress[1]);
          broadcast({ type: "update", download: download.info });
        }
      }
    });

    proc.stderr.on("data", d => {
      lastError += d.toString();
    });
  }

  // Update process ref
  download.process = proc;

  // Timeout de sécurité
  const timeout = setTimeout(() => {
    if (proc) {
      log('WARN', `Timeout atteint pour: ${filename}`);
      proc.kill("SIGTERM");
    }
  }, DOWNLOAD_TIMEOUT * 1000);

  proc.on("close", async code => {
    clearTimeout(timeout);

    if (code === 0) {
      download.info.status = "completed";
      download.info.progress = 100;
      download.info.completedAt = new Date().toISOString();

      const finalFilename = filename + (isVideo && !isTorrent ? '.mp4' : '');
      const originalPath = path.join(downloadsDir, finalFilename);

      try {
        const stats = await fs.stat(originalPath);
        download.info.fullSize = formatSize(stats.size);
        download.info.sizeBytes = stats.size;
      } catch (e) { log('WARN', 'Impossible de lire la taille du fichier', { file: finalFilename }); }

      // --- RANGEMENT AUTOMATIQUE ---
      const extension = path.extname(finalFilename).substring(1);
      let targetDir = downloadsDir;
      let targetPath = originalPath;

      for (const [folder, extensions] of Object.entries(fileRules)) {
        if (extensions.includes(extension)) {
          targetDir = path.join(downloadsDir, folder);
          break;
        }
      }

      if (targetDir !== downloadsDir) {
        try {
          await fs.mkdir(targetDir, { recursive: true });
          targetPath = path.join(targetDir, finalFilename);
          await fs.rename(originalPath, targetPath);
          download.info.filename = path.join(path.basename(targetDir), finalFilename); // Mettre à jour le chemin relatif
          log('INFO', `Fichier rangé dans: ${targetDir}`);
        } catch (e) {
          log('ERROR', 'Erreur rangement fichier', { error: e.message, file: finalFilename });
          download.info.filename = finalFilename; // Fallback au nom original
        }
      } else {
         download.info.filename = finalFilename;
      }
      // --- FIN RANGEMENT ---

      log('SUCCESS', `Téléchargement terminé: ${download.info.filename}`, {
        size: download.info.fullSize
      });

      // AJOUT HISTORY
      const historyItem = { ...download.info, date: new Date().toISOString() };
      historyList.push(historyItem);
      await saveHistory();

      activeDownloads.delete(id);
      broadcast({ type: "status-change", download: download.info });
      processQueue(); // Trigger next
    } else {
      // Vérifier si retry nécessaire
      const shouldRetry = download.retryCount < RETRY_ATTEMPTS && (
        lastError.includes("503") ||
        lastError.includes("Connection") ||
        lastError.includes("timeout") ||
        lastError.includes("SSL") ||
        code === 3 || code === 7
      );

      if (shouldRetry) {
        download.retryCount++;
        log('WARN', `Retry automatique ${download.retryCount}/${RETRY_ATTEMPTS} dans ${RETRY_DELAY / 1000}s: ${filename}`);
        download.info.status = "retrying";
        broadcast({ type: "update", download: download.info });

        setTimeout(() => startDownload(id), RETRY_DELAY);
        return;
      }

      download.info.status = "error";
      const errorLines = lastError.split("\n").filter(l =>
        l.toLowerCase().includes("error") || l.toLowerCase().includes("failed")
      );
      download.info.error = errorLines.length > 0
        ? errorLines[0].substring(0, 200)
        : `Échec (code ${code})`;

      log('ERROR', `Téléchargement échoué: ${filename}`, {
        error: download.info.error,
        code,
        retries: retryCount
      });

      broadcast({ type: "status-change", download: download.info });
      activeDownloads.delete(id);
    }
  });

  proc.on("error", err => {
    log('ERROR', `Erreur processus: ${filename}`, { error: err.message });
    download.info.status = "error";
    download.info.error = err.message;
    broadcast({ type: "status-change", download: download.info });
    activeDownloads.delete(id);
    processQueue();
  });
}

// ================= DOWNLOAD HANDLER =================
app.post("/download", async (req, res) => {
  let { url, referer, ua, noCheckCert, customFilename, singleSegment, cookies, connections, formatCode } = req.body;

  // Validation basique
  if (!url) {
    return res.status(400).json({ error: "URL manquante" });
  }

  // Validation protocole
  if (!isAllowedProtocol(url)) {
    log('ERROR', 'Protocole non autorisé', { url });
    return res.status(400).json({ error: "Protocole non autorisé (http/https ou magnet)" });
  }

  // Validation domaine (skip for magnets)
  if (!url.startsWith("magnet:") && !isDomainAllowed(url)) {
    const hostname = new URL(url).hostname;
    log('WARN', `Domaine non autorisé: ${hostname}`);
    return res.status(403).json({ error: `Domaine non autorisé: ${hostname}` });
  }

  // ----- Robustesse: réparer/valider le champ `url` (parfois l'extension poste des headers dans url) -----
  let forceVideo = false;

  if (typeof url === 'string' && (url.includes('\n') || url.includes('\r') || /referer[:=]/i.test(url))) {
    const match = url.match(/https?:\/\/[^\s'"]+/i);
    if (match) {
      log('WARN', 'URL malformée reçue, extraction de la vraie URL', { original: url.substring(0, 200), extracted: match[0] });
      req.body.url = match[0];
      // Mettre à jour la variable locale `url`
      url = match[0];
    } else {
      log('ERROR', 'URL invalide reçue (champ `url` contient probablement des headers)', { sample: url.substring(0, 200) });
      return res.status(400).json({ error: "URL invalide : vérifiez l'extension (le champ url contient des headers ou est malformé)" });
    }
  }

  // ----- Détection HEAD pour reconnaître les manifests DASH / JSON (ex: Vimeo) -----
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const headRes = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': defaultUA(ua) },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const ct = (headRes.headers.get('content-type') || '').toLowerCase();

    if (ct.includes('application/vnd.vimeo.dash+json') || ct.includes('application/dash+xml') || ct.includes('application/manifest+json')) {
      forceVideo = true;
      log('INFO', 'HEAD content-type indique DASH/manifest (forçage vidéo)', { url: url.substring(0, 120), contentType: ct });
    }
  } catch (e) {
    log('WARN', 'HEAD request échouée (skip content-type detection)', { error: e.message, url: url.substring(0, 120) });
  }

  // Vérification espace disque (uniquement pour fichiers directs)
  if (!isVideoPlatform(url) && !url.match(/\.(m3u8|mpd)/i)) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const headRes = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': defaultUA(ua) },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      const contentLength = headRes.headers.get('content-length');

      if (contentLength) {
        const bytesNeeded = parseInt(contentLength);
        const stats = await fs.statfs(downloadsDir);
        const bytesAvailable = stats.bavail * stats.bsize;

        if (bytesAvailable < bytesNeeded) {
          log('WARN', `Espace disque insuffisant: ${formatSize(bytesNeeded)} requis, ${formatSize(bytesAvailable)} dispo`);
          return res.status(507).json({
            error: `Espace disque insuffisant. Requis: ${formatSize(bytesNeeded)}, Disponible: ${formatSize(bytesAvailable)}`
          });
        }
      }
    } catch (e) {
      log('WARN', 'Impossible de vérifier la taille du fichier (skip)', { error: e.message });
    }
  }

  const id = uuidv4();
  const timestamp = Date.now();
  const isYouTube = url.includes("googlevideo.com") || url.includes("youtube.com");

  // Générer nom de fichier sécurisé
  const baseName = customFilename?.trim()
    ? sanitizeFilename(customFilename)
    : sanitizeFilename(path.basename(url).split("?")[0]) || "download";

  const filename = customFilename?.trim() ? baseName : `${timestamp}_${baseName}`;

  const downloadInfo = {
    id,
    url,
    filename,
    status: "queued",
    progress: 0,
    speed: "0 KB/s",
    eta: "--",
    currentSize: "0 B",
    fullSize: "???",
    startedAt: null
  };

  const downloadConfig = {
    url, referer, ua, noCheckCert, customFilename, singleSegment, cookies, filename, forceVideo, connections, formatCode
  };

  log('INFO', `Nouveau téléchargement en file d'attente: ${filename}`, {
    url: url.substring(0, 100),
    type: isVideoPlatform(url) ? 'video' : url.startsWith("magnet:") ? 'torrent' : url.match(/\.(m3u8|mpd)/i) ? 'stream' : 'direct'
  });

  // Stocker le processus
  activeDownloads.set(id, { info: downloadInfo, config: downloadConfig, process: null, retryCount: 0 });
  downloadQueue.push(id);

  broadcast({ type: "update", download: downloadInfo });
  processQueue(); // Tenter de démarrer si slot libre

  res.json({
    id,
    filename,
    message: "Téléchargement ajouté à la file d'attente",
    status: "queued",
    queuePosition: downloadQueue.length
  });
});

// ================= STARTUP =================
let server;

async function startServer() {
  try {
    await fetchTrackers();
    await loadRules();
    await checkDependencies(); // AJOUTÉ
    await ensureDirectories();
    await loadState();

    server = app.listen(PORT, () => {
      log('SUCCESS', `Serveur démarré sur le port ${PORT}`);
      log('INFO', `Configuration: ${MAX_CONCURRENT_DOWNLOADS} téléchargements max, ${ALLOWED_DOMAINS.length > 0 ? ALLOWED_DOMAINS.length + ' domaines autorisés' : 'tous domaines autorisés'}`);
    });

    server.on('error', (err) => {
      log('ERROR', 'Erreur critique du serveur HTTP', { error: err.message });
      process.exit(1);
    });

  } catch (err) {
    log('ERROR', 'Erreur démarrage serveur', { error: err.message });
    process.exit(1);
  }
}

// Gestion arrêt gracieux
async function gracefulShutdown(signal) {
  log('INFO', `Signal ${signal} reçu, arrêt gracieux...`);

  if (server) {
    server.close(() => {
      log('INFO', 'Serveur HTTP fermé');
    });
  }

  await saveState();
  await saveHistory(); // AJOUTÉ
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();