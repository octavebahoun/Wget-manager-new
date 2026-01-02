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

// Nettoyage périodique (toutes les 30 minutes)
setInterval(() => {
  stateManager.cleanupInactiveTabs();
}, 30 * 60 * 1000);

// ================= BADGE MANAGEMENT =================
class BadgeManager {
  // Mettre à jour le badge selon la priorité: DRM > BLOB > STREAM
  static async updateBadge(tabId) {
    try {
      const status = stateManager.getTabStatus(tabId);

      if (status.hasDRM) {
        await this.setBadge(tabId, BADGE_TEXT.DRM, BADGE_COLORS.DRM);
      } else if (status.hasBlob) {
        await this.setBadge(tabId, BADGE_TEXT.BLOB, BADGE_COLORS.BLOB);
      } else if (status.streamCount > 0) {
        await this.setBadge(tabId, status.streamCount.toString(), BADGE_COLORS.STREAM);
      } else {
        await this.clearBadge(tabId);
      }
    } catch (error) {
      console.error(`Erreur mise à jour badge (tab ${tabId}):`, error);
    }
  }

  static async setBadge(tabId, text, color) {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  }

  static async clearBadge(tabId) {
    await chrome.action.setBadgeText({ tabId, text: BADGE_TEXT.INACTIVE });
  }
}

// ================= MESSAGE HANDLERS =================
const messageHandlers = {
  // Gestion signal DRM
  [MESSAGE_TYPES.DRM_SIGNAL]: async (request, sender) => {
    const tabId = sender?.tab?.id;
    if (!tabId) return;

    stateManager.setDRM(tabId, true);
    await BadgeManager.updateBadge(tabId);

    console.log(`[DRM] Détecté sur l'onglet ${tabId}`);
  },

  // Gestion alerte Blob
  [MESSAGE_TYPES.BLOB_ALERT]: async (request, sender) => {
    const tabId = sender?.tab?.id;
    if (!tabId) return;

    stateManager.setBlob(tabId, true);
    await BadgeManager.updateBadge(tabId);

    console.log(`[BLOB] Détecté sur l'onglet ${tabId}`);
  },

  // Gestion stream détecté
  [MESSAGE_TYPES.STREAM_DETECTED]: async (request, sender) => {
    const tabId = sender?.tab?.id;
    if (!tabId || !request.url) return;

    const isNewStream = stateManager.addStream(tabId, request.url);

    if (isNewStream) {
      await BadgeManager.updateBadge(tabId);
      console.log(`[STREAM] Nouveau flux détecté sur l'onglet ${tabId}:`, request.url.substring(0, 100));
    }
  },

  // Récupération du contexte
  [MESSAGE_TYPES.FETCH_CONTEXT]: async (request, sender, sendResponse) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab?.id) {
        throw new Error("Aucun onglet actif détecté");
      }

      // Récupérer le contexte de la page
      let pageContext = await getPageContext(tab);

      // Récupérer les cookies
      const cookies = await getCookies(tab.url);

      // Récupérer le statut de l'onglet
      const tabStatus = stateManager.getTabStatus(tab.id);

      // Construire la réponse complète
      const response = {
        ...pageContext,
        ...tabStatus,
        cookies,
        tabId: tab.id,
        tabTitle: tab.title,
        timestamp: Date.now()
      };

      sendResponse(response);
    } catch (error) {
      console.error('[FETCH_CONTEXT] Erreur:', error);
      sendResponse({
        error: error.message,
        streams: [],
        hasDRM: false,
        hasBlob: false
      });
    }
  },

  // Obtenir le statut d'un onglet
  [MESSAGE_TYPES.GET_TAB_STATUS]: async (request, sender, sendResponse) => {
    const tabId = request.tabId || sender?.tab?.id;
    if (!tabId) {
      sendResponse({ error: "Tab ID manquant" });
      return;
    }

    const status = stateManager.getTabStatus(tabId);
    sendResponse(status);
  },

  // Nettoyer les données d'un onglet
  [MESSAGE_TYPES.CLEAR_TAB_DATA]: async (request, sender, sendResponse) => {
    const tabId = request.tabId || sender?.tab?.id;
    if (!tabId) {
      sendResponse({ error: "Tab ID manquant" });
      return;
    }

    stateManager.clearTab(tabId);
    await BadgeManager.clearBadge(tabId);

    sendResponse({ success: true, message: "Données nettoyées" });
  }
};

// ================= HELPER FUNCTIONS =================
// Récupérer le contexte de la page via content script
async function getPageContext(tab) {
  try {
    const context = await chrome.tabs.sendMessage(tab.id, {
      type: MESSAGE_TYPES.GET_CONTEXT
    });

    return context;
  } catch (error) {
    // Si le content script n'est pas chargé, utiliser les infos de base
    console.warn('[CONTEXT] Content script non disponible, utilisation des infos de base');

    let referer = "";
    try {
      referer = new URL(tab.url).origin;
    } catch (e) {
      referer = "";
    }

    return {
      pageUrl: tab.url,
      referer,
      ua: navigator.userAgent,
      title: tab.title,
      favicon: tab.favIconUrl
    };
  }
}

// Récupérer les cookies d'un domaine
async function getCookies(url) {
  try {
    if (!url || url.startsWith('chrome://') || url.startsWith('about:')) {
      return "";
    }

    const cookies = await chrome.cookies.getAll({ url });
    return cookies
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join("; ");
  } catch (error) {
    console.warn('[COOKIES] Erreur récupération:', error);
    return "";
  }
}

// Valider l'URL d'un stream
function isValidStreamUrl(url) {
  if (!url || typeof url !== 'string') return false;

  const streamPatterns = [
    /\.m3u8/i,
    /\.mpd/i,
    /\/manifest\//i,
    /\/playlist\./i,
    /googlevideo\.com/i
  ];

  return streamPatterns.some(pattern => pattern.test(url));
}

// ================= EVENT LISTENERS =================
// Gestionnaire de messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const handler = messageHandlers[request.type];

  if (!handler) {
    console.warn(`[MESSAGE] Type inconnu: ${request.type}`);
    sendResponse({ error: "Type de message inconnu" });
    return false;
  }

  // Exécuter le handler
  handler(request, sender, sendResponse);

  // Retourner true pour les réponses asynchrones
  return request.type === MESSAGE_TYPES.FETCH_CONTEXT ||
    request.type === MESSAGE_TYPES.GET_TAB_STATUS ||
    request.type === MESSAGE_TYPES.CLEAR_TAB_DATA;
});

// Nettoyage à la fermeture d'un onglet
chrome.tabs.onRemoved.addListener((tabId) => {
  stateManager.clearTab(tabId);
  console.log(`[TAB] Onglet ${tabId} fermé, données nettoyées`);
});

// Mise à jour des métadonnées lors du changement d'URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    // Nouvelle navigation = nettoyer les anciennes données
    stateManager.clearTab(tabId);
    BadgeManager.clearBadge(tabId);

    // Sauvegarder les nouvelles métadonnées
    stateManager.setMetadata(tabId, {
      url: tab.url,
      title: tab.title,
      favicon: tab.favIconUrl
    });

    console.log(`[TAB] Navigation détectée sur l'onglet ${tabId}`);
  }
});

// Gestion de l'activation d'un onglet
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tabId = activeInfo.tabId;

  // Rafraîchir le badge de l'onglet actif
  await BadgeManager.updateBadge(tabId);
});

// ================= INSTALLATION & MISE À JOUR =================
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[EXTENSION] Installation initiale');

    // Ouvrir la page de bienvenue (optionnel)
    // chrome.tabs.create({ url: 'welcome.html' });
  } else if (details.reason === 'update') {
    console.log('[EXTENSION] Mise à jour vers', chrome.runtime.getManifest().version);
  }
});

// ================= ERROR HANDLING =================
// Gestion globale des erreurs non capturées
self.addEventListener('error', (event) => {
  console.error('[GLOBAL ERROR]', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[UNHANDLED REJECTION]', event.reason);
});

// ================= WEB REQUEST INTERCEPTION =================
// Détection des flux via l'API réseau
const MEDIA_EXTENSIONS = [
  '.m3u8', '.mpd', '.f4m', '.ism', '.ts',
  '.mp4', '.webm', '.mkv', '.flv',
  '.mov', '.avi', '.wmv'
];

const IGNORED_DOMAINS = [
  'doubleclick.net', 'google-analytics.com', 'facebook.com/tr',
  'segment.io', 'fbsbx.com' // Ajouter d'autres domaines publicitaires/trackers si nécessaire
];

function isMediaUrl(url) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    const hostname = urlObj.hostname.toLowerCase();

    // 1. Vérifier si domaine ignoré
    if (IGNORED_DOMAINS.some(d => hostname.endsWith(d))) {
      return false;
    }

    // 2. Vérifier extensions
    if (MEDIA_EXTENSIONS.some(ext => path.endsWith(ext))) {
      return true;
    }

    // 3. Vérifier patterns spécifiques (manifests, playlists)
    if (path.includes('/manifest') || path.includes('/playlist') || path.includes('master.m3u8')) {
      return true;
    }

    // 4. Vérifier Content-Type (si disponible dans onHeadersReceived mais on utilise onBeforeRequest ici pour la rapidité)
    // Note: Pour une détection plus robuste basée sur le Content-Type, il faudrait utiliser onHeadersReceived.

    return false;

  } catch (e) {
    return false;
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Filtrer les types de requêtes intéressants + GET uniquement
    if (details.method === "GET" &&
      (details.type === "xmlhttprequest" || details.type === "media" || details.type === "other")) {

      const tabId = details.tabId;

      // Ignorer les requêtes des onglets système ou (-1)
      if (tabId === -1) return;

      if (isMediaUrl(details.url)) {
        console.log(`[NETWORK] Média détecté (tab ${tabId}): ${details.url}`);

        const isNew = stateManager.addStream(tabId, details.url);
        if (isNew) {
          BadgeManager.updateBadge(tabId);
        }
      }
    }
  },
  { urls: ["<all_urls>"] }
);

// ================= LOGGING & DEBUG =================
console.log('[BACKGROUND] Service worker initialisé');
console.log('[VERSION]', chrome.runtime.getManifest().version);
console.log('[NETWORK] Interception webRequest active');

// Exposer l'état pour le debug (accessible via chrome.runtime.getBackgroundPage())
if (typeof self !== 'undefined') {
  self.debugState = {
    getState: () => ({
      streams: Object.fromEntries(stateManager.detectedStreams),
      drm: Object.fromEntries(stateManager.drmStatus),
      blob: Object.fromEntries(stateManager.blobStatus),
      metadata: Object.fromEntries(stateManager.tabMetadata)
    }),
    clearAll: () => {
      stateManager.detectedStreams.clear();
      stateManager.drmStatus.clear();
      stateManager.blobStatus.clear();
      stateManager.tabMetadata.clear();
      console.log('[DEBUG] État nettoyé');
    }
  };
}