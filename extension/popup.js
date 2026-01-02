// popup.js - Interface utilisateur de l'extension
// ================= CONSTANTS =================
const CONFIG = {
  SERVER_URL: "http://localhost:3000",
  AUTO_CLOSE_DELAY: 1500,
  FILENAME_MAX_LENGTH: 255,
  URL_PREVIEW_LENGTH: 30,
  STATUS_TIMEOUT: 5000,
  MESSAGE_TIMEOUT: 10000
};

const STATUS_TYPES = {
  SUCCESS: 'success',
  ERROR: 'error',
  INFO: 'info',
  WARNING: 'warning'
};

const MESSAGE_TYPES = {
  FETCH_CONTEXT: "FETCH_CONTEXT",
  GET_TAB_STATUS: "GET_TAB_STATUS"
};

// ================= DOM ELEMENTS =================
const elements = {
  urlInput: document.getElementById("url"),
  filenameInput: document.getElementById("filename"),
  statusEl: document.getElementById("status"),
  sendBtn: document.getElementById("send"),
  downloadLocalBtn: document.getElementById("downloadLocal"),
  videoSelector: document.getElementById("videoSelector"),
  videoSelectorContainer: document.getElementById("videoSelectorContainer"),
  manualScanBtn: document.getElementById("manualScan"),
  refreshBtn: document.getElementById("refresh"),
  clearBtn: document.getElementById("clear")
};

// ================= STATE MANAGEMENT =================
class PopupState {
  constructor() {
    this.context = null;
    this.isLoading = false;
    this.selectedVideoUrl = null;
  }

  setContext(context) {
    this.context = context;
  }

  setLoading(loading) {
    this.isLoading = loading;
    this.updateUI();
  }

  updateUI() {
    if (elements.sendBtn) {
      elements.sendBtn.disabled = this.isLoading;
    }
    if (elements.downloadLocalBtn) {
      elements.downloadLocalBtn.disabled = this.isLoading;
    }
    if (elements.manualScanBtn) {
      elements.manualScanBtn.disabled = this.isLoading;
    }
  }
}

const state = new PopupState();

// ================= UTILITY FUNCTIONS =================
// Afficher un message de statut
function showStatus(message, type = STATUS_TYPES.INFO, duration = null) {
  if (!elements.statusEl) return;

  elements.statusEl.textContent = message;
  elements.statusEl.className = `${type} visible`;

  if (duration) {
    setTimeout(() => {
      elements.statusEl.classList.remove('visible');
    }, duration);
  }
}

// Nettoyer un nom de fichier
function sanitizeFilename(filename) {
  if (!filename) return '';

  return filename
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, CONFIG.FILENAME_MAX_LENGTH);
}

// Extraire le nom de fichier d'une URL
function extractFilenameFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop().split('?')[0];
    return filename || 'download';
  } catch (e) {
    return 'download';
  }
}

// Tronquer une chaîne pour l'affichage
function truncateString(str, maxLength = CONFIG.URL_PREVIEW_LENGTH) {
  if (!str) return '';
  return str.length > maxLength ? str.substring(0, maxLength) + '...' : str;
}

// Vérifier si une URL est un stream
function isStreamUrl(url) {
  if (!url) return false;

  const streamPatterns = [
    /\.(m3u8|mpd|f4m|ism)/i,
    /\/manifest\//i,
    /\/playlist\./i,
    /googlevideo\.com/i
  ];

  return streamPatterns.some(pattern => pattern.test(url));
}

// Valider une URL
function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;

  try {
    const urlObj = new URL(url);
    return ['http:', 'https:'].includes(urlObj.protocol);
  } catch (e) {
    return false;
  }
}

// Formater le nombre de flux détectés
function formatStreamCount(count) {
  if (count === 0) return 'Aucun flux détecté';
  if (count === 1) return '1 flux détecté';
  return `${count} flux détectés`;
}

// ================= CONTEXT FETCHING =================
async function fetchContext() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout: Le serveur ne répond pas'));
    }, CONFIG.MESSAGE_TIMEOUT);

    chrome.runtime.sendMessage(
      { type: MESSAGE_TYPES.FETCH_CONTEXT },
      (response) => {
        clearTimeout(timeout);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response) {
          reject(new Error('Aucune réponse du background script'));
          return;
        }

        if (response.error) {
          reject(new Error(response.error));
          return;
        }

        resolve(response);
      }
    );
  });
}

// ================= UI UPDATE FUNCTIONS =================
// Mettre à jour la liste déroulante des vidéos
function updateVideoSelector(videos) {
  if (!elements.videoSelector) return;

  // Réinitialiser le sélecteur
  elements.videoSelector.innerHTML = '<option value="">-- Choisir une vidéo détectée --</option>';

  if (!videos || videos.length === 0) {
    elements.videoSelectorContainer.style.display = "none";
    return;
  }

  // Afficher le conteneur
  elements.videoSelectorContainer.style.display = "block";

  // Ajouter les vidéos détectées
  videos.forEach((videoUrl, index) => {
    const option = document.createElement("option");
    option.value = videoUrl;

    const filename = extractFilenameFromUrl(videoUrl);
    const displayName = truncateString(filename, 40);
    option.textContent = `${index + 1}. ${displayName}`;
    option.title = videoUrl; // Afficher l'URL complète au survol

    elements.videoSelector.appendChild(option);
  });

  // Pré-remplir l'URL si vide
  if (!elements.urlInput.value && videos.length > 0) {
    elements.urlInput.value = videos[0];
    state.selectedVideoUrl = videos[0];
  }
}

// Mettre à jour le nom de fichier suggéré
function updateFilename(context) {
  if (!elements.filenameInput || elements.filenameInput.value) return;

  let suggestedName = '';

  // Essayer d'utiliser le titre de la page
  if (context.pageTitle) {
    suggestedName = sanitizeFilename(context.pageTitle);
  }

  // Fallback sur l'URL si pas de titre
  if (!suggestedName && context.pageUrl) {
    try {
      const urlObj = new URL(context.pageUrl);
      suggestedName = sanitizeFilename(urlObj.hostname);
    } catch (e) {
      suggestedName = 'download';
    }
  }

  elements.filenameInput.value = suggestedName;
}

// Afficher le statut de détection
function updateDetectionStatus(context) {
  if (!context) return;

  // Priorité: DRM > Blob > Streams > Aucun
  if (context.isDrm || context.hasDrm) {
    showStatus("⚠️ Contenu protégé par DRM détecté", STATUS_TYPES.WARNING);
  } else if (context.isBlob || context.hasBlob) {
    showStatus("ℹ️ Contenu Blob détecté", STATUS_TYPES.INFO);
  } else if (context.detectedVideos && context.detectedVideos.length > 0) {
    const count = context.detectedVideos.length;
    showStatus(`✓ ${formatStreamCount(count)}`, STATUS_TYPES.SUCCESS);
  } else {
    showStatus("Aucun flux détecté pour le moment...", STATUS_TYPES.INFO, CONFIG.STATUS_TIMEOUT);
  }
}

// ================= REFRESH UI =================
async function refreshUI() {
  if (state.isLoading) return;

  state.setLoading(true);
  showStatus("🔍 Analyse de la page...", STATUS_TYPES.INFO);

  try {
    const context = await fetchContext();
    state.setContext(context);

    // Consolidate video sources (Network + DOM)
    const streams = context.streams || [];
    const domVideos = context.detectedVideos || [];
    // Merge and deduplicate
    const allVideos = [...new Set([...streams, ...domVideos])];

    // Mettre à jour l'interface
    updateVideoSelector(allVideos);

    // Auto-fill URL with page URL if no video selected/found and input is empty
    if (!elements.urlInput.value && context.pageUrl) {
      // If we have videos, updateVideoSelector might have already picked the first one.
      // If it didn't (e.g. empty list), we use any available page URL.
      // We check if the input is STILL empty after updateVideoSelector
      if (!elements.urlInput.value) {
        elements.urlInput.value = context.pageUrl;
      }
    }

    updateFilename(context);
    updateDetectionStatus({ ...context, detectedVideos: allVideos });

  } catch (error) {
    console.error('[POPUP] Erreur refresh:', error);
    showStatus(`❌ ${error.message}`, STATUS_TYPES.ERROR, CONFIG.STATUS_TIMEOUT);
  } finally {
    state.setLoading(false);
  }
}

// ================= DOWNLOAD FUNCTIONS =================
// Téléchargement via serveur
async function downloadViaServer() {
  const url = elements.urlInput.value?.trim();
  const customFilename = elements.filenameInput.value?.trim();

  // Validation
  if (!url) {
    showStatus("⚠️ Veuillez entrer une URL", STATUS_TYPES.WARNING);
    elements.urlInput.focus();
    return;
  }

  if (!isValidUrl(url)) {
    showStatus("❌ URL invalide", STATUS_TYPES.ERROR);
    elements.urlInput.focus();
    return;
  }

  state.setLoading(true);
  showStatus("📡 Connexion au serveur...", STATUS_TYPES.INFO);

  try {
    // Récupérer le contexte si pas déjà fait
    if (!state.context) {
      state.context = await fetchContext();
    }

    showStatus("📤 Envoi de la requête...", STATUS_TYPES.INFO);

    const response = await fetch(`${CONFIG.SERVER_URL}/download`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        url,
        customFilename: customFilename || null,
        referer: state.context.pageUrl || state.context.referer,
        ua: state.context.ua,
        cookies: state.context.cookies || ''
      })
    });

    const data = await response.json();

    if (response.ok) {
      showStatus("✅ Téléchargement démarré !", STATUS_TYPES.SUCCESS);

      // Fermer la popup après un délai
      setTimeout(() => {
        window.close();
      }, CONFIG.AUTO_CLOSE_DELAY);
    } else {
      showStatus(`❌ ${data.error || 'Erreur serveur'}`, STATUS_TYPES.ERROR);
    }

  } catch (error) {
    console.error('[POPUP] Erreur download:', error);

    if (error.message.includes('fetch')) {
      showStatus("❌ Serveur inaccessible (localhost:3000)", STATUS_TYPES.ERROR);
    } else {
      showStatus(`❌ ${error.message}`, STATUS_TYPES.ERROR);
    }
  } finally {
    state.setLoading(false);
  }
}

// Téléchargement local (direct)
async function downloadLocally() {
  const url = elements.urlInput.value?.trim();
  const filename = elements.filenameInput.value?.trim() || 'download';

  // Validation
  if (!url) {
    showStatus("⚠️ Veuillez entrer une URL", STATUS_TYPES.WARNING);
    elements.urlInput.focus();
    return;
  }

  if (!isValidUrl(url)) {
    showStatus("❌ URL invalide", STATUS_TYPES.ERROR);
    elements.urlInput.focus();
    return;
  }

  // Vérifier si c'est un stream
  if (isStreamUrl(url)) {
    showStatus("⚠️ Stream détecté : Utilisez le serveur !", STATUS_TYPES.WARNING);
    setTimeout(() => {
      showStatus("Les navigateurs ne peuvent pas télécharger les streams HLS/DASH directement.", STATUS_TYPES.INFO, 3000);
    }, 2000);
    return;
  }

  state.setLoading(true);
  showStatus("📥 Démarrage du téléchargement...", STATUS_TYPES.INFO);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      throw new Error("Impossible d'accéder à l'onglet actif");
    }

    // Injecter un script pour forcer le téléchargement
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (downloadUrl, fileName) => {
        const anchor = document.createElement('a');
        anchor.href = downloadUrl;
        anchor.download = fileName || 'download';
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();

        // Nettoyer après 100ms
        setTimeout(() => {
          document.body.removeChild(anchor);
        }, 100);
      },
      args: [url, sanitizeFilename(filename)]
    });

    showStatus("✅ Téléchargement lancé !", STATUS_TYPES.SUCCESS, 2000);

  } catch (error) {
    console.error('[POPUP] Erreur téléchargement local:', error);

    if (error.message.includes('Cannot access')) {
      showStatus("❌ Page protégée ou extension non autorisée", STATUS_TYPES.ERROR);
    } else {
      showStatus(`❌ ${error.message}`, STATUS_TYPES.ERROR);
    }
  } finally {
    state.setLoading(false);
  }
}

// ================= EVENT LISTENERS =================
// Initialisation au chargement
document.addEventListener('DOMContentLoaded', () => {
  console.log('[POPUP] Initialisation');
  refreshUI();
});

// Scan manuel
if (elements.manualScanBtn) {
  elements.manualScanBtn.addEventListener('click', () => {
    console.log('[POPUP] Scan manuel déclenché');
    refreshUI();
  });
}

// Bouton refresh (si présent)
if (elements.refreshBtn) {
  elements.refreshBtn.addEventListener('click', refreshUI);
}

// Sélection d'une vidéo
if (elements.videoSelector) {
  elements.videoSelector.addEventListener('change', (e) => {
    const selectedUrl = e.target.value;
    if (selectedUrl) {
      elements.urlInput.value = selectedUrl;
      state.selectedVideoUrl = selectedUrl;
      console.log('[POPUP] Vidéo sélectionnée:', selectedUrl.substring(0, 50));
    }
  });
}

// Bouton téléchargement serveur
if (elements.sendBtn) {
  elements.sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    downloadViaServer();
  });
}

// Bouton téléchargement local
if (elements.downloadLocalBtn) {
  elements.downloadLocalBtn.addEventListener('click', (e) => {
    e.preventDefault();
    downloadLocally();
  });
}

// Validation de l'URL en temps réel
if (elements.urlInput) {
  elements.urlInput.addEventListener('blur', (e) => {
    const url = e.target.value.trim();
    if (url && !isValidUrl(url)) {
      showStatus("⚠️ Format d'URL invalide", STATUS_TYPES.WARNING, 3000);
    }
  });

  // Entrer pour télécharger
  elements.urlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      downloadViaServer();
    }
  });
}

// Sanitize filename en temps réel
if (elements.filenameInput) {
  elements.filenameInput.addEventListener('input', (e) => {
    const sanitized = sanitizeFilename(e.target.value);
    if (sanitized !== e.target.value) {
      e.target.value = sanitized;
    }
  });
}

// Bouton clear (si présent)
if (elements.clearBtn) {
  elements.clearBtn.addEventListener('click', () => {
    elements.urlInput.value = '';
    elements.filenameInput.value = '';
    elements.videoSelector.selectedIndex = 0;
    showStatus("Champs nettoyés", STATUS_TYPES.INFO, 2000);
  });
}

// ================= ERROR HANDLING =================
// Gestion des erreurs globales
window.addEventListener('error', (event) => {
  console.error('[POPUP] Erreur globale:', event.error);
  showStatus("❌ Erreur inattendue", STATUS_TYPES.ERROR);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[POPUP] Promesse rejetée:', event.reason);
  showStatus("❌ Erreur de communication", STATUS_TYPES.ERROR);
});

// ================= DEBUG =================
if (typeof window !== 'undefined') {
  window.__popupDebug = {
    getState: () => ({
      context: state.context,
      isLoading: state.isLoading,
      selectedVideoUrl: state.selectedVideoUrl
    }),
    testServer: async () => {
      try {
        const response = await fetch(`${CONFIG.SERVER_URL}/health`);
        const data = await response.json();
        console.log('[DEBUG] Serveur:', data);
        return data;
      } catch (e) {
        console.error('[DEBUG] Serveur inaccessible:', e);
        return null;
      }
    },
    refreshUI
  };
}