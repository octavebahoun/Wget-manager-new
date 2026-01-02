require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
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

async function ensureDirectories() {
  try {
    await fs.access(downloadsDir);
  } catch {
    await fs.mkdir(downloadsDir, { recursive: true });
  }
}

// ================= STATE & PERSISTENCE =================
let activeDownloads = new Map(); // id -> { info, process, retryCount }
let clients = []; // SSE clients

async function saveState() {
  const data = Array.from(activeDownloads.values()).map(dl => dl.info);
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log('ERROR', 'Erreur sauvegarde état:', e.message);
  }
}

async function loadState() {
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
    
    log('INFO', `État restauré : ${activeDownloads.size} téléchargements chargés`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      log('ERROR', 'Erreur chargement état:', e.message);
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
function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 255);
}

function isAllowedProtocol(url) {
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
    'youtube.com/watch',
    'youtu.be/',
    'twitch.tv/',
    'vimeo.com/',
    'dailymotion.com/video',
    'facebook.com/watch',
    'instagram.com/p/',
    'tiktok.com/'
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
  try {
    const files = await fs.readdir(downloadsDir);
    const history = await Promise.all(
      files
        .filter(f => f !== ".gitkeep" && !f.endsWith(".aria2"))
        .map(async file => {
          try {
            const filePath = path.join(downloadsDir, file);
            const stats = await fs.stat(filePath);
            return {
              id: file,
              filename: file,
              size: stats.size,
              date: stats.mtime,
              status: "completed",
              progress: 100
            };
          } catch {
            return null;
          }
        })
    );
    
    const validHistory = history
      .filter(Boolean)
      .sort((a, b) => b.date - a.date);
    
    res.json(validHistory);
  } catch (err) {
    log('ERROR', 'Erreur lecture historique', { error: err.message });
    res.status(500).json({ error: "Impossible de lire l'historique" });
  }
});

app.get("/transfer/:filename", (req, res) => {
  const filename = sanitizeFilename(req.params.filename);
  const filePath = path.join(downloadsDir, filename);
  
  if (!fsSync.existsSync(filePath)) {
    return res.status(404).json({ error: "Fichier introuvable" });
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
  try {
    const files = await fs.readdir(downloadsDir);
    let deleted = 0;
    
    await Promise.all(
      files
        .filter(file => file !== ".gitkeep")
        .map(async file => {
          try {
            await fs.unlink(path.join(downloadsDir, file));
            deleted++;
          } catch (e) {
            log('ERROR', `Erreur suppression ${file}`, { error: e.message });
          }
        })
    );
    
    log('INFO', `Historique nettoyé: ${deleted} fichiers supprimés`);
    res.json({ deleted, message: `${deleted} fichiers supprimés` });
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
    retryAttempts: RETRY_ATTEMPTS
  });
});

// ================= DOWNLOAD HANDLER =================
app.post("/download", async (req, res) => {
  const { url, referer, ua, noCheckCert, customFilename, singleSegment, cookies } = req.body;
  
  // Validation basique
  if (!url) {
    return res.status(400).json({ error: "URL manquante" });
  }

  // Validation protocole
  if (!isAllowedProtocol(url)) {
    log('ERROR', 'Protocole non autorisé', { url });
    return res.status(400).json({ error: "Protocole non autorisé (http/https uniquement)" });
  }

  // Validation domaine
  if (!isDomainAllowed(url)) {
    const hostname = new URL(url).hostname;
    log('WARN', `Domaine non autorisé: ${hostname}`);
    return res.status(403).json({ error: `Domaine non autorisé: ${hostname}` });
  }

  // Vérifier limite téléchargements
  if (activeDownloads.size >= MAX_CONCURRENT_DOWNLOADS) {
    return res.status(429).json({
      error: `Limite atteinte (${MAX_CONCURRENT_DOWNLOADS} téléchargements max). Veuillez patienter.`
    });
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
    status: "downloading",
    progress: 0,
    speed: "0 KB/s",
    eta: "--",
    currentSize: "0 B",
    fullSize: "???",
    startedAt: new Date().toISOString()
  };

  log('INFO', `Nouveau téléchargement: ${filename}`, { 
    url: url.substring(0, 100),
    type: isVideoPlatform(url) ? 'video' : url.match(/\.(m3u8|mpd)/i) ? 'stream' : 'direct'
  });

  // Fonction principale de lancement
  function launch(retryCount = 0) {
    let proc;
    let lastError = "";
    const isRetry = retryCount > 0;

    if (isVideoPlatform(url)) {
      // YT-DLP pour plateformes vidéo
      log('INFO', `Utilisation de yt-dlp${isRetry ? ' (retry ' + retryCount + ')' : ''}`);
      
      const ytArgs = [
        "--newline",
        "--no-playlist",
        "--format", "bestvideo+bestaudio/best",
        "--merge-output-format", "mp4",
        "--output", path.join(downloadsDir, `${filename}.mp4`),
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
          downloadInfo.progress = Math.min(100, Math.floor(parseFloat(progress[1])));
          if (size) downloadInfo.fullSize = size[1];
          if (speed) downloadInfo.speed = speed[1];
          if (eta) downloadInfo.eta = eta[1];
          
          broadcast({ type: "update", download: downloadInfo });
        }
      });

      proc.stderr.on("data", d => {
        lastError += d.toString();
      });

    } else if (url.match(/\.(m3u8|mpd)/i)) {
      // FFMPEG pour streams
      log('INFO', `Utilisation de ffmpeg${isRetry ? ' (retry ' + retryCount + ')' : ''}`);
      
      const ffmpegArgs = [
        "-headers", `User-Agent: ${defaultUA(ua)}\r\n`,
        "-i", url,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        path.join(downloadsDir, `${filename}.mp4`)
      ];
      
      proc = spawn("ffmpeg", ffmpegArgs);

      proc.stderr.on("data", d => {
        const line = d.toString();
        const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
        
        if (timeMatch) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseInt(timeMatch[3]);
          const totalSeconds = hours * 3600 + minutes * 60 + seconds;
          
          downloadInfo.eta = `${totalSeconds}s encodées`;
          downloadInfo.progress = Math.min(99, Math.floor(totalSeconds / 10));
          broadcast({ type: "update", download: downloadInfo });
        }
        
        lastError += line;
      });

    } else {
      // ARIA2C pour téléchargements directs
      log('INFO', `Utilisation d'aria2c${isRetry ? ' (retry ' + retryCount + ')' : ''}`);
      
      const args = [
        "--console-log-level=notice",
        "--summary-interval=1",
        "--dir", downloadsDir,
        "--out", filename,
        "--user-agent", defaultUA(ua),
        "--max-tries", "5",
        "--retry-wait", "3"
      ];

      if (referer) args.push("--referer", referer);
      
      if (isYouTube || isRetry || singleSegment) {
        args.push("--max-connection-per-server=1", "--split=1");
      } else {
        args.push("--max-connection-per-server=16", "--split=16");
      }
      
      if (cookies) args.push("--header", `Cookie: ${cookies}`);
      if (noCheckCert) args.push("--check-certificate=false");
      if (MAX_FILE_SIZE) args.push("--max-download-limit", MAX_FILE_SIZE);

      args.push(url);
      proc = spawn("aria2c", args);

      proc.stdout.on("data", d => {
        const line = d.toString();

        // Parser aria2c output
        const progressMatch = line.match(/\[#\d+\s+([^\s]+)\/([^\s]+)\((\d+)%\)\s+CN:(\d+)\s+DL:([^\s]+)\s+ETA:([^\]]+)\]/);
        
        if (progressMatch) {
          downloadInfo.currentSize = progressMatch[1];
          downloadInfo.fullSize = progressMatch[2];
          downloadInfo.progress = parseInt(progressMatch[3]);
          downloadInfo.speed = progressMatch[5] + "/s";
          downloadInfo.eta = progressMatch[6];
          broadcast({ type: "update", download: downloadInfo });
        } else {
          const simpleProgress = line.match(/\((\d+)%\)/);
          if (simpleProgress) {
            downloadInfo.progress = parseInt(simpleProgress[1]);
            broadcast({ type: "update", download: downloadInfo });
          }
        }
      });

      proc.stderr.on("data", d => {
        lastError += d.toString();
      });
    }

    // Stocker le processus
    activeDownloads.set(id, { info: downloadInfo, process: proc, retryCount });

    // Timeout de sécurité
    const timeout = setTimeout(() => {
      if (proc) {
        log('WARN', `Timeout atteint pour: ${filename}`);
        proc.kill("SIGTERM");
      }
    }, DOWNLOAD_TIMEOUT * 1000);

    proc.on("close", code => {
      clearTimeout(timeout);
      
      if (code === 0) {
        downloadInfo.status = "completed";
        downloadInfo.progress = 100;
        downloadInfo.completedAt = new Date().toISOString();
        log('SUCCESS', `Téléchargement terminé: ${filename}`, { 
          size: downloadInfo.fullSize,
          duration: Math.round((Date.now() - timestamp) / 1000) + 's'
        });
      } else {
        // Vérifier si retry nécessaire
        const shouldRetry = retryCount < RETRY_ATTEMPTS && (
          lastError.includes("503") ||
          lastError.includes("Connection") ||
          lastError.includes("timeout") ||
          lastError.includes("SSL") ||
          code === 3 || code === 7
        );

        if (shouldRetry) {
          log('WARN', `Retry automatique ${retryCount + 1}/${RETRY_ATTEMPTS} dans ${RETRY_DELAY/1000}s: ${filename}`);
          downloadInfo.status = "retrying";
          broadcast({ type: "update", download: downloadInfo });
          
          setTimeout(() => launch(retryCount + 1), RETRY_DELAY);
          return;
        }

        downloadInfo.status = "error";
        const errorLines = lastError.split("\n").filter(l => 
          l.toLowerCase().includes("error") || l.toLowerCase().includes("failed")
        );
        downloadInfo.error = errorLines.length > 0
          ? errorLines[0].substring(0, 200)
          : `Échec (code ${code})`;
        
        log('ERROR', `Téléchargement échoué: ${filename}`, { 
          error: downloadInfo.error,
          code,
          retries: retryCount
        });
      }
      
      broadcast({ type: "status-change", download: downloadInfo });
      activeDownloads.delete(id);
    });

    proc.on("error", err => {
      log('ERROR', `Erreur processus: ${filename}`, { error: err.message });
      downloadInfo.status = "error";
      downloadInfo.error = err.message;
      broadcast({ type: "status-change", download: downloadInfo });
      activeDownloads.delete(id);
    });
  }

  launch();
  res.json({ 
    id, 
    filename, 
    message: "Téléchargement démarré",
    status: "downloading"
  });
});

// ================= STARTUP =================
async function startServer() {
  try {
    await ensureDirectories();
    await loadState();
    
    app.listen(PORT, () => {
      log('SUCCESS', `Serveur démarré sur le port ${PORT}`);
      log('INFO', `Configuration: ${MAX_CONCURRENT_DOWNLOADS} téléchargements max, ${ALLOWED_DOMAINS.length > 0 ? ALLOWED_DOMAINS.length + ' domaines autorisés' : 'tous domaines autorisés'}`);
    });
  } catch (err) {
    log('ERROR', 'Erreur démarrage serveur', { error: err.message });
    process.exit(1);
  }
}

// Gestion arrêt gracieux
process.on('SIGTERM', async () => {
  log('INFO', 'Signal SIGTERM reçu, arrêt gracieux...');
  await saveState();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('INFO', 'Signal SIGINT reçu, arrêt gracieux...');
  await saveState();
  process.exit(0);
});

startServer();