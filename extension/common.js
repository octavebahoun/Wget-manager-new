// common.js — fonctions partagées (service worker, popup, options)

export const VERSION = chrome.runtime.getManifest().version;

export const DEFAULT_SETTINGS = {
  serverUrl: 'http://localhost:3000',
  apiKey: '',
  defaultQuality: 'best',
  sendCookies: true, // cookies + en-tête Authorization (vidéos privées, sites connectés)
  autoFetch: false, // rapatrie le fichier sur ce PC quand le serveur a fini
  notifications: true,
  autoClose: false,
};

export function normalizeServerUrl(value) {
  let s = String(value || '').trim();
  if (!s) return DEFAULT_SETTINGS.serverUrl;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, '');
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored, serverUrl: normalizeServerUrl(stored.serverUrl) };
}

// Appel à l'API du serveur Web Wget
export async function apiFetch(path, { method = 'GET', body, timeout = 15000, settings } = {}) {
  const cfg = settings || (await getSettings());
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cfg.apiKey) headers['X-API-Key'] = cfg.apiKey;
  let res;
  try {
    res = await fetch(cfg.serverUrl + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error(`Serveur injoignable (${cfg.serverUrl}). Est-il démarré ?`);
  }
  let data = null;
  try {
    data = await res.json();
  } catch { /* réponse vide */ }
  if (res.status === 401) throw new Error('Clé API refusée : vérifiez les options de l\'extension');
  if (!res.ok) throw new Error(data?.error || `Erreur serveur (HTTP ${res.status})`);
  return data;
}

// ================= CLASSIFICATION DES MÉDIAS =================
export const PLATFORM_DOMAINS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com', 'dailymotion.com', 'dai.ly',
  'twitch.tv', 'tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'x.com', 'twitter.com',
  'reddit.com', 'redd.it', 'soundcloud.com', 'bandcamp.com', 'bilibili.com', 'b23.tv', 'pinterest.com',
  'pinterest.fr', 'pin.it', 'linkedin.com', 'streamable.com', 'rumble.com', 'odysee.com', 'kick.com',
  'mixcloud.com', 'ok.ru', 'vk.com', 'vkvideo.ru', 'threads.net', 'threads.com', 'bsky.app', 'loom.com',
  'wistia.com', 'wistia.net', 'nicovideo.jp', 'archive.org', 'ted.com', 'tumblr.com', '9gag.com',
  'snapchat.com', 'audiomack.com', 'arte.tv', 'france.tv', 'jwplayer.com', 'jwplatform.com',
  'mediadelivery.net', 'vidyard.com', 'brightcove.net', 'kaltura.com', 'imgur.com', 'coub.com',
  'flickr.com', 'weibo.com', 'douyin.com', 'kuaishou.com',
];

// Pages d'accueil / listes : pas une vidéo précise
const PLATFORM_NON_MEDIA = /^\/?(|feed.*|results|search.*|explore|home|login|signup|settings.*|account.*)$/i;

const JUNK = [
  /doubleclick\.net|googlesyndication|googleadservices|google-analytics|googletagmanager/i,
  /facebook\.com\/tr|connect\.facebook\.net|\/ads?\/|adservice|adsystem|scorecardresearch|hotjar|segment\.io/i,
];

const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'wmv', '3gp', 'ogv', 'mpg', 'mpeg']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba']);
const FILE_EXT = new Set(['pdf', 'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'epub', 'apk', 'exe', 'msi', 'dmg', 'iso',
  'deb', 'rpm', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'torrent', 'srt', 'vtt']);

export function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isPlatformUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    return PLATFORM_DOMAINS.some((d) => hostMatches(host, d));
  } catch {
    return false;
  }
}

// Page de plateforme qui pointe vers un contenu précis (pas l'accueil ni une chaîne entière)
export function isPlatformMediaPage(url) {
  if (!isPlatformUrl(url)) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (hostMatches(host, 'youtube.com') || hostMatches(host, 'youtube-nocookie.com')) {
      return /^\/(watch|shorts\/|live\/|embed\/)/.test(u.pathname) && (u.pathname !== '/watch' || u.searchParams.has('v'));
    }
    return !PLATFORM_NON_MEDIA.test(u.pathname.replace(/\/$/, ''));
  } catch {
    return false;
  }
}

// Cadre intégré qui est un vrai lecteur vidéo (pas un bouton "J'aime" ou un widget)
export function isEmbedPlayerUrl(url) {
  if (!isPlatformMediaPage(url)) return false;
  try {
    const u = new URL(url);
    return /embed|player|video|\/e\/|\/p\/|\/reel\/|\/clip/i.test(`${u.hostname}${u.pathname}`);
  } catch {
    return false;
  }
}

export function isJunkUrl(url) {
  return JUNK.some((re) => re.test(url));
}

export function isSegmentUrl(url) {
  let u;
  try {
    u = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  const p = u.pathname.toLowerCase();
  const q = u.search.toLowerCase();
  return /\.(m4s|m4f|cmfv|cmfa|ts)$/.test(p)
    || /\/range\//.test(p)
    || /(^|[/_-])(seg|segment|chunk|frag|fragment)[-_]?\d+/.test(p)
    || /fragments\(|\/qualitylevels\(/.test(p)
    || /[?&](range|bytes|byterange)=\d+-\d*/.test(q);
}

function extOf(pathname) {
  const last = pathname.split('/').pop() || '';
  const m = /\.([a-z0-9]{2,5})$/i.exec(last);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Type d'un média : hls | dash | vimeo-json | platform | video | audio | file — ou null (inintéressant)
 */
export function classifyMedia(url, mime = '') {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || isJunkUrl(url)) return null;
  const p = u.pathname.toLowerCase();
  const host = u.hostname.toLowerCase();
  const m = String(mime || '').toLowerCase();

  if ((/\/(playlist|master)\.json$/.test(p) && (host.endsWith('vimeocdn.com') || /\/v2\/playlist\//.test(p) || u.search.includes('base64_init')))
    || m.includes('vnd.vimeo.dash+json')) {
    return { kind: 'vimeo-json', label: 'Vimeo' };
  }
  if (/\.m3u8?$/.test(p) || m.includes('mpegurl')) return { kind: 'hls', label: 'HLS' };
  if (/\.mpd$/.test(p) || m.includes('dash+xml')) return { kind: 'dash', label: 'DASH' };
  if (host.endsWith('googlevideo.com')) return null; // flux internes YouTube : on utilise la page
  if (isSegmentUrl(u) || m === 'video/mp2t' || m.includes('iso.segment')) return null;
  if (isPlatformUrl(url)) return { kind: 'platform', label: 'Lecteur' };
  const ext = extOf(p);
  if (m.startsWith('video/') || VIDEO_EXT.has(ext)) return { kind: 'video', label: (ext || m.split('/')[1] || 'vidéo').toUpperCase() };
  if (m.startsWith('audio/') || AUDIO_EXT.has(ext)) return { kind: 'audio', label: (ext || m.split('/')[1] || 'audio').toUpperCase() };
  if (FILE_EXT.has(ext)) return { kind: 'file', label: ext.toUpperCase() };
  return null;
}

// Type transmis au serveur (indice de routage)
export function serverKind(kind) {
  return { hls: 'hls', dash: 'dash', 'vimeo-json': 'vimeo-json', platform: 'platform', page: 'page' }[kind] || 'direct';
}

export const KIND_LABELS = {
  platform: 'Page / lecteur',
  'vimeo-json': 'Vimeo',
  hls: 'HLS',
  dash: 'DASH',
  video: 'Vidéo',
  audio: 'Audio',
  file: 'Fichier',
  page: 'Page',
};

// Score : plus haut = meilleur choix par défaut
export function scoreItem(item) {
  const base = { platform: 80, 'vimeo-json': 86, hls: 78, dash: 76, video: 60, audio: 45, file: 25, page: 20 }[item.kind] ?? 10;
  let s = base;
  if (item.isPage) s += 12;
  if (item.kind === 'hls') {
    if (/master|playlist|index|manifest/i.test(item.url)) s += 4;
    if (/[_-](\d{3,4})p?[_.-]|[_/](\d{3,4})w\b|\/\d{3,4}\//i.test(item.url)) s -= 4; // variante probable
    if (item.order === 0) s += 2;
  }
  if (item.size) s += Math.min(10, Math.log10(item.size / 1e5 + 1) * 4);
  if (item.size && item.size < 300 * 1024 && (item.kind === 'video' || item.kind === 'audio')) s -= 20;
  if (item.source === 'réseau') s += 2;
  if (/preview|teaser|thumb|sprite|sample/i.test(item.url)) s -= 15;
  return Math.round(s * 10) / 10;
}

export function displayName(url) {
  try {
    const u = new URL(url);
    let last = u.pathname.split('/').filter(Boolean).pop() || '';
    try {
      last = decodeURIComponent(last);
    } catch { /* garde brut */ }
    if (!last || last.length < 3) return u.hostname;
    return last.length > 60 ? `${last.slice(0, 57)}…` : last;
  } catch {
    return String(url || '').slice(0, 60);
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${parseFloat((n / 1024 ** i).toFixed(1))} ${units[i]}`;
}

// Nom de fichier local sûr (chrome.downloads refuse certains caractères)
export function safeLocalName(name, fallbackExt = '') {
  let s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!s) s = 'telechargement';
  if (s.length > 150) s = s.slice(0, 150);
  if (fallbackExt && !/\.[a-z0-9]{2,5}$/i.test(s)) s += `.${fallbackExt}`;
  return s;
}

export function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}
