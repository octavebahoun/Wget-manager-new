'use strict';
// Outils externes : détection des binaires et exécution contrôlée (annulation, lignes)
const { spawn, spawnSync } = require('child_process');
const config = require('./config');
const { log } = require('./logger');
const { lineSplitter } = require('./util');

const binaries = {
  aria2c: null,
  ffmpeg: null,
  ffprobe: null,
  ytdlp: null,
  ffmpegExtensionPicky: false,
  ytdlpJsRuntimes: false,
  ytdlpNoUpdate: false,
};

function probeVersion(bin, args, re) {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000 });
    if (r.error) return null;
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const m = re.exec(out);
    return m ? m[1] : r.status === 0 ? 'ok' : null;
  } catch {
    return null;
  }
}

function detectBinaries() {
  binaries.aria2c = probeVersion(config.BIN.aria2c, ['--version'], /aria2 version ([\d.]+)/);
  binaries.ffmpeg = probeVersion(config.BIN.ffmpeg, ['-version'], /ffmpeg version (\S+)/);
  binaries.ffprobe = probeVersion(config.BIN.ffprobe, ['-version'], /ffprobe version (\S+)/);
  binaries.ytdlp = probeVersion(config.BIN.ytdlp, ['--version'], /^\s*(\d{4}\.\d{2}\.\d{2}\S*)/m);

  if (binaries.ffmpeg) {
    const r = spawnSync(config.BIN.ffmpeg, ['-hide_banner', '-h', 'demuxer=hls'], { encoding: 'utf8', timeout: 10000 });
    binaries.ffmpegExtensionPicky = /extension_picky/.test(`${r.stdout || ''}${r.stderr || ''}`);
  }
  if (binaries.ytdlp) {
    const r = spawnSync(config.BIN.ytdlp, ['--help'], { encoding: 'utf8', timeout: 20000 });
    const help = `${r.stdout || ''}`;
    binaries.ytdlpJsRuntimes = /--js-runtimes/.test(help);
    binaries.ytdlpNoUpdate = /--no-update/.test(help);
  }

  const labels = { aria2c: 'aria2c', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ytdlp: 'yt-dlp' };
  for (const [key, label] of Object.entries(labels)) {
    if (binaries[key]) log('INFO', `${label} ${binaries[key]} détecté`);
    else log('WARN', `Binaire manquant: ${label} (certaines fonctions seront indisponibles)`);
  }
  return binaries;
}

// Âge de yt-dlp en jours (les sites changent souvent : une version ancienne casse)
function ytdlpAgeDays() {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(binaries.ytdlp || '');
  if (!m) return null;
  const date = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor((Date.now() - date) / 86400000);
}

/**
 * Lance un outil et suit sa sortie ligne par ligne.
 * L'annulation (signal) tue tout le groupe de processus (ex: ffmpeg lancé par yt-dlp).
 */
function runTool(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const useGroup = process.platform !== 'win32';
    let child;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: useGroup,
      });
    } catch (e) {
      reject(e);
      return;
    }

    const stderrTail = [];
    const stdoutTail = [];
    const keep = (arr, line, max) => {
      arr.push(line);
      if (arr.length > max) arr.shift();
    };
    child.stdout.on('data', lineSplitter((line) => {
      keep(stdoutTail, line, 30);
      opts.onStdoutLine?.(line);
    }));
    child.stderr.on('data', lineSplitter((line) => {
      keep(stderrTail, line, 60);
      opts.onStderrLine?.(line);
    }));

    let killTimer = null;
    const sendSignal = (sig) => {
      try {
        if (useGroup) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* déjà mort */ }
      }
    };
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      sendSignal('SIGTERM');
      killTimer = setTimeout(() => sendSignal('SIGKILL'), 5000);
    };
    if (opts.signal) {
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener('abort', kill, { once: true });
    }
    opts.onSpawn?.(child);

    child.on('error', (err) => {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', kill);
      if (err.code === 'ENOENT') err.message = `Programme introuvable: ${bin}`;
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', kill);
      resolve({ code, signal, stderrTail, stdoutTail, aborted: !!opts.signal?.aborted });
    });
  });
}

// Exécute un outil et renvoie stdout complet (analyse JSON yt-dlp)
function captureTool(bin, args, { timeout = 60000, maxBytes = 64 * 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size <= maxBytes) out.push(d);
    });
    child.stderr.on('data', (d) => {
      err = (err + d.toString()).slice(-8000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: err });
    });
  });
}

module.exports = { binaries, detectBinaries, ytdlpAgeDays, runTool, captureTool };
