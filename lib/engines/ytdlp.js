'use strict';
// Moteur yt-dlp : plateformes (YouTube, Vimeo, TikTok...), HLS/DASH, pages web
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { binaries, runTool, captureTool } = require('../tools');
const { isPathInside } = require('../util');
const { EngineError, isTransient, pickErrorLine } = require('./common');

const PP_LABELS = {
  Merger: 'Fusion audio + vidéo',
  ExtractAudio: 'Conversion audio',
  FixupM3u8: 'Réparation du flux',
  FixupM4a: 'Réparation audio',
  FixupStretched: 'Réparation vidéo',
  FixupDuplicateMoov: 'Réparation vidéo',
  FixupTimestamp: 'Réparation vidéo',
  EmbedSubtitle: 'Ajout des sous-titres',
  FFmpegEmbedSubtitle: 'Ajout des sous-titres',
  Metadata: 'Métadonnées',
  FFmpegMetadata: 'Métadonnées',
  EmbedThumbnail: 'Ajout de la miniature',
  MoveFiles: 'Finalisation',
  VideoRemuxer: 'Conversion du conteneur',
  VideoConvertor: 'Conversion vidéo',
};

const QUALITY_RE = /^(best|audio|\d{3,4})$/;

// Sélecteur de format yt-dlp selon la qualité demandée
function buildFormat({ quality = 'best', format } = {}) {
  if (format) return format;
  if (quality === 'audio') return 'ba/b';
  const h = parseInt(quality, 10);
  if (h > 0) return `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`;
  return 'bv*+ba/b';
}

// Options communes (en-têtes, cookies, certificats, runtime JS)
function commonArgs({ headers = {}, cookieFile, noCheckCert }) {
  const args = [];
  if (binaries.ytdlpNoUpdate) args.push('--no-update');
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'Cookie' && cookieFile) continue;
    if (k === 'Accept') continue;
    args.push('--add-headers', `${k}:${v}`);
  }
  if (cookieFile) args.push('--cookies', cookieFile);
  if (noCheckCert) args.push('--no-check-certificates');
  if (config.YTDLP_JS_RUNTIME && binaries.ytdlpJsRuntimes) args.push('--js-runtimes', config.YTDLP_JS_RUNTIME);
  return args;
}

function classifyFailure(lines, code) {
  const text = lines.join('\n');
  const errLines = lines.filter((l) => /^ERROR:/.test(l));
  const message = pickErrorLine(errLines.length ? errLines : lines, `yt-dlp a échoué (code ${code})`);
  if (code === 2) return new EngineError(`Option yt-dlp invalide : ${message}`);
  if (/\bDRM\b/i.test(text)) return new EngineError('Contenu protégé par DRM : téléchargement impossible');
  if (/Sign in|log ?in|cookies|private video|members[- ]only|age[- ]restricted|confirm your age|not a bot/i.test(text)) {
    return new EngineError(`${message} → Connectez-vous dans le navigateur puis envoyez via l'extension (cookies).`, { fallback: true });
  }
  if (/Unsupported URL|No video formats found|Unable to extract|no suitable|is not a valid URL|Requested format is not available|Unable to recognize|HTTP Error 40[34]/i.test(text)) {
    return new EngineError(message, { fallback: true });
  }
  return new EngineError(message, { retryable: isTransient(text), fallback: !isTransient(text) });
}

function num(v) {
  if (v === undefined || v === null || v === '' || v === 'NA' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function runYtdlp(ctx) {
  const { job, url, headers, cookieFile, tmpDir, outDir, signal } = ctx;
  const cfg = job.config;
  if (!binaries.ytdlp) throw new EngineError('yt-dlp non installé', { fallback: true });

  let template;
  // "_1", "_2"… seulement si le lien contient plusieurs médias (carrousel, post multiple)
  if (ctx.baseName) template = `${ctx.baseName.replace(/%/g, '%%')}%(playlist_index&_{}|)s.%(ext)s`;
  else if (cfg.playlist) template = '%(playlist_title|Playlist).80B/%(playlist_index|0)03d - %(title).120B [%(id)s].%(ext)s';
  else template = '%(title).150B [%(id)s].%(ext)s';

  const args = [
    '--newline', '--progress', '--no-simulate',
    '--progress-template',
    'download:WGETPROG %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(info.vcodec)s|%(info.acodec)s|%(info.playlist_index)s|%(info.n_entries)s',
    '--progress-template', 'postprocess:WGETPP %(progress.status)s|%(progress.postprocessor)s',
    '--print', 'before_dl:WGETTITLE %(title)s',
    '--print', 'after_move:WGETFILE %(filepath)s',
    '-P', `home:${outDir}`, '-P', `temp:${tmpDir}`,
    '-o', template,
    // Sans "playlist entière" : pas plus de 10 éléments (protège contre une chaîne entière)
    ...(cfg.playlist ? ['--yes-playlist'] : ['--no-playlist', '--playlist-items', '1:10']),
    '-f', buildFormat(cfg),
    '-N', String(config.YTDLP_FRAGMENTS),
    '--retries', '10', '--fragment-retries', '10', '--extractor-retries', '3', '--socket-timeout', '30',
    '--no-mtime',
    ...commonArgs({ headers, cookieFile, noCheckCert: cfg.noCheckCert }),
  ];
  if (cfg.quality === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-metadata', '--embed-thumbnail');
  } else {
    // À résolution égale, préférer H.264/AAC (MP4 lisible partout) ; format expert = choix de l'utilisateur
    if (!cfg.format && config.MERGE_FORMAT === 'mp4') args.push('-S', 'res,vcodec:h264,acodec:aac,ext:mp4:m4a');
    args.push('--merge-output-format', config.MERGE_FORMAT);
  }
  if (cfg.subtitles) args.push('--write-subs', '--sub-langs', 'fr.*,en.*', '--embed-subs');
  if (ctx.maxBytes) args.push('--max-filesize', String(ctx.maxBytes));
  args.push(...config.YTDLP_EXTRA_ARGS, '--', url);

  const files = [];
  const lines = [];
  const result = await runTool(config.BIN.ytdlp, args, {
    signal,
    onStdoutLine: (line) => {
      if (line.startsWith('WGETPROG ')) {
        const [status, dl, total, est, speed, eta, fi, fc, vcodec, acodec, pi, n] = line.slice(9).split('|');
        if (status !== 'downloading' && status !== 'finished') return;
        const downloaded = num(dl);
        const totalBytes = num(total) ?? num(est);
        const fragIndex = num(fi);
        const fragCount = num(fc);
        let progress = null;
        if (status === 'finished') progress = 100;
        else if (totalBytes && downloaded !== null) progress = (downloaded / totalBytes) * 100;
        else if (fragCount && fragIndex) progress = (fragIndex / fragCount) * 100;
        const hasV = vcodec && !['none', 'NA'].includes(vcodec);
        const hasA = acodec && !['none', 'NA'].includes(acodec);
        const part = hasV && hasA ? 'Vidéo + audio' : hasV ? 'Piste vidéo' : hasA ? 'Piste audio' : null;
        const item = num(n) > 1 ? `Élément ${num(pi) ?? '?'}/${num(n)}` : null;
        ctx.progress({
          status: 'downloading',
          progress,
          downloadedBytes: downloaded,
          totalBytes,
          speedBps: num(speed),
          etaSec: num(eta),
          phase: [item, part].filter(Boolean).join(' · ') || null,
        });
      } else if (line.startsWith('WGETPP ')) {
        const [status, pp] = line.slice(7).split('|');
        if (status === 'started' && pp !== 'MoveFiles') ctx.progress({ status: 'processing', phase: PP_LABELS[pp] || pp });
      } else if (line.startsWith('WGETTITLE ')) {
        ctx.setTitle(line.slice(10).trim());
      } else if (line.startsWith('WGETFILE ')) {
        files.push(line.slice(9).trim());
      } else {
        lines.push(line);
      }
    },
    onStderrLine: (line) => lines.push(line),
  });

  if (result.aborted) throw new EngineError('Annulé');
  if (result.code !== 0) throw classifyFailure(lines.slice(-60), result.code);

  const valid = [...new Set(files)].filter((f) => isPathInside(outDir, f) && fs.existsSync(f));
  if (!valid.length) throw new EngineError('yt-dlp n\'a produit aucun fichier', { fallback: true });
  return { files: valid };
}

// ================= ANALYSE (-J) =================
function summarizeInfo(info) {
  if (!info || typeof info !== 'object') return null;
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    const entries = (info.entries || []).slice(0, 200).map((e) => ({
      url: e.webpage_url || e.url,
      title: e.title || null,
      duration: e.duration || null,
    })).filter((e) => e.url && /^https?:/.test(e.url));
    return {
      isPlaylist: true,
      title: info.title || null,
      extractor: info.extractor_key || null,
      count: info.playlist_count || entries.length,
      entries,
      thumbnail: info.thumbnails?.length ? info.thumbnails[info.thumbnails.length - 1].url : null,
      formats: [],
    };
  }
  const formats = info.formats || [];
  const byHeight = new Map();
  for (const f of formats) {
    if (!f.height || f.vcodec === 'none') continue;
    const prev = byHeight.get(f.height);
    if (!prev || (f.tbr || 0) > (prev.tbr || 0)) byHeight.set(f.height, f);
  }
  const bestAudio = formats
    .filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const audioSize = bestAudio ? bestAudio.filesize || bestAudio.filesize_approx || 0 : 0;
  const list = [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .map((f) => {
      const vsize = f.filesize || f.filesize_approx || 0;
      return {
        id: String(f.height),
        label: `${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ''}`,
        height: f.height,
        size: vsize ? vsize + (f.acodec && f.acodec !== 'none' ? 0 : audioSize) : null,
        vcodec: f.vcodec || null,
      };
    });
  const hasAudio = formats.length === 0 || formats.some((f) => f.acodec && f.acodec !== 'none');
  if (hasAudio) list.push({ id: 'audio', label: 'Audio MP3', audio: true, size: audioSize || null });
  return {
    isPlaylist: false,
    title: info.title || null,
    extractor: info.extractor_key || null,
    duration: info.duration || null,
    thumbnail: info.thumbnail || null,
    uploader: info.uploader || info.channel || null,
    isLive: !!info.is_live,
    drm: formats.some((f) => f.has_drm),
    formats: list,
  };
}

async function ytdlpInfo(url, { headers, cookieFile, noCheckCert, playlist, signal, timeout = 45000 } = {}) {
  if (!binaries.ytdlp) throw new EngineError('yt-dlp non installé');
  const args = [
    '-J', '--no-warnings', '--skip-download', '--flat-playlist',
    playlist ? '--yes-playlist' : '--no-playlist',
    ...commonArgs({ headers, cookieFile, noCheckCert }),
    '--', url,
  ];
  const r = await captureTool(config.BIN.ytdlp, args, { timeout, signal });
  if (r.code !== 0 || !r.stdout.trim()) {
    const lines = r.stderr.split(/\r?\n/).filter(Boolean);
    if (r.signal === 'SIGKILL') throw new EngineError('Analyse yt-dlp trop longue (délai dépassé)');
    throw classifyFailure(lines, r.code);
  }
  try {
    return summarizeInfo(JSON.parse(r.stdout));
  } catch {
    throw new EngineError('Réponse yt-dlp illisible');
  }
}

module.exports = { runYtdlp, ytdlpInfo, buildFormat, summarizeInfo, QUALITY_RE, commonArgs };
