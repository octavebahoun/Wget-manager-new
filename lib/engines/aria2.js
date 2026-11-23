'use strict';
// Moteur aria2c : fichiers directs, multi-connexions, reprise
const fsp = require('fs').promises;
const path = require('path');
const config = require('../config');
const { runTool } = require('../tools');
const { parseSize, formatBytes } = require('../util');
const { EngineError, isTransient, pickErrorLine } = require('./common');
const { sniffBuffer } = require('../probe');

const PROGRESS_RE =
  /\[#[0-9a-f]+\s+([\d.]+[KMGT]?i?B)(?:\/([\d.]+[KMGT]?i?B))?(?:\((\d+)%\))?(?:\s+CN:(\d+))?(?:\s+SD:\d+)?(?:\s+DL:([\d.]+[KMGT]?i?B))?(?:\s+UL:\S+?)?(?:\s+ETA:(\w+))?\]/;

const ERROR_CODES = {
  2: 'Délai dépassé',
  3: 'Fichier introuvable (404)',
  5: 'Vitesse trop faible',
  6: 'Problème réseau',
  8: 'Le serveur ne permet pas la reprise',
  9: 'Espace disque insuffisant',
  19: 'Domaine introuvable (DNS)',
  22: 'Réponse HTTP refusée (lien expiré ou protégé ? 403/401)',
  24: 'Authentification requise',
};
const RETRYABLE_CODES = new Set([1, 2, 5, 6, 8, 19]);

function etaToSeconds(eta) {
  if (!eta) return null;
  let s = 0;
  const h = /(\d+)h/.exec(eta);
  const m = /(\d+)m/.exec(eta);
  const sec = /(\d+)s/.exec(eta);
  if (h) s += Number(h[1]) * 3600;
  if (m) s += Number(m[1]) * 60;
  if (sec) s += Number(sec[1]);
  return s;
}

function parseAria2Line(line) {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const done = parseSize(m[1]);
  const total = m[2] ? parseSize(m[2]) : null;
  return {
    downloadedBytes: done,
    totalBytes: total || null,
    progress: m[3] !== undefined ? Number(m[3]) : total ? (done / total) * 100 : null,
    connections: m[4] ? Number(m[4]) : null,
    speedBps: m[5] ? parseSize(m[5]) : null,
    etaSec: etaToSeconds(m[6]),
  };
}

async function runAria2(ctx) {
  const { job, url, headers, cookieFile, tmpDir, signal } = ctx;
  const tmpName = 'download.part';
  const tmpPath = path.join(tmpDir, tmpName);
  const conns = job.retryCount > 0 || job.config.singleSegment ? 1 : config.ARIA2_CONNECTIONS;
  const local = new AbortController();
  const runSignal = AbortSignal.any([signal, local.signal]);
  let oversize = false;

  const args = [
    '--console-log-level=warn', '--summary-interval=1', '--show-console-readout=true', '--enable-color=false',
    '--file-allocation=none', '--continue=true', '--allow-overwrite=true', '--auto-file-renaming=false',
    '--max-tries=5', '--retry-wait=3', '--connect-timeout=20', '--timeout=60', '--follow-torrent=false',
    `--max-connection-per-server=${conns}`, `--split=${conns}`, '--min-split-size=1M',
    `--dir=${tmpDir}`, `--out=${tmpName}`,
    `--user-agent=${headers['User-Agent']}`,
    `--check-certificate=${job.config.noCheckCert ? 'false' : 'true'}`,
  ];
  if (headers.Referer) args.push(`--referer=${headers.Referer}`);
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'User-Agent' || k === 'Referer') continue;
    if (k === 'Cookie' && cookieFile) continue;
    args.push(`--header=${k}: ${v}`);
  }
  if (cookieFile) args.push(`--load-cookies=${cookieFile}`);
  args.push(url);

  const errors = [];
  const result = await runTool(config.BIN.aria2c, args, {
    signal: runSignal,
    onStdoutLine: (line) => {
      if (/error|exception/i.test(line)) errors.push(line);
      const p = parseAria2Line(line);
      if (!p) return;
      if (ctx.maxBytes && p.totalBytes && p.totalBytes > ctx.maxBytes) {
        oversize = true;
        local.abort();
        return;
      }
      ctx.progress({ status: 'downloading', phase: p.connections > 1 ? `${p.connections} connexions` : null, ...p });
    },
    onStderrLine: (line) => errors.push(line),
  });

  if (oversize) throw new EngineError(`Fichier trop volumineux (limite ${formatBytes(ctx.maxBytes)})`);
  if (result.aborted) throw new EngineError('Annulé');

  if (result.code !== 0) {
    const codeMatch = /errorCode=(\d+)/.exec(errors.join('\n'));
    const code = codeMatch ? Number(codeMatch[1]) : result.code;
    const message = ERROR_CODES[code] || pickErrorLine(errors, `aria2c a échoué (code ${result.code})`);
    if (code === 8) await fsp.rm(`${tmpPath}.aria2`, { force: true }).catch(() => {});
    throw new EngineError(message, { retryable: RETRYABLE_CODES.has(code) || isTransient(errors.join('\n')) });
  }

  // Vérifie le contenu : un "fichier" qui est en fait une playlist / une page HTML
  const fh = await fsp.open(tmpPath, 'r');
  const head = Buffer.alloc(4096);
  const { bytesRead } = await fh.read(head, 0, 4096, 0);
  const { size } = await fh.stat();
  await fh.close();
  if (!size) throw new EngineError('Fichier vide reçu', { retryable: true });
  const sniff = sniffBuffer(head.subarray(0, bytesRead));
  if (['hls', 'dash', 'vimeo-json'].includes(sniff.kind) || (sniff.kind === 'page' && size < 5 * 1024 * 1024)) {
    await fsp.rm(tmpPath, { force: true });
    throw new EngineError(`Le lien renvoie ${sniff.kind === 'page' ? 'une page web' : 'une playlist'}, changement de moteur`, { reroute: sniff.kind });
  }

  const ext = ctx.preferredExt || sniff.ext || '';
  const finalPath = await ctx.finalize(tmpPath, ext);
  return { files: [finalPath] };
}

module.exports = { runAria2, parseAria2Line };
