'use strict';
// Scraping : extraction des médias d'une page HTML + lecture des playlists HLS
const { classifyUrl, normalizeUrl, isPlatformUrl, isJunkUrl } = require('./detect');
const { VIDEO_EXT, AUDIO_EXT } = require('./util');

const MEDIA_EXT = 'm3u8|mpd|mp4|m4v|webm|mkv|mov|flv|avi|mp3|m4a|aac|ogg|oga|opus|wav|flac';
const FILE_EXT = 'pdf|zip|rar|7z|tar|gz|tgz|epub|apk|exe|msi|dmg|iso|deb|rpm|docx?|xlsx?|pptx?|csv|torrent';
const LINK_RE = new RegExp(`\\.(${MEDIA_EXT}|${FILE_EXT})$`, 'i');
const RAW_MEDIA_RE = new RegExp(
  `https?://[^\\s"'<>\\\\()\\[\\]{}]+?\\.(?:${MEDIA_EXT})(?:\\?[^\\s"'<>\\\\\\[\\]{}]*)?(?=[\\s"'<>\\\\),\\]}]|$)`,
  'gi',
);
const RAW_VIMEO_JSON_RE = /https?:\/\/[^\s"'<>\\]+?\/(?:playlist|master)\.json(?:\?[^\s"'<>\\]*)?/gi;
const EMBED_RES = [
  /https?:\/\/player\.vimeo\.com\/video\/\d+(?:\?[^\s"'<>\\]*)?/gi,
  /https?:\/\/(?:www\.)?vimeo\.com\/(?:video\/)?\d{5,}(?:\/[0-9a-f]{6,})?/gi,
  /https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/(?:embed|shorts|live)\/[\w-]{11}/gi,
  /https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?v=[\w-]{11}/gi,
  /https?:\/\/youtu\.be\/[\w-]{11}/gi,
  /https?:\/\/(?:www\.)?dailymotion\.com\/(?:embed\/)?video\/[a-z0-9]+/gi,
  /https?:\/\/(?:fast\.)?wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/[a-z0-9]+/gi,
  /https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/[0-9a-f]{32}/gi,
  /https?:\/\/iframe\.mediadelivery\.net\/(?:embed|play)\/\d+\/[0-9a-f-]{36}/gi,
  /https?:\/\/(?:www\.)?streamable\.com\/(?:e\/)?[a-z0-9]{4,}/gi,
  /https?:\/\/(?:cdn\.jwplayer\.com|content\.jwplatform\.com)\/(?:players|videos)\/[\w-]+/gi,
];

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;|&#47;/gi, '/');
}

// "https:\/\/x.com\/a" ou "/" (JSON embarqué) → URL normale
function unescapeJsonish(s) {
  return String(s)
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003[dD]/g, '=');
}

function absolutize(raw, base) {
  if (!raw) return null;
  let s = decodeEntities(String(raw).trim());
  if (!s || /^(data|blob|javascript|about|mailto|tel):/i.test(s)) return null;
  if (s.startsWith('//')) s = `https:${s}`;
  try {
    const u = new URL(s, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

function walkJson(node, visit, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    node.forEach((n) => walkJson(n, visit, depth + 1));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    visit(k, v);
    if (v && typeof v === 'object') walkJson(v, visit, depth + 1);
  }
}

// Score : plus haut = meilleur candidat à télécharger
function scoreCandidate(c) {
  const base = { platform: 80, 'vimeo-json': 76, hls: 70, dash: 68, stream: 60, direct: 40 }[c.kind] ?? 20;
  let s = base;
  const ext = c.ext || '';
  if (c.kind === 'direct') s += VIDEO_EXT.includes(ext) ? 20 : AUDIO_EXT.includes(ext) ? 10 : 0;
  if (c.kind === 'hls' && /master|playlist|index/i.test(c.url)) s += 3;
  const hint = /(?:^|[^\d])(2160|1440|1080|720|480|360|240)p?(?:[^\d]|$)/.exec(`${c.url} ${c.label || ''}`);
  if (hint) s += Math.round(parseInt(hint[1], 10) / 270);
  if (c.sources.has('video') || c.sources.has('source')) s += 5;
  if ([...c.sources].some((x) => x.startsWith('meta:'))) s += 3;
  if (/preview|teaser|trailer|thumb|sample|_low|_small|sprite/i.test(c.url)) s -= 12;
  return s;
}

/**
 * Extrait les médias d'une page HTML.
 * @returns {{ title, thumbnail, candidates: Array<{url, kind, ext, label, mime, source, score}> }}
 */
function scrapeHtml(html, pageUrl) {
  const found = new Map();
  let baseUrl = pageUrl;
  let title = null;
  let thumbnail = null;

  const baseTag = /<base\s[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html);
  if (baseTag) baseUrl = absolutize(baseTag[1], pageUrl) || pageUrl;

  const add = (raw, source, extra = {}) => {
    const abs = absolutize(raw, baseUrl);
    if (!abs || isJunkUrl(abs)) return;
    const url = normalizeUrl(abs);
    if (url === normalizeUrl(pageUrl)) return;
    const cls = classifyUrl(url);
    if (['invalid', 'segment', 'googlevideo'].includes(cls.kind)) return;
    if (cls.kind === 'unknown' && !extra.force) return;
    const prev = found.get(url);
    if (prev) {
      prev.sources.add(source);
      if (!prev.label && extra.label) prev.label = extra.label;
      return;
    }
    found.set(url, {
      url,
      kind: cls.kind === 'unknown' ? 'direct' : cls.kind,
      ext: cls.ext || '',
      label: extra.label || null,
      mime: extra.mime || null,
      sources: new Set([source]),
    });
  };

  // 1. Balises HTML
  for (const m of html.matchAll(/<(video|audio|source|iframe|embed|a|meta|link)\b[^>]*>/gi)) {
    const tag = m[1].toLowerCase();
    const a = parseAttrs(m[0]);
    if (tag === 'video' || tag === 'audio' || tag === 'source') {
      for (const k of ['src', 'data-src', 'data-video-src', 'data-hls', 'data-mp4', 'data-url', 'data-stream']) {
        if (a[k]) add(a[k], tag === 'source' ? 'source' : tag, { force: true, mime: a.type, label: a.label || a.title || a.res || a.size || a['data-quality'] });
      }
      if (tag === 'video' && a.poster && !thumbnail) thumbnail = absolutize(a.poster, baseUrl);
    } else if (tag === 'iframe' || tag === 'embed') {
      const src = absolutize(a.src || a['data-src'], baseUrl);
      if (src && isPlatformUrl(src)) add(src, 'iframe');
    } else if (tag === 'meta') {
      const key = (a.property || a.name || a.itemprop || '').toLowerCase();
      const content = a.content;
      if (!content) continue;
      if (['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream', 'og:audio', 'og:audio:url', 'og:audio:secure_url', 'contenturl'].includes(key)) {
        add(content, `meta:${key}`, { force: true });
      } else if (key === 'twitter:player' || key === 'embedurl') {
        const abs = absolutize(content, baseUrl);
        if (abs && isPlatformUrl(abs)) add(abs, `meta:${key}`);
      } else if ((key === 'og:title' || key === 'twitter:title') && !title) {
        title = decodeEntities(content).trim();
      } else if ((key === 'og:image' || key === 'twitter:image') && !thumbnail) {
        thumbnail = absolutize(content, baseUrl);
      }
    } else if (tag === 'a' && a.href) {
      const abs = absolutize(a.href, baseUrl);
      if (!abs) continue;
      if (LINK_RE.test(new URL(abs).pathname)) add(abs, 'link', { force: true });
      else if (isPlatformUrl(abs) && /\/(video|watch|embed|shorts|reel|clip|pin)\b|\/\d{6,}/i.test(abs)) add(abs, 'link');
    } else if (tag === 'link' && /preload/i.test(a.rel || '') && /video|audio/i.test(a.as || '') && a.href) {
      add(a.href, 'preload', { force: true });
    }
  }

  // 2. JSON-LD (VideoObject…)
  for (const m of html.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walkJson(JSON.parse(m[1].trim()), (k, v) => {
        if (typeof v !== 'string') return;
        if (k === 'contentUrl') add(v, 'json-ld', { force: true });
        else if (k === 'embedUrl') {
          const abs = absolutize(v, baseUrl);
          if (abs && isPlatformUrl(abs)) add(abs, 'json-ld');
        } else if (k === 'thumbnailUrl' && !thumbnail) thumbnail = absolutize(v, baseUrl);
      });
    } catch { /* JSON invalide */ }
  }

  // 3. URLs brutes (scripts, JSON embarqué, attributs data-*)
  const text = unescapeJsonish(decodeEntities(html));
  for (const m of text.matchAll(RAW_MEDIA_RE)) add(m[0], 'html', { force: true });
  for (const m of text.matchAll(RAW_VIMEO_JSON_RE)) add(m[0], 'html', { force: true });
  for (const re of EMBED_RES) for (const m of text.matchAll(re)) add(m[0], 'embed');

  if (!title) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (t) title = decodeEntities(t[1]).replace(/\s+/g, ' ').trim() || null;
  }

  const candidates = [...found.values()]
    .map((c) => ({ ...c, score: scoreCandidate(c), source: [...c.sources][0], sources: [...c.sources] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 200);
  return { title, thumbnail, candidates };
}

// ================= HLS =================
function parseHlsAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

function parseHls(text, baseUrl) {
  const body = String(text || '').replace(/^﻿/, '');
  if (!/^\s*#EXTM3U/.test(body)) return null;
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const audios = [];
  let segments = 0;
  let duration = 0;
  let encryption = null;
  let drm = false;
  let ended = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseHlsAttrs(line.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      const res = /(\d+)x(\d+)/.exec(attrs.RESOLUTION || '');
      variants.push({
        url: absolutize(lines[j], baseUrl),
        bandwidth: Number(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH) || 0,
        width: res ? Number(res[1]) : null,
        height: res ? Number(res[2]) : null,
        codecs: attrs.CODECS || null,
        fps: Number(attrs['FRAME-RATE']) || null,
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseHlsAttrs(line.slice(13));
      if (a.TYPE === 'AUDIO') audios.push({ name: a.NAME, language: a.LANGUAGE || null, url: absolutize(a.URI, baseUrl) });
    } else if (line.startsWith('#EXTINF:')) {
      segments++;
      duration += parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = parseHlsAttrs(line.slice(line.indexOf(':') + 1));
      if (a.METHOD && a.METHOD !== 'NONE') encryption = a.METHOD;
      if (/SAMPLE-AES/.test(a.METHOD || '') && a.KEYFORMAT && a.KEYFORMAT !== 'identity') drm = true;
      if (/widevine|playready|streamingkeydelivery|fairplay/i.test(`${a.KEYFORMAT || ''} ${a.URI || ''}`)) drm = true;
    } else if (line === '#EXT-X-ENDLIST' || line === '#EXT-X-PLAYLIST-TYPE:VOD') {
      ended = true;
    }
  }
  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);
  return {
    isMaster: variants.length > 0,
    variants,
    audios,
    segments,
    duration: Math.round(duration),
    encryption,
    drm,
    isLive: variants.length === 0 && !ended,
  };
}

module.exports = { scrapeHtml, parseHls, absolutize, decodeEntities, unescapeJsonish };
