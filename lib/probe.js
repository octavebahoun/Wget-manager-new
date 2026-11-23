'use strict';
// Sonde une URL (1 requête GET partielle) pour connaître son vrai type, sa taille et son nom
const { safeFetch, readBody, filenameFromDisposition } = require('./net');
const { extFromMime } = require('./util');

// Reconnaît un contenu à ses premiers octets
function sniffBuffer(buf, contentType = '') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const ct = String(contentType || '').toLowerCase();
  const text = b.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart();
  const ascii = (start, len) => b.subarray(start, start + len).toString('latin1');

  if (text.startsWith('#EXTM3U')) return { kind: 'hls', ext: 'm3u8' };
  if (/^(<\?xml[^>]*>\s*)?<MPD[\s>]/i.test(text)) return { kind: 'dash', ext: 'mpd' };
  if (/^\{\s*"clip_id"/.test(text) || (/^\{/.test(text) && /"base_url"\s*:/.test(text) && /"(video|audio)"\s*:\s*\[/.test(text))) {
    return { kind: 'vimeo-json', ext: 'json' };
  }
  if (/^(<!doctype html|<html|<head|<body)/i.test(text)) return { kind: 'page', ext: 'html' };

  if (b.length >= 12 && ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (/^M4A|^M4B/.test(brand)) return { kind: 'direct', ext: 'm4a' };
    if (brand === 'qt  ') return { kind: 'direct', ext: 'mov' };
    if (/^3g/.test(brand)) return { kind: 'direct', ext: '3gp' };
    return { kind: 'direct', ext: 'mp4' };
  }
  if (b.length >= 8 && ['moof', 'styp', 'sidx', 'moov'].includes(ascii(4, 4))) return { kind: 'direct', ext: 'mp4' };
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return { kind: 'direct', ext: /webm/.test(ascii(0, 64)) ? 'webm' : 'mkv' };
  }
  if (ascii(0, 3) === 'ID3') return { kind: 'direct', ext: 'mp3' };
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    // Synchro MPEG audio : couche 00 = AAC (ADTS), sinon MP3
    return { kind: 'direct', ext: (b[1] & 0x06) === 0x00 ? 'aac' : 'mp3' };
  }
  if (ascii(0, 4) === 'OggS') return { kind: 'direct', ext: 'ogg' };
  if (ascii(0, 4) === 'fLaC') return { kind: 'direct', ext: 'flac' };
  if (ascii(0, 4) === 'RIFF') {
    const t = ascii(8, 4);
    return { kind: 'direct', ext: t === 'WAVE' ? 'wav' : t === 'AVI ' ? 'avi' : t === 'WEBP' ? 'webp' : '' };
  }
  if (ascii(0, 3) === 'FLV') return { kind: 'direct', ext: 'flv' };
  if (b.length > 188 && b[0] === 0x47 && b[188] === 0x47) return { kind: 'direct', ext: 'ts' };
  if (ascii(0, 4) === '%PDF') return { kind: 'direct', ext: 'pdf' };
  if (ascii(0, 4) === 'PK\x03\x04') return { kind: 'direct', ext: extFromMime(ct) || 'zip' };
  if (ascii(0, 4) === 'Rar!') return { kind: 'direct', ext: 'rar' };
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return { kind: 'direct', ext: '7z' };
  if (b[0] === 0x1f && b[1] === 0x8b) return { kind: 'direct', ext: 'gz' };
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return { kind: 'direct', ext: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'direct', ext: 'jpg' };
  if (ascii(0, 4) === 'GIF8') return { kind: 'direct', ext: 'gif' };

  if (ct.includes('mpegurl')) return { kind: 'hls', ext: 'm3u8' };
  if (ct.includes('dash+xml')) return { kind: 'dash', ext: 'mpd' };
  if (ct.includes('vnd.vimeo.dash+json')) return { kind: 'vimeo-json', ext: 'json' };
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return { kind: 'page', ext: 'html' };
  return { kind: 'direct', ext: extFromMime(ct) };
}

/**
 * GET avec Range 0-4095 : type réel, taille totale, nom proposé par le serveur.
 */
async function probeUrl(url, headers = {}, signal) {
  const { res, finalUrl } = await safeFetch(url, {
    headers: { ...headers, Range: 'bytes=0-4095' },
    timeout: 20000,
    signal,
  });
  const head = await readBody(res, 4096);
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  let size = null;
  const range = res.headers.get('content-range');
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) size = Number(m[1]);
  } else if (res.status === 200 && res.headers.get('content-length')) {
    size = Number(res.headers.get('content-length')) || null;
  }
  const ok = res.status >= 200 && res.status < 300;
  const sniff = sniffBuffer(head, contentType);
  return {
    ok,
    status: res.status,
    finalUrl,
    mime: contentType.split(';')[0].trim() || null,
    size,
    filename: filenameFromDisposition(res.headers.get('content-disposition')),
    kind: ok ? sniff.kind : null,
    ext: ok ? sniff.ext : null,
    acceptRanges: res.status === 206 || /bytes/i.test(res.headers.get('accept-ranges') || ''),
    head: ok ? head : null,
  };
}

module.exports = { sniffBuffer, probeUrl };
