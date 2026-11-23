// background.js — Service worker : détection réseau, scan des pages, envoi au serveur
import {
  getSettings, apiFetch, classifyMedia, isPlatformUrl, isPlatformMediaPage, isEmbedPlayerUrl, scoreItem,
  serverKind, displayName, safeLocalName, encodePath,
} from './common.js';

const MAX_ITEMS = 150;
const AUTO_FETCH_KEY = 'autoFetchJobs';
const AUTO_FETCH_ALARM = 'wget-autofetch';
const REQUEST_TYPES = ['media', 'xmlhttprequest', 'other', 'object', 'sub_frame'];

// ================= ÉTAT PAR ONGLET (persisté en session : survit à la mise en veille du worker) =================
const tabs = new Map(); // tabId -> { items: Map<url, item>, flags: {drm, mse}, pageUrl }
const saveTimers = new Map();
const pendingHeaders = new Map(); // requestId -> { referer, origin, authorization }

async function getTab(tabId) {
  if (tabs.has(tabId)) return tabs.get(tabId);
  const key = `tab:${tabId}`;
  let data = null;
  try {
    data = (await chrome.storage.session.get(key))[key];
  } catch { /* stockage indisponible */ }
  if (tabs.has(tabId)) return tabs.get(tabId);
  const entry = {
    items: new Map((data?.items || []).map((i) => [i.url, i])),
    flags: data?.flags || {},
    pageUrl: data?.pageUrl || null,
  };
  tabs.set(tabId, entry);
  return entry;
}

function persistTab(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(tabId, setTimeout(async () => {
    saveTimers.delete(tabId);
    const t = tabs.get(tabId);
    if (!t) return;
    try {
      await chrome.storage.session.set({
        [`tab:${tabId}`]: { items: [...t.items.values()].slice(-MAX_ITEMS), flags: t.flags, pageUrl: t.pageUrl },
      });
    } catch (e) {
      console.warn('[WGET] Sauvegarde session impossible', e);
    }
  }, 400));
}

async function resetTab(tabId, pageUrl = null) {
  clearTimeout(saveTimers.get(tabId));
  tabs.set(tabId, { items: new Map(), flags: {}, pageUrl });
  try {
    await chrome.storage.session.remove(`tab:${tabId}`);
  } catch { /* ignore */ }
  updateBadge(tabId);
}

async function addItem(tabId, item) {
  const t = await getTab(tabId);
  const prev = t.items.get(item.url);
  if (prev) {
    for (const [k, v] of Object.entries(item)) if (v !== undefined && v !== null && v !== '') prev[k] = v;
  } else {
    if (t.items.size >= MAX_ITEMS) t.items.delete(t.items.keys().next().value);
    t.items.set(item.url, { ...item, firstSeen: Date.now(), order: t.items.size });
  }
  persistTab(tabId);
  updateBadge(tabId);
}

async function updateBadge(tabId) {
  try {
    const t = tabs.get(tabId);
    const count = t ? [...t.items.values()].filter((i) => i.kind !== 'file').length : 0;
    if (t?.flags?.drm) {
      await chrome.action.setBadgeText({ tabId, text: 'DRM' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' });
    } else if (count) {
      await chrome.action.setBadgeText({ tabId, text: String(Math.min(count, 99)) });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#8b5cf6' });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch { /* onglet fermé */ }
}

// ================= DÉTECTION RÉSEAU =================
// 1) on mémorise Referer/Origin/Authorization de chaque requête (pour la rejouer côté serveur)
chrome.webRequest.onSendHeaders.addListener((d) => {
  if (d.tabId < 0) return;
  let referer;
  let origin;
  let authorization;
  for (const h of d.requestHeaders || []) {
    const n = h.name.toLowerCase();
    if (n === 'referer') referer = h.value;
    else if (n === 'origin') origin = h.value;
    else if (n === 'authorization') authorization = h.value;
  }
  pendingHeaders.set(d.requestId, { referer, origin, authorization });
  if (pendingHeaders.size > 3000) {
    let n = 0;
    for (const key of pendingHeaders.keys()) {
      pendingHeaders.delete(key);
      if (++n >= 1000) break;
    }
  }
}, { urls: ['<all_urls>'], types: REQUEST_TYPES }, ['requestHeaders', 'extraHeaders']);

// 2) à la réponse : type MIME + taille → est-ce un média ?
chrome.webRequest.onHeadersReceived.addListener((d) => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  const req = pendingHeaders.get(d.requestId) || {};
  if (d.type === 'sub_frame') {
    if (isEmbedPlayerUrl(d.url)) {
      addItem(d.tabId, { url: d.url, kind: 'platform', typeLabel: 'Lecteur', source: 'lecteur intégré', referer: req.referer || d.initiator });
    }
    return;
  }
  const headers = {};
  for (const h of d.responseHeaders || []) headers[h.name.toLowerCase()] = h.value;
  const mime = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const cls = classifyMedia(d.url, mime);
  if (!cls || cls.kind === 'platform' || cls.kind === 'file') return;
  let size = null;
  const range = headers['content-range'];
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) size = Number(m[1]);
  } else if (headers['content-length']) {
    size = Number(headers['content-length']) || null;
  }
  // Trop petit : publicité, aperçu ou fragment
  if ((cls.kind === 'video' || cls.kind === 'audio') && size !== null && size < 150 * 1024) return;
  addItem(d.tabId, {
    url: d.url, kind: cls.kind, typeLabel: cls.label, mime, size, source: 'réseau',
    referer: req.referer, origin: req.origin, authorization: req.authorization,
  });
}, { urls: ['<all_urls>'], types: REQUEST_TYPES }, ['responseHeaders']);

const forgetRequest = (d) => pendingHeaders.delete(d.requestId);
chrome.webRequest.onCompleted.addListener(forgetRequest, { urls: ['<all_urls>'], types: REQUEST_TYPES });
chrome.webRequest.onErrorOccurred.addListener(forgetRequest, { urls: ['<all_urls>'], types: REQUEST_TYPES });

// ================= NAVIGATION =================
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) resetTab(d.tabId, d.url);
});

// Sites "SPA" (YouTube, Skool…) : nouvelle page sans rechargement
chrome.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const t = await getTab(d.tabId);
  const samePath = (() => {
    try {
      const a = new URL(t.pageUrl);
      const b = new URL(d.url);
      return a.origin === b.origin && a.pathname === b.pathname && a.searchParams.get('v') === b.searchParams.get('v');
    } catch {
      return false;
    }
  })();
  if (!samePath) resetTab(d.tabId, d.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  getTab(tabId).then(() => updateBadge(tabId));
});

// ================= SCAN DE LA PAGE (exécuté dans chaque cadre) =================
// Fonction autonome : sérialisée par chrome.scripting, aucune variable externe.
function domScan() {
  const out = [];
  const seen = new Set();
  const add = (raw, source, extra = {}) => {
    try {
      if (!raw || typeof raw !== 'string') return;
      const value = raw.trim().replace(/&amp;/g, '&');
      if (/^(blob|data|javascript|about|mailto):/i.test(value)) return;
      const abs = new URL(value, location.href);
      if (!/^https?:$/.test(abs.protocol)) return;
      abs.hash = '';
      const url = abs.href;
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ url, source, ...extra });
    } catch { /* URL invalide */ }
  };
  let mse = false;

  document.querySelectorAll('video, audio').forEach((el) => {
    const src = el.currentSrc || el.src;
    if (src && src.startsWith('blob:')) mse = true;
    else if (src) {
      add(src, el.tagName.toLowerCase(), {
        width: el.videoWidth || null,
        height: el.videoHeight || null,
        duration: Number.isFinite(el.duration) ? Math.round(el.duration) : null,
      });
    }
    el.querySelectorAll('source[src]').forEach((s) => add(s.getAttribute('src'), 'source', { mime: s.type || null, label: s.getAttribute('label') || s.getAttribute('size') || null }));
    for (const attr of ['data-src', 'data-video-src', 'data-hls', 'data-mp4', 'data-stream', 'data-url']) {
      const v = el.getAttribute(attr);
      if (v) add(v, 'data');
    }
  });

  for (const key of ['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream', 'og:audio', 'og:audio:secure_url']) {
    document.querySelectorAll(`meta[property="${key}"], meta[name="${key}"]`).forEach((m) => add(m.content, 'meta'));
  }
  document.querySelectorAll('iframe[src], embed[src]').forEach((f) => add(f.src, 'iframe'));
  document.querySelectorAll('a[href]').forEach((a) => {
    if (/\.(mp4|m4v|webm|mkv|mov|avi|flv|mp3|m4a|aac|ogg|opus|wav|flac|m3u8|mpd|pdf|zip|rar|7z|tar|gz|epub|apk|exe|msi|dmg|iso|docx?|xlsx?|pptx?|csv|torrent)([?#]|$)/i.test(a.href)) {
      add(a.href, 'lien', { label: (a.textContent || '').trim().slice(0, 80) || null });
    }
  });
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const walk = (o, depth = 0) => {
        if (!o || typeof o !== 'object' || depth > 10) return;
        if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
        for (const [k, v] of Object.entries(o)) {
          if ((k === 'contentUrl' || k === 'embedUrl') && typeof v === 'string') add(v, 'json-ld');
          else if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      walk(JSON.parse(s.textContent));
    } catch { /* JSON invalide */ }
  });

  // Ressources déjà chargées avant l'ouverture de la popup
  try {
    performance.getEntriesByType('resource').forEach((e) => {
      if (/\.(m3u8|mpd)([?#]|$)|\/(playlist|master)\.json([?#]|$)|\.(mp4|webm|m4a|mp3)([?#]|$)/i.test(e.name)) {
        add(e.name, 'historique', { size: e.decodedBodySize || e.encodedBodySize || null });
      }
    });
  } catch { /* indisponible */ }

  // URLs cachées dans le code de la page (configurations de lecteurs)
  try {
    const html = document.documentElement.outerHTML.slice(0, 4000000)
      .replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
    const patterns = [
      /https?:\/\/[^\s"'<>\\()]+?\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?/gi,
      /https?:\/\/[^\s"'<>\\]+?\/(?:playlist|master)\.json(?:\?[^\s"'<>\\]*)?/gi,
      /https?:\/\/player\.vimeo\.com\/video\/\d+(?:\?[^\s"'<>\\]*)?/gi,
      /https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/[\w-]{11}/gi,
      /https?:\/\/(?:fast\.)?wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/[a-z0-9]+/gi,
      /https?:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/[0-9a-f]{32}/gi,
      /https?:\/\/iframe\.mediadelivery\.net\/(?:embed|play)\/\d+\/[0-9a-f-]{36}/gi,
      /https?:\/\/[^\s"'<>\\()]+?\.(?:mp4|webm|m4a|mp3)(?:\?[^\s"'<>\\]*)?(?=["'\s<>\\),]|$)/gi,
    ];
    for (const re of patterns) {
      let m;
      let n = 0;
      while ((m = re.exec(html)) && n++ < 200) add(m[0], 'code');
    }
  } catch { /* page trop grande */ }

  return { frameUrl: location.href, isTop: window === window.top, title: document.title, items: out.slice(0, 400), mse };
}

async function collectMedia(tab) {
  const t = await getTab(tab.id);
  const items = new Map();
  for (const it of t.items.values()) items.set(it.url, { ...it });

  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: domScan });
    for (const r of results || []) {
      const res = r.result;
      if (!res) continue;
      if (res.mse) t.flags.mse = true;
      for (const raw of res.items) {
        const cls = classifyMedia(raw.url, raw.mime);
        if (!cls) continue;
        if (cls.kind === 'platform' && (raw.source === 'iframe' ? !isEmbedPlayerUrl(raw.url) : !isPlatformMediaPage(raw.url))) continue;
        const existing = items.get(raw.url);
        if (existing) {
          if (!existing.label && raw.label) existing.label = raw.label;
          if (!existing.size && raw.size) existing.size = raw.size;
          continue;
        }
        items.set(raw.url, {
          url: raw.url,
          kind: cls.kind,
          label: raw.label || null,
          typeLabel: cls.label,
          mime: raw.mime || null,
          size: raw.size || null,
          source: raw.source,
          referer: res.isTop ? tab.url : res.frameUrl,
          frameUrl: res.frameUrl,
          height: raw.height || null,
          duration: raw.duration || null,
        });
      }
    }
  } catch {
    // pages protégées (chrome://, Web Store…) : on garde la détection réseau
  }

  if (tab.url && isPlatformMediaPage(tab.url)) {
    items.set(tab.url, { ...(items.get(tab.url) || {}), url: tab.url, kind: 'platform', label: 'Cette page (yt-dlp)', source: 'page', isPage: true, referer: null });
  }

  const list = [...items.values()]
    .map((i) => ({ ...i, score: scoreItem(i) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 120);
  persistTab(tab.id);
  updateBadge(tab.id);
  return {
    tab: { id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
    items: list,
    flags: { ...t.flags },
  };
}

// ================= ENVOI AU SERVEUR =================
async function collectCookies(urls) {
  const jar = new Map();
  for (const u of new Set(urls.filter((x) => x && /^https?:/i.test(x)))) {
    try {
      for (const c of await chrome.cookies.getAll({ url: u })) {
        jar.set(`${c.domain}|${c.path}|${c.name}`, {
          domain: c.domain, hostOnly: c.hostOnly, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
          expirationDate: c.expirationDate, name: c.name, value: c.value,
        });
      }
    } catch { /* URL non autorisée */ }
  }
  return [...jar.values()];
}

async function buildPayload(item, tab, settings, options, count) {
  const pageUrl = tab?.url && /^https?:/i.test(tab.url) ? tab.url : null;
  const payload = {
    url: item.url,
    kind: serverKind(item.kind),
    pageUrl,
    title: tab?.title || undefined,
    referer: item.referer || pageUrl || undefined,
    origin: item.origin || undefined,
    ua: navigator.userAgent,
    quality: options.quality || settings.defaultQuality || 'best',
    customFilename: count === 1 && options.filename ? options.filename : undefined,
    source: 'extension',
  };
  if (settings.sendCookies) {
    const jar = await collectCookies([item.url, pageUrl, item.referer, item.frameUrl]);
    if (jar.length) payload.cookieJar = jar;
    if (item.authorization) payload.headers = { Authorization: item.authorization };
  }
  return payload;
}

async function sendItems({ tabId, items, options = {} }) {
  const settings = await getSettings();
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch { /* onglet fermé */ }
  const jobs = [];
  const errors = [];
  for (const item of items) {
    try {
      const body = await buildPayload(item, tab, settings, options, items.length);
      const data = await apiFetch('/download', { method: 'POST', body, settings });
      jobs.push(...(data.jobs || [{ id: data.id, url: item.url }]));
      for (const e of data.errors || []) errors.push(e.error);
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (settings.autoFetch && jobs.length) await trackAutoFetch(jobs.map((j) => j.id), settings);
  return { ok: jobs.length > 0, jobs, errors };
}

// ================= RAPATRIEMENT AUTOMATIQUE SUR CE PC =================
async function trackAutoFetch(ids, settings) {
  const stored = (await chrome.storage.local.get(AUTO_FETCH_KEY))[AUTO_FETCH_KEY] || [];
  const now = Date.now();
  for (const id of ids) stored.push({ id, serverUrl: settings.serverUrl, added: now });
  await chrome.storage.local.set({ [AUTO_FETCH_KEY]: stored.slice(-200) });
  await chrome.alarms.create(AUTO_FETCH_ALARM, { delayInMinutes: 0.25, periodInMinutes: 0.5 });
}

async function checkAutoFetch() {
  const pending = (await chrome.storage.local.get(AUTO_FETCH_KEY))[AUTO_FETCH_KEY] || [];
  if (!pending.length) {
    await chrome.alarms.clear(AUTO_FETCH_ALARM);
    return;
  }
  const settings = await getSettings();
  const mine = pending.filter((p) => p.serverUrl === settings.serverUrl);
  let jobs = [];
  try {
    jobs = await apiFetch(`/api/jobs?ids=${mine.map((p) => p.id).join(',')}`, { settings });
  } catch {
    return; // serveur indisponible : on réessaiera
  }
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const keep = [];
  for (const entry of mine) {
    const job = byId.get(entry.id);
    if (!job) continue;
    if (job.status === 'completed') {
      for (const file of job.files || []) {
        try {
          await chrome.downloads.download(serverDownloadOptions(settings, 'transfer', file));
        } catch (e) {
          console.warn('[WGET] Rapatriement impossible', e);
        }
      }
      if (settings.notifications) notify('Fichier récupéré sur ce PC', (job.files || [])[0] || job.title || job.url);
    } else if (job.status === 'error') {
      if (settings.notifications) notify('Échec du téléchargement', `${job.title || displayName(job.url)}\n${job.error || ''}`);
    } else if (job.status !== 'cancelled' && Date.now() - entry.added < 24 * 3600 * 1000) {
      keep.push(entry);
    }
  }
  await chrome.storage.local.set({ [AUTO_FETCH_KEY]: keep });
  if (!keep.length) await chrome.alarms.clear(AUTO_FETCH_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_FETCH_ALARM) checkAutoFetch();
});

// ================= NOTIFICATIONS =================
function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: String(message || '').slice(0, 300),
    priority: 0,
  }).catch(() => {});
}

async function notifyResult(result, label) {
  const settings = await getSettings();
  if (!settings.notifications) return;
  if (result.ok) notify('Envoyé au serveur', label || `${result.jobs.length} téléchargement(s) lancé(s)`);
  else notify('Échec de l\'envoi', result.errors[0] || 'Erreur inconnue');
}

// ================= TÉLÉCHARGEMENT LOCAL =================
// Fichier du serveur → dossier Téléchargements du PC (route "transfer" = supprime ensuite du serveur)
function serverDownloadOptions(settings, route, file) {
  const opts = {
    url: `${settings.serverUrl}/${route}/${encodePath(file)}`,
    filename: safeLocalName(file.split('/').pop()),
    conflictAction: 'uniquify',
  };
  if (settings.apiKey) opts.headers = [{ name: 'X-API-Key', value: settings.apiKey }];
  return opts;
}
async function downloadLocal({ url, filename }) {
  const ext = (/\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(new URL(url).pathname) || [])[1] || '';
  const opts = { url, conflictAction: 'uniquify', saveAs: false };
  if (filename) opts.filename = safeLocalName(filename, ext);
  const id = await chrome.downloads.download(opts);
  return { ok: true, id };
}

async function downloadFromServer({ file }) {
  const settings = await getSettings();
  const id = await chrome.downloads.download(serverDownloadOptions(settings, 'dl', file));
  return { ok: true, id };
}

// ================= MESSAGES (popup, content script) =================
const HANDLERS = {
  async PAGE_SIGNAL(msg, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return null;
    const t = await getTab(tabId);
    if (msg.signal === 'drm') t.flags.drm = true;
    if (msg.signal === 'mse') t.flags.mse = true;
    persistTab(tabId);
    updateBadge(tabId);
    return null;
  },
  async GET_MEDIA(msg) {
    const tab = await chrome.tabs.get(msg.tabId);
    return collectMedia(tab);
  },
  SEND(msg) {
    return sendItems(msg);
  },
  DOWNLOAD_LOCAL(msg) {
    return downloadLocal(msg);
  },
  DOWNLOAD_FROM_SERVER(msg) {
    return downloadFromServer(msg);
  },
  async SERVER_STATUS() {
    try {
      const health = await apiFetch('/health', { timeout: 4000 });
      return { ok: true, ...health };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },
  async JOBS() {
    const jobs = await apiFetch('/api/jobs', { timeout: 5000 });
    return { jobs: jobs.slice(0, 6) };
  },
  async CANCEL_JOB(msg) {
    return apiFetch('/cancel', { method: 'POST', body: { id: msg.id } });
  },
  async CLEAR_TAB(msg) {
    await resetTab(msg.tabId);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((res) => sendResponse(res), (e) => sendResponse({ error: e?.message || String(e) }));
  return true; // réponse asynchrone
});

// ================= MENU CLIC DROIT =================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'wget-link', title: 'Télécharger ce lien avec Web Wget', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'wget-media', title: 'Télécharger ce média avec Web Wget', contexts: ['video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'wget-page', title: 'Télécharger la vidéo de cette page', contexts: ['page', 'frame'] });
    chrome.contextMenus.create({ id: 'wget-all', title: 'Envoyer tous les médias détectés', contexts: ['page', 'frame'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  const referer = info.frameUrl || info.pageUrl;
  let items = [];
  if (info.menuItemId === 'wget-link' && info.linkUrl) {
    items = [{ url: info.linkUrl, kind: classifyMedia(info.linkUrl)?.kind || 'page', referer }];
  } else if (info.menuItemId === 'wget-media') {
    if (info.srcUrl && /^https?:/i.test(info.srcUrl)) {
      const kind = info.mediaType === 'image' ? 'file' : classifyMedia(info.srcUrl)?.kind || 'video';
      items = [{ url: info.srcUrl, kind, referer }];
    } else {
      // blob: (lecteur MSE) → meilleur flux détecté sur la page
      const best = (await collectMedia(tab)).items.find((i) => i.kind !== 'file');
      if (best) items = [best];
    }
  } else if (info.menuItemId === 'wget-page') {
    const frame = info.frameUrl && isPlatformUrl(info.frameUrl) ? info.frameUrl : null;
    if (frame) items = [{ url: frame, kind: 'platform', referer: info.pageUrl }];
    else {
      const best = (await collectMedia(tab)).items.find((i) => i.kind !== 'file');
      items = [best || { url: info.pageUrl, kind: 'page' }];
    }
  } else if (info.menuItemId === 'wget-all') {
    items = (await collectMedia(tab)).items.filter((i) => i.kind !== 'file' && !i.isPage);
  }
  if (!items.length) {
    notify('Web Wget', 'Aucun média détecté sur cette page');
    return;
  }
  const result = await sendItems({ tabId: tab.id, items });
  notifyResult(result, items.length === 1 ? displayName(items[0].url) : null);
});

// ================= RACCOURCIS CLAVIER =================
chrome.commands.onCommand.addListener(async (command, tab) => {
  const current = tab?.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!current?.id) return;
  const media = await collectMedia(current);
  if (command === 'scan_page') {
    notify('Web Wget', media.items.length ? `${media.items.length} média(s) détecté(s) : ouvrez l'extension pour choisir.` : 'Aucun média détecté');
  } else if (command === 'quick_download') {
    const best = media.items.find((i) => i.kind !== 'file');
    if (!best) {
      notify('Web Wget', 'Aucun média détecté sur cette page');
      return;
    }
    notifyResult(await sendItems({ tabId: current.id, items: [best] }), displayName(best.url));
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(AUTO_FETCH_KEY).then((r) => {
    if ((r[AUTO_FETCH_KEY] || []).length) chrome.alarms.create(AUTO_FETCH_ALARM, { periodInMinutes: 0.5 });
  });
});
