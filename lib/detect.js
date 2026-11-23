'use strict';
// Classification et normalisation des URLs (plateforme, flux, fichier, fragment...)
const { VIDEO_EXT, AUDIO_EXT, KNOWN_EXT, splitExt } = require('./util');

// Sites gérés par les extracteurs yt-dlp (pages, pas CDN)
const PLATFORM_DOMAINS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com', 'dailymotion.com', 'dai.ly',
  'twitch.tv', 'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com',
  'reddit.com', 'redd.it', 'soundcloud.com', 'bandcamp.com', 'bilibili.com', 'b23.tv', 'pinterest.com',
  'pinterest.fr', 'pin.it', 'linkedin.com', 'streamable.com', 'rumble.com', 'odysee.com', 'kick.com',
  'mixcloud.com', 'ok.ru', 'vk.com', 'vkvideo.ru', 'threads.net', 'threads.com', 'bsky.app', 'loom.com',
  'wistia.com', 'wistia.net', 'nicovideo.jp', 'archive.org', 'ted.com', 'tumblr.com', '9gag.com',
  'snapchat.com', 'audiomack.com', 'arte.tv', 'france.tv', 'rumble.com', 'jwplayer.com', 'jwplatform.com',
  'mediadelivery.net', 'vidyard.com', 'brightcove.net', 'kaltura.com', 'imgur.com', 'giphy.com',
  'coub.com', 'peertube.tv', 'flickr.com', 'vidio.com', 'weibo.com', 'douyin.com', 'kuaishou.com',
];

const JUNK_PATTERNS = [
  /doubleclick\.net|googlesyndication|googleadservices|google-analytics|googletagmanager/i,
  /facebook\.com\/tr|connect\.facebook\.net|analytics|adservice|adsystem|\/ads?\//i,
  /scorecardresearch|quantserve|hotjar|segment\.io|mixpanel|sentry\.io|newrelic|nr-data/i,
];

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isPlatformUrl(url) {
  const u = typeof url === 'string' ? parse(url) : url;
  if (!u || !/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  return PLATFORM_DOMAINS.some((d) => hostMatches(host, d));
}

function isJunkUrl(url) {
  return JUNK_PATTERNS.some((re) => re.test(url));
}

// Fragment de flux (segment HLS/DASH, plage d'octets) : pas la vidéo complète
function isSegmentUrl(url) {
  const u = typeof url === 'string' ? parse(url) : url;
  if (!u) return false;
  const p = u.pathname.toLowerCase();
  const q = u.search.toLowerCase();
  if (/\.(m4s|m4f|cmfv|cmfa|ts)$/.test(p)) return true;
  if (/\/range\//.test(p)) return true;
  if (/(^|[/_\-])(seg|segment|chunk|frag|fragment)[-_]?\d+/.test(p)) return true;
  if (/fragments\(|\/qualitylevels\(/.test(p)) return true;
  if (/[?&](range|bytes|byterange)=\d+-\d*/.test(q)) return true;
  return false;
}

function pathExt(u) {
  const last = u.pathname.split('/').pop() || '';
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch { /* garde brut */ }
  return splitExt(decoded).ext;
}

/**
 * Type d'une URL d'après sa forme :
 * platform | hls | dash | vimeo-json | googlevideo | segment | direct | unknown | invalid
 */
function classifyUrl(url) {
  const u = parse(url);
  if (!u || !/^https?:$/.test(u.protocol)) return { kind: 'invalid' };
  const host = u.hostname.toLowerCase();
  const p = u.pathname.toLowerCase();
  const q = u.search.toLowerCase();

  if (/\/(playlist|master)\.json$/.test(p) &&
      (host.endsWith('vimeocdn.com') || host.includes('vimeo') || /\/v2\/playlist\//.test(p) || q.includes('base64_init'))) {
    return { kind: 'vimeo-json' };
  }
  if (/\.m3u8?$/.test(p) || /[?&](format|type|ext)=m3u8/.test(q)) return { kind: 'hls' };
  if (/\.mpd$/.test(p) || /[?&](format|type|ext)=mpd/.test(q)) return { kind: 'dash' };
  if (/\.ism\/manifest$/.test(p) || /\.f4m$/.test(p)) return { kind: 'stream' };
  if (host.endsWith('googlevideo.com') && p.includes('videoplayback')) return { kind: 'googlevideo' };
  if (isPlatformUrl(u)) return { kind: 'platform' };
  if (isSegmentUrl(u)) return { kind: 'segment' };
  const ext = pathExt(u);
  if (ext && KNOWN_EXT.has(ext) && ext !== 'm3u8' && ext !== 'mpd') {
    return { kind: 'direct', ext, media: VIDEO_EXT.includes(ext) ? 'video' : AUDIO_EXT.includes(ext) ? 'audio' : 'file' };
  }
  return { kind: 'unknown' };
}

// Corrige les URLs copiées/collées et convertit les liens API en liens pages
function normalizeUrl(raw) {
  let s = String(raw || '').trim().replace(/^[<"'(\[]+|[>"')\]]+$/g, '').replace(/&amp;/g, '&');
  if (/^\/\//.test(s)) s = `https:${s}`;
  const u = parse(s);
  if (!u) return s;
  u.hash = '';
  const host = u.hostname.toLowerCase();

  // api.vimeo.com/videos/ID:HASH → player.vimeo.com/video/ID?h=HASH
  if (host === 'api.vimeo.com') {
    const m = /^\/videos\/(\d+)(?::([0-9a-f]+))?/i.exec(u.pathname);
    if (m) return m[2] ? `https://player.vimeo.com/video/${m[1]}?h=${m[2]}` : `https://vimeo.com/${m[1]}`;
  }
  // googlevideo : supprimer la plage partielle demandée par le lecteur
  if (host.endsWith('googlevideo.com')) {
    for (const k of ['range', 'rn', 'rbuf']) u.searchParams.delete(k);
  }
  return u.href;
}

// Extrait la première URL http(s) d'un texte (extension qui envoie des en-têtes dans "url")
function extractUrl(text) {
  const s = String(text || '').trim();
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  const m = /https?:\/\/[^\s'"<>]+/i.exec(s);
  return m ? m[0] : null;
}

module.exports = {
  PLATFORM_DOMAINS,
  hostMatches,
  isPlatformUrl,
  isJunkUrl,
  isSegmentUrl,
  classifyUrl,
  normalizeUrl,
  extractUrl,
};
