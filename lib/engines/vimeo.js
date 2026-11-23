'use strict';
// Moteur Vimeo "playlist.json / master.json" (DASH en JSON, utilisé par les vidéos privées/embarquées)
// Télécharge les segments vidéo + audio en parallèle puis les assemble avec ffmpeg.
const fsp = require('fs').promises;
const path = require('path');
const { safeFetch, readBody, checkUrl } = require('../net');
const { sleep, formatBytes } = require('../util');
const { EngineError, isTransient } = require('./common');
const { muxTracks } = require('./ffmpeg');

const SEGMENT_CONCURRENCY = 6;

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function trackSize(track) {
  return (track.segments || []).reduce((sum, s) => sum + asNumber(s.size), 0);
}

// Choisit la meilleure piste vidéo (≤ hauteur demandée) et la meilleure piste audio
function pickTracks(manifest, quality = 'best') {
  const videos = (manifest.video || []).filter((v) => v.segments?.length);
  const audios = (manifest.audio || []).filter((a) => a.segments?.length);
  let video = null;
  if (quality !== 'audio' && videos.length) {
    const maxH = parseInt(quality, 10) || Infinity;
    const sorted = [...videos].sort((a, b) => asNumber(b.height) - asNumber(a.height) || asNumber(b.bitrate) - asNumber(a.bitrate));
    video = sorted.find((v) => asNumber(v.height) <= maxH) || sorted[sorted.length - 1];
  }
  const isPrimary = (a) => a.audio_primary === true || a.audio_primary === 'True' || a.audio_primary === 'true';
  const audio = [...audios].sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)) || asNumber(b.bitrate) - asNumber(a.bitrate))[0] || null;
  return { video, audio };
}

// Résumé lisible pour l'analyse (liste des qualités)
function summarizeManifest(manifest) {
  const heights = [...new Set((manifest.video || []).map((v) => asNumber(v.height)).filter(Boolean))].sort((a, b) => b - a);
  const audio = pickTracks(manifest, 'audio').audio;
  const duration = asNumber((manifest.video || [])[0]?.duration || audio?.duration) || null;
  const formats = heights.map((h) => {
    const t = pickTracks(manifest, String(h));
    return { id: String(h), label: `${h}p`, height: h, size: (t.video ? trackSize(t.video) : 0) + (t.audio ? trackSize(t.audio) : 0) || null };
  });
  if (audio) formats.push({ id: 'audio', label: 'Audio MP3', audio: true, size: trackSize(audio) || null });
  return { duration: duration ? Math.round(duration) : null, formats };
}

async function fetchManifest(url, headers, signal) {
  const { res, finalUrl } = await safeFetch(url, { headers, timeout: 30000, signal });
  if (!res.ok) {
    throw new EngineError(`Manifest Vimeo inaccessible (HTTP ${res.status}${res.status === 403 || res.status === 410 ? ' : lien expiré, relancez la vidéo dans le navigateur' : ''})`, {
      retryable: res.status >= 500,
    });
  }
  const body = await readBody(res, 50 * 1024 * 1024);
  let manifest;
  try {
    manifest = JSON.parse(body.toString('utf8'));
  } catch {
    throw new EngineError('Manifest Vimeo illisible', { reroute: 'page' });
  }
  if (!manifest || (!manifest.video?.length && !manifest.audio?.length)) {
    throw new EngineError('Manifest Vimeo vide ou inconnu');
  }
  return { manifest, finalUrl };
}

async function fetchSegment(url, headers, signal, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]) });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} sur un segment`);
        e.fatal = [401, 403, 404, 410].includes(res.status);
        throw e;
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (signal.aborted || e.fatal) throw e;
      lastError = e;
      await sleep(1000 * (i + 1), signal);
    }
  }
  throw lastError;
}

// Télécharge une piste : init + segments (parallèles), écrits dans l'ordre
async function downloadTrack({ track, baseUrl, file, headers, signal, onBytes }) {
  const trackBase = new URL(track.base_url || '', baseUrl);
  const segments = track.segments || [];
  const fh = await fsp.open(file, 'w');
  try {
    if (track.init_segment) {
      await fh.write(Buffer.from(track.init_segment, 'base64'));
    } else if (track.init_segment_url) {
      await fh.write(await fetchSegment(new URL(track.init_segment_url, trackBase).href, headers, signal));
    }
    const buffers = new Array(segments.length);
    let next = 0;
    let written = 0;
    let writing = Promise.resolve();
    const flush = async () => {
      while (written < segments.length && buffers[written]) {
        const buf = buffers[written];
        buffers[written] = null;
        await fh.write(buf);
        written++;
      }
    };
    const worker = async () => {
      for (;;) {
        if (signal.aborted) throw signal.reason || new Error('Annulé');
        while (next - written > SEGMENT_CONCURRENCY * 4) await sleep(50, signal);
        const i = next++;
        if (i >= segments.length) return;
        const buf = await fetchSegment(new URL(segments[i].url, trackBase).href, headers, signal);
        buffers[i] = buf;
        onBytes(buf.length);
        writing = writing.then(flush);
        await writing;
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, segments.length) }, worker));
    await writing;
    await flush();
    if (written !== segments.length) throw new Error(`Segments manquants (${written}/${segments.length})`);
  } finally {
    await fh.close();
  }
}

async function runVimeo(ctx) {
  const { job, url, headers, tmpDir, signal } = ctx;
  const quality = job.config.quality || 'best';
  const { manifest, finalUrl } = await fetchManifest(url, headers, signal);
  const baseUrl = new URL(manifest.base_url || '', finalUrl).href;
  const { video, audio } = pickTracks(manifest, quality);
  if (!video && !audio) throw new EngineError('Aucune piste exploitable dans le manifest Vimeo');

  // Anti-SSRF : vérifie chaque hôte de segment une seule fois
  const hosts = new Set();
  for (const t of [video, audio].filter(Boolean)) {
    const tb = new URL(t.base_url || '', baseUrl);
    for (const s of t.segments.slice(0, 3)) hosts.add(new URL(s.url, tb).origin);
  }
  for (const origin of hosts) {
    const chk = await checkUrl(origin);
    if (!chk.ok) throw new EngineError(chk.error);
  }

  const total = (video ? trackSize(video) : 0) + (audio ? trackSize(audio) : 0);
  if (ctx.maxBytes && total > ctx.maxBytes) {
    throw new EngineError(`Vidéo trop volumineuse (${formatBytes(total)} > limite ${formatBytes(ctx.maxBytes)})`);
  }
  let done = 0;
  const started = Date.now();
  const phase = [video ? `${video.height}p` : null, audio ? 'audio' : null].filter(Boolean).join(' + ');
  const onBytes = (n) => {
    done += n;
    const elapsed = (Date.now() - started) / 1000;
    const speed = elapsed > 0 ? done / elapsed : null;
    ctx.progress({
      status: 'downloading',
      progress: total ? (done / total) * 100 : null,
      downloadedBytes: done,
      totalBytes: total || null,
      speedBps: speed,
      etaSec: speed && total ? (total - done) / speed : null,
      phase: `Vimeo ${phase}`,
    });
  };

  const videoFile = video ? path.join(tmpDir, 'vimeo-video.mp4') : null;
  const audioFile = audio ? path.join(tmpDir, 'vimeo-audio.mp4') : null;
  try {
    await Promise.all([
      video && downloadTrack({ track: video, baseUrl, file: videoFile, headers, signal, onBytes }),
      audio && downloadTrack({ track: audio, baseUrl, file: audioFile, headers, signal, onBytes }),
    ]);
  } catch (e) {
    if (signal.aborted) throw new EngineError('Annulé');
    const expired = /HTTP (401|403|410)/.test(e.message);
    throw new EngineError(expired ? `${e.message} : lien Vimeo expiré, relancez la lecture puis réessayez` : e.message, {
      retryable: !expired && (isTransient(e.message) || !e.fatal),
    });
  }

  ctx.progress({ status: 'processing', phase: 'Assemblage audio + vidéo', progress: 100 });
  const audioOnly = quality === 'audio' || !video;
  const ext = audioOnly ? 'mp3' : 'mp4';
  const muxed = path.join(tmpDir, `vimeo-final.${ext}`);
  await muxTracks({
    video: audioOnly ? null : videoFile,
    audio: audioFile,
    output: muxed,
    mode: audioOnly ? 'audio-mp3' : 'copy',
    signal,
  });
  const finalPath = await ctx.finalize(muxed, ext);
  return { files: [finalPath] };
}

module.exports = { runVimeo, pickTracks, summarizeManifest, fetchManifest };
