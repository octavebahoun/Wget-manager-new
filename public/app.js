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
  analyzeBtn: document.getElementById('analyzeBtn'),
  formatSelection: document.getElementById('formatSelection'),
  formatList: document.getElementById('formatList'),
  advToggle: document.getElementById('advToggle'),
  advOptions: document.getElementById('advOptions'),
  activeList: document.getElementById('activeList'),
  historyList: document.getElementById('historyList'),
  cancelAllBtn: document.getElementById('cancelAllBtn'),
  clearHistoryBtn: document.getElementById('clearHistoryBtn'),
  refreshAllBtn: document.getElementById('refreshAllBtn'),
  statusIndicator: document.getElementById('statusIndicator'),
  statusText: document.getElementById('statusText'),
  toastContainer: document.getElementById('toastContainer'),
  // Sections and Nav
  navHome: document.getElementById('navHome'),
  navDownloads: document.getElementById('navDownloads'),
  navHistory: document.getElementById('navHistory'),
  sectionNew: document.getElementById('sectionNew'),
  sectionActive: document.getElementById('sectionActive'),
  sectionHistory: document.getElementById('sectionHistory'),
  pageTitle: document.getElementById('pageTitle')
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
    if (!elements.statusIndicator) return;

    if (connected) {
      elements.statusIndicator.className = 'indicator indicator-online';
      elements.statusText.textContent = 'Connecté';
    } else {
      elements.statusIndicator.className = 'indicator indicator-offline';
      elements.statusText.textContent = 'Déconnecté';
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
    // Supprimer le message vide
    if (elements.activeList.querySelector('.card')) {
      elements.activeList.innerHTML = '';
    }

    el = document.createElement('div');
    el.id = `dl-${download.id}`;
    el.className = 'card agent-card';
    elements.activeList.prepend(el);
  }

  const status = download.status;
  const isDone = status === 'completed';
  const isError = status === 'error';
  const progress = download.progress || 0;
  const eta = download.eta || '--';
  const speed = download.speed || '0 KB/s';

  el.innerHTML = `
    <div class="card-header">
      <div class="card-title-group">
        <div class="card-icon">
          <i class="fas ${getFileIcon(download.filename)}"></i>
        </div>
        <div>
          <h3 class="card-name">${download.filename}</h3>
          <p class="card-description" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px;">
            ${download.url}
          </p>
        </div>
      </div>
      <div class="agent-check">
        <i class="fas fa-check"></i>
      </div>
    </div>
    
    <div style="margin-top: 12px;">
      <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 8px;">
        <span>${speed}</span>
        <span>${eta}</span>
      </div>
      
      <div class="progress-container">
        <div class="progress-fill" style="width: ${progress}%"></div>
      </div>
      
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 16px;">
        <span class="card-badge" style="color: ${isError ? 'var(--status-error)' : 'white'}">
          ${STATUS_LABELS[status] || status}
        </span>
        ${status === 'downloading'
      ? `<button class="btn btn-outline btn-danger" onclick="cancelDownload('${download.id}')" style="padding: 4px 8px; font-size: 0.75rem;">
               Annuler
             </button>`
      : ''
    }
      </div>
    </div>
  `;

  // Auto-hide
  if (isDone || status === 'cancelled') {
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => {
        el.remove();
        state.removeActiveDownload(download.id);
        if (state.activeDownloads.size === 0) {
          elements.activeList.innerHTML = '<div class="card" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">Aucun téléchargement actif</div>';
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
        <div class="card" style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
          La bibliothèque est vide
        </div>
      `;
    } else {
      elements.historyList.innerHTML = pageData.map(item => `
        <div class="card agent-card">
          <div class="card-header">
            <div class="card-title-group">
              <div class="card-icon">
                <i class="fas ${getFileIcon(item.filename)}"></i>
              </div>
              <div>
                <a href="/files/${item.filename}" target="_blank">
                   <h3 class="card-name">${item.filename}</h3>
                </a>
                <p class="card-description">${formatFileSize(item.size)} • ${formatDate(item.date)}</p>
              </div>
            </div>
            <div class="agent-check" style="opacity: 1;">
              <i class="fas fa-check"></i>
            </div>
          </div>
          <div style="margin-top: 12px; display: flex; gap: 8px;">
             <a href="/files/${item.filename}" target="_blank" class="btn btn-outline" style="flex: 1; justify-content: center; font-size: 0.8rem; padding: 6px;">
                Ouvrir
             </a>
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
  const keepFiles = document.getElementById('keepFilesCheck')?.checked || false;
  const msg = keepFiles
    ? 'Voulez-vous vider l\'historique (en gardant les fichiers sur le disque) ?'
    : 'ATTENTION : Voulez-vous supprimer l\'historique ET tous les fichiers téléchargés ?';

  if (!confirm(msg)) {
    return;
  }

  try {
    const response = await fetch(`/clear-history?keepFiles=${keepFiles}`, { method: 'DELETE' });
    const data = await response.json();

    if (response.ok) {
      toast.success(data.message);
      loadHistory();
    } else {
      toast.error(data.error || 'Erreur');
    }
  } catch (e) {
    console.error('[CLEAR HISTORY] Erreur:', e);
    toast.error('Erreur de suppression');
  }
}

// ================= FORM SUBMISSION =================
// ================= FORMAT ANALYSIS =================
function isVideoPlatform(url) {
  const platforms = ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'twitch.tv'];
  try {
    const hostname = new URL(url).hostname;
    return platforms.some(p => hostname.includes(p));
  } catch { return false; }
}

function onUrlInputChange() {
  const url = elements.urlInput.value.trim().split(/\s+/)[0];
  if (isVideoPlatform(url) && elements.urlInput.value.trim().split(/\s+/).length === 1) {
    elements.analyzeBtn.style.display = 'block';
  } else {
    elements.analyzeBtn.style.display = 'none';
    elements.formatSelection.style.display = 'none';
  }
}

async function analyzeFormats() {
  const url = elements.urlInput.value.trim();
  if (!url) {
    toast.warning("Veuillez entrer une URL à analyser.");
    return;
  }

  elements.analyzeBtn.disabled = true;
  elements.analyzeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Analyse...`;

  try {
    const response = await fetch('/api/formats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Erreur inconnue');
    }

    const data = await response.json();
    displayFormats(data.formats);
  } catch (e) {
    toast.error(`Erreur d'analyse: ${e.message}`);
    elements.formatSelection.style.display = 'none';
  } finally {
    elements.analyzeBtn.disabled = false;
    elements.analyzeBtn.innerHTML = `<i class="fas fa-search"></i> Analyser les qualités`;
  }
}

function displayFormats(formats) {
  if (!formats || formats.length === 0) {
    elements.formatList.innerHTML = '<p>Aucun format vidéo/audio trouvé.</p>';
    elements.formatSelection.style.display = 'block';
    return;
  }

  elements.formatList.innerHTML = formats.map((f, index) => {
    const label = `${f.resolution || ''} ${f.ext} (${f.note || 'Audio'}) - ${formatFileSize(f.fileSize)}`;
    return `
      <div class="format-item">
        <input type="radio" id="format-${index}" name="formatCode" value="${f.formatId}" ${index === 0 ? 'checked' : ''}>
        <label for="format-${index}">${label}</label>
      </div>
    `;
  }).join('');

  elements.formatSelection.style.display = 'block';
}


// ================= FORM SUBMISSION =================
async function handleFormSubmit(e) {
  e.preventDefault();

  const formData = new FormData(e.target);
  const urlsText = formData.get('url').trim();
  const selectedFormat = formData.get('formatCode');

  if (!urlsText) {
    toast.warning('Veuillez entrer au moins une URL');
    return;
  }

  const urls = urlsText.split(/\s+/).filter(u => u.trim());

  if (urls.length > 1 && selectedFormat) {
    toast.warning("Le choix de la qualité n'est disponible que pour une seule URL à la fois.");
    return;
  }

  elements.submitBtn.disabled = true;
  elements.submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Traitement...</span>';

  let successCount = 0;
  let errorCount = 0;

  for (const url of urls) {
    try {
      if (!url.startsWith('magnet:')) {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;
        if (state.allowedDomains.length > 0 && !state.allowedDomains.some(d => hostname === d || hostname.endsWith('.' + d))) {
          toast.error(`Domaine non autorisé: ${hostname}`);
          errorCount++;
          continue;
        }
      }

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
          cookies: formData.get('cookies'),
          connections: formData.get('connections'),
          formatCode: selectedFormat
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

  e.target.reset();
  if (elements.uaInput) elements.uaInput.value = navigator.userAgent;
  elements.formatSelection.style.display = 'none';

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

// ================= NAVIGATION =================
function showSection(sectionId) {
  // Update UI sections
  [elements.sectionNew, elements.sectionActive, elements.sectionHistory].forEach(s => {
    if (s) s.classList.add('hidden');
  });

  const target = document.getElementById(`section${sectionId}`);
  if (target) target.classList.remove('hidden');

  // Update nav active state
  [elements.navHome, elements.navDownloads, elements.navHistory].forEach(n => {
    if (n) n.classList.remove('active');
  });

  const navTarget = document.getElementById(`nav${sectionId}`);
  if (navTarget) navTarget.classList.add('active');

  // Update title
  const titles = { Home: 'Maison', Downloads: 'Téléchargements', History: 'Bibliothèque' };
  if (elements.pageTitle) {
    elements.pageTitle.textContent = titles[sectionId] || 'Tableau de bord';
  }
}

// ================= EVENT LISTENERS =================
function initEventListeners() {
  // Navigation
  if (elements.navHome) elements.navHome.addEventListener('click', (e) => { e.preventDefault(); showSection('Home'); });
  if (elements.navDownloads) elements.navDownloads.addEventListener('click', (e) => { e.preventDefault(); showSection('Downloads'); });
  if (elements.navHistory) elements.navHistory.addEventListener('click', (e) => { e.preventDefault(); showSection('History'); });

  const newBtn = document.getElementById('newDownloadBtn');
  if (newBtn) newBtn.addEventListener('click', () => showSection('Home'));

  // Form & Analysis
  if (elements.downloadForm) elements.downloadForm.addEventListener('submit', handleFormSubmit);
  if (elements.urlInput) elements.urlInput.addEventListener('input', onUrlInputChange);
  if (elements.analyzeBtn) elements.analyzeBtn.addEventListener('click', analyzeFormats);
  if (elements.advToggle) elements.advToggle.addEventListener('click', () => elements.advOptions.classList.toggle('hidden'));

  // Actions
  if (elements.cancelAllBtn) elements.cancelAllBtn.addEventListener('click', cancelAllDownloads);
  if (elements.clearHistoryBtn) elements.clearHistoryBtn.addEventListener('click', clearHistory);
  if (elements.refreshAllBtn) elements.refreshAllBtn.addEventListener('click', () => {
    loadHistory();
    toast.info('Actualisation...');
  });
}

// ================= INIT =================
window.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  if (elements.uaInput) elements.uaInput.value = navigator.userAgent;
  sseManager = new SSEManager();
  loadConfig();
  loadHistory();
  showSection('Home');
});

// Expose for context
window.cancelDownload = cancelDownload;