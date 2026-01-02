// app.js - Interface Web Logic
// ================= CONSTANTS =================
const CONFIG = {
  ITEMS_PER_PAGE: 50,
  AUTO_HIDE_DELAY: 8000,
  TOAST_DURATION: 5000,
  RECONNECT_DELAY: 3000,
  MAX_RECONNECT_ATTEMPTS: 10
};

const STATUS_ICONS = {
  downloading: 'fa-spinner fa-spin',
  completed: 'fa-check-circle',
  error: 'fa-exclamation-circle',
  cancelled: 'fa-times-circle',
  retrying: 'fa-redo',
  interrupted: 'fa-pause-circle'
};

const STATUS_LABELS = {
  downloading: 'En cours',
  completed: 'Terminé',
  error: 'Échec',
  cancelled: 'Annulé',
  retrying: 'Nouvelle tentative...',
  interrupted: 'Interrompu'
};

// ================= STATE MANAGEMENT =================
class AppState {
  constructor() {
    this.activeDownloads = new Set();
    this.historyData = [];
    this.currentPage = 1;
    this.allowedDomains = [];
    this.isConnected = false;
    this.reconnectAttempts = 0;
  }

  addActiveDownload(id) {
    this.activeDownloads.add(id);
    this.updateActiveBadge();
  }

  removeActiveDownload(id) {
    this.activeDownloads.delete(id);
    this.updateActiveBadge();
  }

  updateActiveBadge() {
    const badge = document.getElementById('activeCount');
    if (badge) {
      badge.textContent = this.activeDownloads.size;
    }
  }

  setHistoryData(data) {
    this.historyData = data;
    const badge = document.getElementById('historyCount');
    if (badge) {
      badge.textContent = data.length;
    }
  }
}

const state = new AppState();

// ================= DOM ELEMENTS =================
const elements = {
  downloadForm: document.getElementById('downloadForm'),
  urlInput: document.getElementById('urlInput'),
  uaInput: document.getElementById('uaInput'),
  submitBtn: document.getElementById('submitBtn'),
  advToggle: document.getElementById('advToggle'),
  advOptions: document.getElementById('advOptions'),
  activeList: document.getElementById('activeList'),
  historyList: document.getElementById('historyList'),
  cancelAllBtn: document.getElementById('cancelAllBtn'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  refreshActiveBtn: document.getElementById('refreshActiveBtn'),
  refreshHistoryBtn: document.getElementById('refreshHistoryBtn'),
  paginationControls: document.getElementById('paginationControls'),
  prevPageBtn: document.getElementById('prevPage'),
  nextPageBtn: document.getElementById('nextPage'),
  currentPageSpan: document.getElementById('currentPage'),
  totalPagesSpan: document.getElementById('totalPages'),
  connectionStatus: document.getElementById('connectionStatus'),
  toastContainer: document.getElementById('toastContainer')
};

// ================= UTILITY FUNCTIONS =================
// Formater la taille de fichier
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Formater la date
function formatDate(date) {
  return new Date(date).toLocaleString('fr-FR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Obtenir l'icône selon l'extension
function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const iconMap = {
    // Video
    mp4: 'fa-video', mkv: 'fa-video', avi: 'fa-video', mov: 'fa-video',
    webm: 'fa-video', flv: 'fa-video', wmv: 'fa-video', m4v: 'fa-video',
    // Audio
    mp3: 'fa-music', wav: 'fa-music', flac: 'fa-music', aac: 'fa-music',
    m4a: 'fa-music', ogg: 'fa-music', wma: 'fa-music',
    // Image
    jpg: 'fa-image', jpeg: 'fa-image', png: 'fa-image', gif: 'fa-image',
    webp: 'fa-image', svg: 'fa-image', bmp: 'fa-image',
    // Archive
    zip: 'fa-file-archive', rar: 'fa-file-archive', '7z': 'fa-file-archive',
    tar: 'fa-file-archive', gz: 'fa-file-archive',
    // Document
    pdf: 'fa-file-pdf', doc: 'fa-file-word', docx: 'fa-file-word',
    xls: 'fa-file-excel', xlsx: 'fa-file-excel', ppt: 'fa-file-powerpoint',
    pptx: 'fa-file-powerpoint', txt: 'fa-file-lines',
    // Code
    js: 'fa-file-code', html: 'fa-file-code', css: 'fa-file-code',
    json: 'fa-file-code', xml: 'fa-file-code', py: 'fa-file-code',
    // Executable
    exe: 'fa-cube', msi: 'fa-cube', deb: 'fa-cube', dmg: 'fa-cube'
  };
  return iconMap[ext] || 'fa-file';
}

// Sanitize filename
function sanitizeFilename(filename) {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').substring(0, 255);
}

// ================= TOAST NOTIFICATIONS =================
class ToastManager {
  show(message, type = 'info', duration = CONFIG.TOAST_DURATION) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    const iconMap = {
      success: 'fa-check-circle',
      error: 'fa-exclamation-circle',
      warning: 'fa-exclamation-triangle',
      info: 'fa-info-circle'
    };

    toast.innerHTML = `
      <i class="fas ${iconMap[type] || iconMap.info}"></i>
      <span>${message}</span>
      <button class="toast-close" onclick="this.parentElement.remove()">
        <i class="fas fa-times"></i>
      </button>
    `;

    elements.toastContainer.appendChild(toast);

    // Animation d'entrée
    setTimeout(() => toast.classList.add('show'), 10);

    // Auto-remove
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  success(message) { this.show(message, 'success'); }
  error(message) { this.show(message, 'error'); }
  warning(message) { this.show(message, 'warning'); }
  info(message) { this.show(message, 'info'); }
}

const toast = new ToastManager();

// ================= AUDIO FEEDBACK =================
class AudioFeedback {
  playSuccess() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(1320, audioCtx.currentTime + 0.1);

      gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.3);
    } catch (e) {
      console.warn('Audio not supported:', e);
    }
  }

  playError() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();

      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(200, audioCtx.currentTime);

      gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);

      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.2);
    } catch (e) {
      console.warn('Audio not supported:', e);
    }
  }
}

const audio = new AudioFeedback();

// ================= NOTIFICATIONS =================
class NotificationManager {
  constructor() {
    this.checkPermission();
  }

  async checkPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  }

  show(title, body, icon = null) {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, {
        body,
        icon: icon || 'https://cdn-icons-png.flaticon.com/512/932/932960.png',
        badge: 'https://cdn-icons-png.flaticon.com/512/932/932960.png'
      });
    }
  }

  downloadComplete(filename) {
    this.show('Téléchargement terminé', filename);
  }

  downloadError(filename) {
    this.show('Téléchargement échoué', filename);
  }
}

const notifications = new NotificationManager();

// ================= SSE CONNECTION =================
class SSEManager {
  constructor() {
    this.eventSource = null;
    this.reconnectTimeout = null;
    this.connect();
  }

  connect() {
    try {
      this.eventSource = new EventSource('/events');
      
      this.eventSource.onopen = () => {
        console.log('[SSE] Connecté');
        state.isConnected = true;
        state.reconnectAttempts = 0;
        this.updateConnectionStatus(true);
        toast.success('Connexion établie');
      };

      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (e) {
          console.error('[SSE] Erreur parsing:', e);
        }
      };

      this.eventSource.onerror = (error) => {
        console.error('[SSE] Erreur connexion:', error);
        state.isConnected = false;
        this.updateConnectionStatus(false);
        this.reconnect();
      };
    } catch (e) {
      console.error('[SSE] Erreur création:', e);
      this.reconnect();
    }
  }

  handleMessage(data) {
    if (data.type === 'update' || data.type === 'status-change') {
      updateDownloadUI(data.download);

      if (data.download.status === 'downloading') {
        state.addActiveDownload(data.download.id);
      } else {
        state.removeActiveDownload(data.download.id);
      }
    }

    if (data.type === 'status-change') {
      if (data.download.status === 'completed') {
        loadHistory();
        audio.playSuccess();
        notifications.downloadComplete(data.download.filename);
        toast.success(`${data.download.filename} téléchargé !`);
      } else if (data.download.status === 'error') {
        audio.playError();
        notifications.downloadError(data.download.filename);
        toast.error(`Erreur: ${data.download.filename}`);
      }
    }
  }

  reconnect() {
    if (state.reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
      toast.error('Impossible de se reconnecter au serveur');
      return;
    }

    state.reconnectAttempts++;
    const delay = CONFIG.RECONNECT_DELAY * state.reconnectAttempts;

    console.log(`[SSE] Reconnexion dans ${delay}ms (tentative ${state.reconnectAttempts})`);

    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      if (this.eventSource) {
        this.eventSource.close();
      }
      this.connect();
    }, delay);
  }

  updateConnectionStatus(connected) {
    const statusEl = elements.connectionStatus;
    if (!statusEl) return;

    if (connected) {
      statusEl.classList.remove('offline');
      statusEl.classList.add('online');
      statusEl.querySelector('.status-text').textContent = 'Connecté';
    } else {
      statusEl.classList.remove('online');
      statusEl.classList.add('offline');
      statusEl.querySelector('.status-text').textContent = 'Déconnecté';
    }
  }

  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
    }
    clearTimeout(this.reconnectTimeout);
  }
}

let sseManager;

// ================= DOWNLOAD UI =================
function updateDownloadUI(download) {
  let el = document.getElementById(`dl-${download.id}`);
  
  if (!el) {
    // Supprimer le message "En attente"
    const emptyState = elements.activeList.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // Créer le nouvel élément
    el = document.createElement('div');
    el.id = `dl-${download.id}`;
    el.className = 'download-item';
    elements.activeList.prepend(el);
  }

  const status = download.status;
  const isDone = status === 'completed';
  const isError = status === 'error';
  const isInterrupted = status === 'interrupted';
  const isCancelled = status === 'cancelled';
  const isRetrying = status === 'retrying';

  const statusIcon = STATUS_ICONS[status] || 'fa-question-circle';
  const statusLabel = STATUS_LABELS[status] || 'Inconnu';

  el.innerHTML = `
    <div class="download-header">
      <div class="file-info">
        <div class="file-icon">
          <i class="fas ${getFileIcon(download.filename)}"></i>
        </div>
        <div class="file-details">
          ${isDone
            ? `<a href="/transfer/${download.filename}" class="file-name download-link" title="Récupérer et supprimer du serveur">
                ${download.filename}
                <i class="fas fa-download"></i>
              </a>`
            : `<div class="file-name">${download.filename}</div>`
          }
          <div class="file-url" title="${download.url}">${download.url}</div>
        </div>
      </div>
      <div class="download-actions">
        <span class="status-badge status-${status}">
          <i class="fas ${statusIcon}"></i>
          ${statusLabel}
        </span>
        ${status === 'downloading'
          ? `<button class="btn-icon btn-danger" onclick="cancelDownload('${download.id}')" title="Annuler">
              <i class="fas fa-times"></i>
            </button>`
          : ''
        }
      </div>
    </div>

    ${!isDone && !isCancelled
      ? `<div class="progress-container">
          <div class="progress-bar" style="width: ${download.progress}%">
            <span class="progress-text">${download.progress}%</span>
          </div>
        </div>`
      : ''
    }

    <div class="download-stats">
      <div class="stat-item">
        <span class="stat-label">Progression</span>
        <span class="stat-value">${download.progress}%</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Vitesse</span>
        <span class="stat-value">${isDone ? '---' : (download.speed || '0 KB/s')}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Taille</span>
        <span class="stat-value">${download.currentSize || '0 B'} / ${download.fullSize || '???'}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Temps restant</span>
        <span class="stat-value">${isDone ? '0s' : (download.eta || '--')}</span>
      </div>
    </div>

    ${(isError || isInterrupted)
      ? `<div class="error-message">
          <i class="fas fa-exclamation-triangle"></i>
          ${download.error || "Arrêt inattendu"}
        </div>`
      : ''
    }
  `;

  // Auto-hide pour succès et annulation
  if (isDone || isCancelled) {
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(20px)';
      setTimeout(() => {
        el.remove();
        state.removeActiveDownload(download.id);
        
        // Remettre l'empty state si plus de downloads
        if (state.activeDownloads.size === 0) {
          elements.activeList.innerHTML = `
            <div class="empty-state">
              <i class="fas fa-cloud-download-alt"></i>
              <p>En attente de nouveaux téléchargements...</p>
            </div>
          `;
        }
      }, 500);
    }, CONFIG.AUTO_HIDE_DELAY);
  }
}

// ================= DOWNLOAD ACTIONS =================
async function cancelDownload(id) {
  try {
    const response = await fetch('/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });

    if (response.ok) {
      toast.info('Téléchargement annulé');
    } else {
      const data = await response.json();
      toast.error(data.error || 'Erreur d\'annulation');
    }
  } catch (e) {
    console.error('[CANCEL] Erreur:', e);
    toast.error('Erreur de connexion');
  }
}

async function cancelAllDownloads() {
  if (!confirm('Voulez-vous vraiment annuler tous les téléchargements actifs ?')) {
    return;
  }

  try {
    const response = await fetch('/cancel-all', { method: 'POST' });
    const data = await response.json();
    
    if (response.ok) {
      toast.success(`${data.cancelled} téléchargement(s) annulé(s)`);
    }
  } catch (e) {
    console.error('[CANCEL ALL] Erreur:', e);
    toast.error('Erreur de connexion');
  }
}

// ================= HISTORY =================
async function loadHistory(page = 1) {
  try {
    const response = await fetch('/history');
    const data = await response.json();
    
    state.setHistoryData(data);
    state.currentPage = page;

    // Pagination
    const totalPages = Math.ceil(data.length / CONFIG.ITEMS_PER_PAGE);
    const startIdx = (page - 1) * CONFIG.ITEMS_PER_PAGE;
    const endIdx = startIdx + CONFIG.ITEMS_PER_PAGE;
    const pageData = data.slice(startIdx, endIdx);

    // Affichage
    if (pageData.length === 0) {
      elements.historyList.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-folder-open"></i>
          <p>Aucun fichier dans la bibliothèque</p>
        </div>
      `;
    } else {
      elements.historyList.innerHTML = pageData.map(item => `
        <div class="download-item completed">
          <div class="download-header">
            <div class="file-info">
              <div class="file-icon success">
                <i class="fas ${getFileIcon(item.filename)}"></i>
              </div>
              <div class="file-details">
                <a href="/files/${item.filename}" target="_blank" class="file-name download-link">
                  ${item.filename}
                </a>
                <div class="file-meta">
                  <span>${formatFileSize(item.size)}</span>
                  <span class="meta-separator">•</span>
                  <span>${formatDate(item.date)}</span>
                </div>
              </div>
            </div>
            <span class="status-badge status-completed">
              <i class="fas fa-check"></i>
              Terminé
            </span>
          </div>
        </div>
      `).join('');
    }

    // Pagination controls
    updatePagination(page, totalPages);
  } catch (e) {
    console.error('[HISTORY] Erreur:', e);
    toast.error('Erreur de chargement de l\'historique');
  }
}

function updatePagination(currentPage, totalPages) {
  if (totalPages <= 1) {
    elements.paginationControls.style.display = 'none';
    return;
  }

  elements.paginationControls.style.display = 'flex';
  elements.currentPageSpan.textContent = currentPage;
  elements.totalPagesSpan.textContent = totalPages;

  elements.prevPageBtn.disabled = currentPage === 1;
  elements.nextPageBtn.disabled = currentPage === totalPages;
}

async function clearHistory() {
  if (!confirm('Voulez-vous vraiment vider l\'historique et supprimer tous les fichiers du serveur ?')) {
    return;
  }

  try {
    const response = await fetch('/clear-history');
    const data = await response.json();
    
    if (response.ok) {
      toast.success(`${data.deleted} fichier(s) supprimé(s)`);
      loadHistory();
    }
  } catch (e) {
    console.error('[CLEAR HISTORY] Erreur:', e);
    toast.error('Erreur de suppression');
  }
}

// ================= FORM SUBMISSION =================
async function handleFormSubmit(e) {
  e.preventDefault();

  const formData = new FormData(e.target);
  const urlsText = formData.get('url').trim();
  
  if (!urlsText) {
    toast.warning('Veuillez entrer au moins une URL');
    return;
  }

  const urls = urlsText.split(/\s+/).filter(u => u.trim());
  
  elements.submitBtn.disabled = true;
  elements.submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Traitement...</span>';

  let successCount = 0;
  let errorCount = 0;

  for (const url of urls) {
    try {
      // Validation URL
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;

      // Vérifier domaine autorisé
      if (state.allowedDomains.length > 0) {
        const isAllowed = state.allowedDomains.some(d => 
          hostname === d || hostname.endsWith('.' + d)
        );
        
        if (!isAllowed) {
          toast.error(`Domaine non autorisé: ${hostname}`);
          errorCount++;
          continue;
        }
      }

      // Envoyer la requête
      const response = await fetch('/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          customFilename: urls.length === 1 ? formData.get('customFilename') : '',
          referer: formData.get('referer'),
          ua: formData.get('ua'),
          noCheckCert: formData.get('noCheckCert') === 'on',
          singleSegment: formData.get('singleSegment') === 'on',
          cookies: formData.get('cookies')
        })
      });

      if (response.ok) {
        successCount++;
      } else {
        const data = await response.json();
        toast.error(data.error || 'Erreur serveur');
        errorCount++;
      }
    } catch (err) {
      console.error('[SUBMIT] Erreur:', err);
      toast.error(`URL invalide: ${url.substring(0, 50)}...`);
      errorCount++;
    }
  }

  // Reset form
  e.target.reset();
  elements.uaInput.value = navigator.userAgent;

  // Feedback
  if (successCount > 0) {
    toast.success(`${successCount} téléchargement(s) démarré(s)`);
  }
  if (errorCount > 0) {
    toast.error(`${errorCount} erreur(s)`);
  }

  elements.submitBtn.disabled = false;
  elements.submitBtn.innerHTML = '<i class="fas fa-bolt"></i> <span>Analyser et télécharger</span>';
}

// ================= CONFIG =================
async function loadConfig() {
  try {
    const response = await fetch('/config');
    const config = await response.json();
    state.allowedDomains = config.allowedDomains || [];
    console.log('[CONFIG] Chargé:', config);
  } catch (e) {
    console.error('[CONFIG] Erreur:', e);
  }
}

// ================= EVENT LISTENERS =================
function initializeEventListeners() {
  // Form submission
  elements.downloadForm.addEventListener('submit', handleFormSubmit);

  // Advanced toggle
  elements.advToggle.addEventListener('click', () => {
    elements.advOptions.classList.toggle('show');
    const icon = elements.advToggle.querySelector('.toggle-icon');
    icon.style.transform = elements.advOptions.classList.contains('show')
      ? 'rotate(180deg)'
      : 'rotate(0deg)';
  });

  // Cancel all
  elements.cancelAllBtn.addEventListener('click', cancelAllDownloads);

  // Clear history
  elements.clearHistoryBtn.addEventListener('click', clearHistory);

  // Refresh buttons
  elements.refreshActiveBtn?.addEventListener('click', () => {
    toast.info('Actualisation...');
    location.reload();
  });

  elements.refreshHistoryBtn?.addEventListener('click', () => {
    loadHistory(state.currentPage);
    toast.info('Historique actualisé');
  });

  // Pagination
  elements.prevPageBtn.addEventListener('click', () => {
    if (state.currentPage > 1) {
      loadHistory(state.currentPage - 1);
    }
  });

  elements.nextPageBtn.addEventListener('click', () => {
    const totalPages = Math.ceil(state.historyData.length / CONFIG.ITEMS_PER_PAGE);
    if (state.currentPage < totalPages) {
      loadHistory(state.currentPage + 1);
    }
  });

  // Settings button (placeholder)
  document.getElementById('settingsBtn')?.addEventListener('click', () => {
    toast.info('Paramètres à venir...');
  });
}

// ================= INITIALIZATION =================
async function initialize() {
  console.log('[APP] Initialisation...');

  // Set default UA
  elements.uaInput.value = navigator.userAgent;

  // Initialize event listeners
  initializeEventListeners();

  // Load config
  await loadConfig();

  // Load history
  await loadHistory();

  // Connect SSE
  sseManager = new SSEManager();

  console.log('[APP] Prêt');
}

// ================= CLEANUP =================
window.addEventListener('beforeunload', () => {
  if (sseManager) {
    sseManager.disconnect();
  }
});

// ================= START =================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize);
} else {
  initialize();
}

// ================= EXPOSE FOR INLINE HANDLERS =================
window.cancelDownload = cancelDownload;