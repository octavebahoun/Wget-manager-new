// content.js - Content Script (ISOLATED WORLD)
// ================= CONSTANTS =================
const MESSAGE_TYPES = {
  // Messages from injected script
  WGET_PRO_DETECTED: 'WGET_PRO_DETECTED',
  WGET_PRO_DRM: 'WGET_PRO_DRM',
  WGET_PRO_BLOB_DETECTED: 'WGET_PRO_BLOB_DETECTED',
  
  // Messages to/from background
  STREAM_DETECTED: 'STREAM_DETECTED',
  DRM_SIGNAL: 'DRM_SIGNAL',
  BLOB_ALERT: 'BLOB_ALERT',
  GET_CONTEXT: 'GET_CONTEXT',
  
  // Internal
  CONTEXT_UPDATE: 'CONTEXT_UPDATE'
};

const ALLOWED_ORIGINS = [
  window.location.origin,
  'null' // Pour les iframes sandbox
];

// ================= STATE =================
class ContentState {
  constructor() {
    this.detectedUrls = new Set();
    this.hasDRM = false;
    this.hasBlob = false;
    this.videoElements = new WeakSet();
    this.observers = [];
  }

  addUrl(url) {
    if (!url || typeof url !== 'string') return false;
    
    const sizeBefore = this.detectedUrls.size;
    this.detectedUrls.add(url);
    return this.detectedUrls.size > sizeBefore;
  }

  setDRM(hasDRM = true) {
    this.hasDRM = hasDRM;
  }

  setBlob(hasBlob = true) {
    this.hasBlob = hasBlob;
  }

  addVideoElement(element) {
    this.videoElements.add(element);
  }

  hasVideoElement(element) {
    return this.videoElements.has(element);
  }

  disconnect() {
    this.observers.forEach(observer => observer.disconnect());
    this.observers = [];
  }
}

const state = new ContentState();

// ================= SECURITY =================
// Valider l'origine du message
function isValidOrigin(origin) {
  // Accepter l'origine de la page courante
  if (origin === window.location.origin) return true;
  
  // Accepter 'null' pour les iframes sandbox
  if (origin === 'null') return true;
  
  return false;
}

// Valider la structure du message
function isValidMessage(data) {
  return data && 
         typeof data === 'object' && 
         typeof data.type === 'string' &&
         MESSAGE_TYPES[data.type];
}

// ================= MESSAGE HANDLERS =================
const messageHandlers = {
  // Stream détecté par l'injected script
  [MESSAGE_TYPES.WGET_PRO_DETECTED]: (data) => {
    if (!data.url) {
      console.warn('[WGET] URL manquante dans le message');
      return;
    }

    const isNew = state.addUrl(data.url);
    
    if (isNew) {
      console.log('[WGET] Nouveau stream détecté:', data.url.substring(0, 100));
      
      chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.STREAM_DETECTED,
        url: data.url,
        timestamp: Date.now(),
        pageUrl: window.location.href
      }).catch(err => {
        console.error('[WGET] Erreur envoi message au background:', err);
      });
    }
  },

  // DRM détecté
  [MESSAGE_TYPES.WGET_PRO_DRM]: (data) => {
    if (state.hasDRM) return; // Déjà signalé
    
    state.setDRM(true);
    console.warn('[WGET] Contenu protégé par DRM détecté');
    
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.DRM_SIGNAL,
      timestamp: Date.now(),
      pageUrl: window.location.href,
      details: data.details || 'DRM encryption detected'
    }).catch(err => {
      console.error('[WGET] Erreur envoi signal DRM:', err);
    });
  },

  // Blob détecté
  [MESSAGE_TYPES.WGET_PRO_BLOB_DETECTED]: (data) => {
    if (state.hasBlob) return; // Déjà signalé
    
    state.setBlob(true);
    console.info('[WGET] Contenu Blob détecté');
    
    chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.BLOB_ALERT,
      timestamp: Date.now(),
      pageUrl: window.location.href,
      blobUrl: data.blobUrl || null
    }).catch(err => {
      console.error('[WGET] Erreur envoi alerte Blob:', err);
    });
  }
};

// ================= WINDOW MESSAGE LISTENER =================
window.addEventListener('message', (event) => {
  // Sécurité: Vérifier l'origine
  if (!isValidOrigin(event.origin)) {
    console.warn('[WGET] Message rejeté - origine invalide:', event.origin);
    return;
  }

  // Sécurité: Vérifier la source
  if (event.source !== window) {
    console.warn('[WGET] Message rejeté - source invalide');
    return;
  }

  // Sécurité: Valider le message
  if (!isValidMessage(event.data)) {
    return; // Ignorer silencieusement les messages non liés à notre extension
  }

  // Router vers le bon handler
  const handler = messageHandlers[event.data.type];
  if (handler) {
    try {
      handler(event.data);
    } catch (error) {
      console.error(`[WGET] Erreur traitement message ${event.data.type}:`, error);
    }
  }
}, false);

// ================= CONTEXT GATHERING =================
// Récupérer le contexte complet de la page
function gatherPageContext() {
  // Détecter les vidéos avec DRM
  const videoElements = Array.from(document.querySelectorAll('video, audio'));
  const hasDrmTags = videoElements.some(element => {
    try {
      return element.mediaKeys !== null && element.mediaKeys !== undefined;
    } catch (e) {
      return false;
    }
  });

  // Détecter les éléments vidéo
  const videoInfo = videoElements.map(element => {
    try {
      return {
        src: element.src || element.currentSrc || null,
        type: element.tagName.toLowerCase(),
        width: element.videoWidth || element.width || 0,
        height: element.videoHeight || element.height || 0,
        duration: element.duration || 0,
        hasDRM: element.mediaKeys !== null
      };
    } catch (e) {
      return null;
    }
  }).filter(Boolean);

  // Récupérer les métadonnées Open Graph
  const ogMeta = {
    title: getMetaContent('og:title') || document.title,
    description: getMetaContent('og:description') || getMetaContent('description'),
    image: getMetaContent('og:image'),
    video: getMetaContent('og:video') || getMetaContent('og:video:url'),
    siteName: getMetaContent('og:site_name')
  };

  // Détecter les iframes vidéo
  const videoIframes = Array.from(document.querySelectorAll('iframe')).filter(iframe => {
    const src = iframe.src || '';
    return /youtube|vimeo|dailymotion|twitch|player/i.test(src);
  }).map(iframe => iframe.src);

  return {
    pageUrl: window.location.href,
    pageTitle: document.title,
    referer: document.referrer || window.location.origin,
    ua: navigator.userAgent,
    hasDrm: state.hasDRM || hasDrmTags,
    hasBlob: state.hasBlob,
    detectedUrls: Array.from(state.detectedUrls),
    videoElements: videoInfo,
    videoIframes,
    metadata: ogMeta,
    timestamp: Date.now()
  };
}

// Helper pour récupérer le contenu d'une balise meta
function getMetaContent(property) {
  const meta = document.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
  return meta ? meta.getAttribute('content') : null;
}

// ================= RUNTIME MESSAGE LISTENER =================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MESSAGE_TYPES.GET_CONTEXT) {
    try {
      const context = gatherPageContext();
      sendResponse(context);
    } catch (error) {
      console.error('[WGET] Erreur récupération contexte:', error);
      sendResponse({
        error: error.message,
        pageUrl: window.location.href,
        pageTitle: document.title,
        hasDrm: false,
        hasBlob: false,
        detectedUrls: []
      });
    }
    return true; // Réponse asynchrone
  }
});

// ================= VIDEO ELEMENT OBSERVER =================
// Observer les nouveaux éléments vidéo ajoutés dynamiquement
function observeVideoElements() {
  // Observer les changements dans le DOM
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Vérifier si c'est un élément vidéo
          if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
            handleNewMediaElement(node);
          }
          
          // Chercher les vidéos dans les enfants
          const mediaElements = node.querySelectorAll?.('video, audio');
          mediaElements?.forEach(handleNewMediaElement);
        }
      });
    });
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  state.observers.push(observer);

  // Traiter les vidéos existantes
  document.querySelectorAll('video, audio').forEach(handleNewMediaElement);
}

// Gérer un nouvel élément média
function handleNewMediaElement(element) {
  if (state.hasVideoElement(element)) return;
  
  state.addVideoElement(element);
  
  // Écouter les événements de l'élément
  element.addEventListener('loadedmetadata', () => {
    console.log('[WGET] Métadonnées vidéo chargées:', {
      src: element.currentSrc?.substring(0, 100),
      duration: element.duration,
      dimensions: `${element.videoWidth}x${element.videoHeight}`
    });
  });

  // Détecter le DRM via encrypted event
  element.addEventListener('encrypted', () => {
    console.warn('[WGET] Événement "encrypted" détecté - contenu DRM');
    messageHandlers[MESSAGE_TYPES.WGET_PRO_DRM]({ 
      details: 'Encrypted media event triggered' 
    });
  });
}

// ================= INITIALIZATION =================
function initialize() {
  console.log('[WGET] Content script initialisé sur:', window.location.href);
  
  // Démarrer l'observation des vidéos
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observeVideoElements);
  } else {
    observeVideoElements();
  }

  // Notifier le background que le content script est prêt
  chrome.runtime.sendMessage({
    type: 'CONTENT_SCRIPT_READY',
    url: window.location.href,
    timestamp: Date.now()
  }).catch(() => {
    // Ignorer si le background n'est pas prêt
  });
}

// ================= CLEANUP =================
// Nettoyer lors du déchargement de la page
window.addEventListener('beforeunload', () => {
  state.disconnect();
});

// Nettoyer lors de la navigation (pour les SPA)
let lastUrl = window.location.href;
const urlObserver = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    console.log('[WGET] Navigation détectée, reset de l\'état');
    lastUrl = window.location.href;
    
    // Réinitialiser l'état
    state.detectedUrls.clear();
    state.setDRM(false);
    state.setBlob(false);
  }
});

urlObserver.observe(document.documentElement, {
  childList: true,
  subtree: true
});

state.observers.push(urlObserver);

// ================= START =================
initialize();

// ================= DEBUG =================
if (typeof window !== 'undefined') {
  window.__wgetProDebug = {
    getState: () => ({
      detectedUrls: Array.from(state.detectedUrls),
      hasDRM: state.hasDRM,
      hasBlob: state.hasBlob,
      observers: state.observers.length
    }),
    clearState: () => {
      state.detectedUrls.clear();
      state.setDRM(false);
      state.setBlob(false);
      console.log('[DEBUG] État nettoyé');
    },
    getContext: () => gatherPageContext()
  };
}