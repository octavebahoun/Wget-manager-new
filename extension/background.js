// background.js - Service Worker pour extension Chrome
// ================= CONSTANTS =================
const BADGE_COLORS = {
  DRM: "#ef4444",      // Rouge
  BLOB: "#3b82f6",     // Bleu
  STREAM: "#8b5cf6",   // Violet
  INACTIVE: "#6b7280"  // Gris
};

const BADGE_TEXT = {
  DRM: "DRM",
  BLOB: "BLOB",
  INACTIVE: ""
};

const MESSAGE_TYPES = {
  DRM_SIGNAL: "DRM_SIGNAL",
  BLOB_ALERT: "BLOB_ALERT",
  STREAM_DETECTED: "STREAM_DETECTED",
  FETCH_CONTEXT: "FETCH_CONTEXT",
  GET_CONTEXT: "GET_CONTEXT",
  CLEAR_TAB_DATA: "CLEAR_TAB_DATA",
  GET_TAB_STATUS: "GET_TAB_STATUS"
};

// ================= STATE MANAGEMENT =================
class TabStateManager {
  constructor() {
    this.detectedStreams = new Map(); // tabId -> Set<URL>
    this.drmStatus = new Map();       // tabId -> boolean
    this.blobStatus = new Map();      // tabId -> boolean
    this.tabMetadata = new Map();     // tabId -> { timestamp, pageUrl, title }
  }

  // Ajouter un stream détecté
  addStream(tabId, url) {
    if (!this.detectedStreams.has(tabId)) {
      this.detectedStreams.set(tabId, new Set());
    }

    const streams = this.detectedStreams.get(tabId);
    const sizeBefore = streams.size;
    streams.add(url);

    return streams.size > sizeBefore; // Retourne true si nouveau stream
  }

  // Obtenir tous les streams d'un onglet
  getStreams(tabId) {
    return Array.from(this.detectedStreams.get(tabId) || []);
  }

  // Marquer comme DRM
  setDRM(tabId, isDRM = true) {
    this.drmStatus.set(tabId, isDRM);
  }

  // Marquer comme Blob
  setBlob(tabId, isBlob = true) {
    this.blobStatus.set(tabId, isBlob);
  }

  // Obtenir le statut complet d'un onglet
  getTabStatus(tabId) {
    return {
      hasDRM: this.drmStatus.get(tabId) || false,
      hasBlob: this.blobStatus.get(tabId) || false,
      streamCount: this.detectedStreams.get(tabId)?.size || 0,
      streams: this.getStreams(tabId),
      metadata: this.tabMetadata.get(tabId) || null
    };
  }

  // Définir les métadonnées d'un onglet
  setMetadata(tabId, metadata) {
    this.tabMetadata.set(tabId, {
      ...metadata,
      timestamp: Date.now()
    });
  }

  // Nettoyer les données d'un onglet
  clearTab(tabId) {
    this.detectedStreams.delete(tabId);
    this.drmStatus.delete(tabId);
    this.blobStatus.delete(tabId);
    this.tabMetadata.delete(tabId);
  }

  // Nettoyer les onglets inactifs (plus vieux que 1h)
  cleanupInactiveTabs() {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);

    this.tabMetadata.forEach((metadata, tabId) => {
      if (metadata.timestamp < oneHourAgo) {
        this.clearTab(tabId);
      }
    });
  }
}

const stateManager = new TabStateManager();

// URL Serveur par défaut
let SERVER_URL = "http://localhost:3000";

// Charger l'URL configurée
chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) {
    SERVER_URL = result.serverUrl;
    console.log('[CONFIG] URL serveur chargée:', SERVER_URL);
  }
});

// Écouter les changements de config
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.serverUrl) {
    SERVER_URL = changes.serverUrl.newValue || "http://localhost:3000";
    console.log('[CONFIG] URL serveur mise à jour:', SERVER_URL);
  }
});

// Nettoyage périodique (toutes les 30 minutes)
setInterval(() => {
  stateManager.cleanupInactiveTabs();
}, 30 * 60 * 1000);

// ... (Le reste du code reste identique jusqu'à la fin du fichier où SERVER_URL est utilisé) ...

// ================= NETWORK HANDLER =================
// Mettre à jour le badge de l'icône
async function updateBadge(tabId) {
  const status = stateManager.getTabStatus(tabId);
  let badgeText = "";
  let badgeColor = BADGE_COLORS.INACTIVE;

  if (status.hasDRM) {
    badgeText = BADGE_TEXT.DRM;
    badgeColor = BADGE_COLORS.DRM;
  } else if (status.hasBlob) {
    badgeText = BADGE_TEXT.BLOB;
    badgeColor = BADGE_COLORS.BLOB;
  } else if (status.streamCount > 0) {
    badgeText = `${status.streamCount}`;
    badgeColor = BADGE_COLORS.STREAM;
  }

  await chrome.action.setBadgeText({ text: badgeText, tabId });
  await chrome.action.setBadgeBackgroundColor({ color: badgeColor, tabId });
}

// Écouter les requêtes réseau pour détecter les flux
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { tabId, url } = details;
    if (tabId < 0) return;

    // Filtrer les URLs non pertinentes
    const isM3U8 = url.includes('.m3u8');
    const isMPD = url.includes('.mpd');

    if (isM3U8 || isMPD) {
      if (stateManager.addStream(tabId, url)) {
        console.log(`[NET] Stream détecté (tab ${tabId}): ${url.substring(0, 100)}`);
        updateBadge(tabId);
      }
    }
  },
  {
    urls: ["<all_urls>"],
    types: ["media", "xmlhttprequest", "other"]
  }
);

// ================= COMMAND HANDLER =================
chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command !== 'quick_download') return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      console.warn('[COMMAND] Aucun onglet actif pour quick_download');
      return;
    }

    const tabId = tab.id;
    const streams = stateManager.getStreams(tabId) || [];
    const url = streams.length > 0 ? streams[0] : tab.url;

    if (!url) {
      console.warn('[COMMAND] Aucun URL disponible pour téléchargement rapide');
      return;
    }

    console.log(`[COMMAND] quick_download déclenché (tab ${tabId}) -> ${url.substring(0, 120)}`);

    // Déléguer au serveur via la route /api/capture
    try {
      await fetch(`${SERVER_URL}/api/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, type: 'quick', tabId })
      });
      console.log('[COMMAND] Requête envoyée au serveur pour téléchargement rapide');
    } catch (e) {
      console.error('[COMMAND] Échec envoi capture → serveur', e);
    }

  } catch (err) {
    console.error('[COMMAND] Erreur gestion commande', err);
  }
});