'use strict';
// Moteur ffmpeg : secours pour les flux HLS/DASH + utilitaire de fusion
const fsp = require('fs').promises;
const path = require('path');
const config = require('../config');
const { binaries, runTool } = require('../tools');
const { EngineError, isTransient, pickErrorLine } = require('./common');

function hmsToSeconds(h, m, s) {
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}

// Télécharge un flux (HLS/DASH) en copiant les pistes sans réencodage
async function runFfmpeg(ctx) {
  const { url, headers, tmpDir, signal, kind } = ctx;
  if (!binaries.ffmpeg) throw new EngineError('ffmpeg non installé', { fallback: true });
  const out = path.join(tmpDir, 'stream.mp4');
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1', '-stats_period', '1'];
  args.push('-user_agent', headers['User-Agent']);
  if (headers.Referer) args.push('-referer', headers.Referer);
  const extra = Object.entries(headers)
    .filter(([k]) => !['User-Agent', 'Referer', 'Accept'].includes(k))
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  if (extra) args.push('-headers', extra);
  args.push('-rw_timeout', '30000000');
  if (kind === 'hls') {
    if (binaries.ffmpegExtensionPicky) args.push('-extension_picky', '0');
    args.push('-allowed_extensions', 'ALL');
  }
  args.push('-i', url, '-sn', '-dn', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', out);

  let duration = ctx.probe?.duration || null;
  let outTime = 0;
  let size = 0;
  const startedAt = Date.now();
  const result = await runTool(config.BIN.ffmpeg, args, {
    signal,
    onStderrLine: (line) => {
      const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (d && !duration) duration = hmsToSeconds(d[1], d[2], d[3]);
    },
    onStdoutLine: (line) => {
      const [key, value] = line.split('=');
      if (key === 'out_time_us' || key === 'out_time_ms') outTime = Number(value) / 1e6 || outTime;
      else if (key === 'total_size') size = Number(value) || size;
      else if (key === 'progress') {
        const elapsed = (Date.now() - startedAt) / 1000;
        const ratio = duration ? outTime / duration : null;
        ctx.progress({
          status: 'downloading',
          progress: ratio !== null ? Math.min(99.5, ratio * 100) : null,
          downloadedBytes: size,
          totalBytes: ratio ? size / Math.max(ratio, 0.001) : null,
          speedBps: elapsed > 0 ? size / elapsed : null,
          etaSec: ratio && ratio > 0 ? (elapsed / ratio) - elapsed : null,
          phase: duration ? null : `${Math.round(outTime)}s enregistrées`,
        });
      }
    },
  });

  if (result.aborted) throw new EngineError('Annulé');
  if (result.code !== 0) {
    const text = result.stderrTail.join('\n');
    throw new EngineError(pickErrorLine(result.stderrTail, `ffmpeg a échoué (code ${result.code})`), { retryable: isTransient(text) });
  }
  const st = await fsp.stat(out).catch(() => null);
  if (!st || st.size === 0) throw new EngineError('ffmpeg n\'a produit aucun fichier');
  const finalPath = await ctx.finalize(out, 'mp4');
  return { files: [finalPath] };
}

/**
 * Assemble des pistes (vidéo + audio) dans un MP4 propre.
 * mode "audio-mp3" : convertit la piste audio en MP3.
 */
async function muxTracks({ video, audio, output, mode = 'copy', signal }) {
  if (!binaries.ffmpeg) throw new EngineError('ffmpeg est requis pour assembler les pistes');
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
  if (video) args.push('-i', video);
  if (audio) args.push('-i', audio);
  if (mode === 'audio-mp3') {
    args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '0', output);
  } else {
    if (video) args.push('-map', '0:v:0');
    if (audio) args.push('-map', `${video ? 1 : 0}:a:0`);
    args.push('-c', 'copy', '-movflags', '+faststart', output);
  }
  const r = await runTool(config.BIN.ffmpeg, args, { signal });
  if (r.aborted) throw new EngineError('Annulé');
  if (r.code !== 0) throw new EngineError(`Assemblage impossible : ${pickErrorLine(r.stderrTail)}`);
}

module.exports = { runFfmpeg, muxTracks };
