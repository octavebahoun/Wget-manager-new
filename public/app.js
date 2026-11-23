// app.js — Interface web Web Wget Pro
'use strict';

// ================= CONSTANTES =================
const CONFIG = {
  ITEMS_PER_PAGE: 30,
  AUTO_HIDE_DELAY: 10000,
  TOAST_DURATION: 5000,
  MAX_RECONNECT_DELAY: 15000,
};

const STATUS = {
  queued: { icon: 'fa-clock', label: 'En file' },
  analyzing: { icon: 'fa-magnifying-glass', label: 'Analyse' },
  downloading: { icon: 'fa-spinner fa-spin', label: 'En cours' },
  processing: { icon: 'fa-gear fa-spin', label: 'Finalisation' },
  retrying: { icon: 'fa-rotate', label: 'Nouvel essai' },
  completed: { icon: 'fa-check-circle', label: 'Terminé' },
  error: { icon: 'fa-exclamation-circle', label: 'Échec' },
  cancelled: { icon: 'fa-times-circle', label: 'Annulé' },
};
const ACTIVE = new Set(['queued', 'analyzing', 'downloading', 'processing', 'retrying']);

const KIND_LABELS = {
  platform: 'Plateforme',
  hls: 'HLS',
  dash: 'DASH',
  stream: 'Flux',
  'vimeo-json': 'Vimeo',
  direct: 'Fichier',
  segment: 'Fragment',
  page: 'Page web',
};

const PLAYABLE = /\.(mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|oga|opus|wav|flac|jpg|jpeg|png|gif|webp|avif)$/i;

// ================= ÉTAT =================
const state = {
  jobs: new Map(),
  hidden: new Set(), // jobs terminés déjà rangés dans la bibliothèque
  library: [],
  page: 1,
  search: '',
  config: null,
  analysis: null,
  notifAsked: false,
};

const $ = (id) => document.getElementById(id);
const els = {
  form: $('downloadForm'),
  urlInput: $('urlInput'),
  uaInput: $('uaInput'),
  submitBtn: $('submitBtn'),
  analyzeBtn: $('analyzeBtn'),
  advToggle: $('advToggle'),
  advOptions: $('advOptions'),
  analysisSection: $('analysisSection'),
  analysisCard: $('analysisCard'),
  activeList: $('activeList'),
  activeCount: $('activeCount'),
  historyList: $('historyList'),
  historyCount: $('historyCount'),
  librarySearch: $('librarySearch'),
  cancelAllBtn: $('cancelAllBtn'),
  clearFinishedBtn: $('clearFinishedBtn'),
  clearHistoryBtn: $('clearHistoryBtn'),
  refreshHistoryBtn: $('refreshHistoryBtn'),
  pagination: $('paginationControls'),
  prevPage: $('prevPage'),
  nextPage: $('nextPage'),
  currentPage: $('currentPage'),
  totalPages: $('totalPages'),
  connection: $('connectionStatus'),
  serverWarning: $('serverWarning'),
  footerVersion: $('footerVersion'),
  modal: $('modal'),
  modalTitle: $('modalTitle'),
  modalBody: $('modalBody'),
  toastContainer: $('toastContainer'),
};

// ================= OUTILS =================
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

function getApiKey() {
  try {
    return localStorage.getItem('wget.apiKey') || '';
  } catch {
    return '';
  }
}

function setApiKey(key) {
  try {
    if (key) localStorage.setItem('wget.apiKey', key);
    else localStorage.removeItem('wget.apiKey');
  } catch { /* stockage indisponible */ }
}

function withKey(url) {
  const key = getApiKey();
  return key ? `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}` : url;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const key = getApiKey();
  if (key) headers['X-API-Key'] = key;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try {
    data = await res.json();
  } catch { /* pas de JSON */ }
  if (res.status === 401) {
    openSettings('Ce serveur demande une clé API.');
    throw new Error(data?.error || 'Clé API requise');
  }
  if (!res.ok) throw new Error(data?.error || `Erreur HTTP ${res.status}`);
  return data;
}

function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${parseFloat((n / 1024 ** i).toFixed(2))} ${units[i]}`;
}

function formatDate(date) {
  return new Date(date).toLocaleString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(seconds) {
  const s = Math.round(Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.length > 60 ? `${u.pathname.slice(0, 57)}…` : u.pathname;
    return `${u.hostname}${p}`;
  } catch {
    return String(url || '');
  }
}

function fileIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const map = {
    mp4: 'fa-video', mkv: 'fa-video', avi: 'fa-video', mov: 'fa-video', webm: 'fa-video', flv: 'fa-video', m4v: 'fa-video', ts: 'fa-video',
    mp3: 'fa-music', wav: 'fa-music', flac: 'fa-music', aac: 'fa-music', m4a: 'fa-music', ogg: 'fa-music', opus: 'fa-music',
    jpg: 'fa-image', jpeg: 'fa-image', png: 'fa-image', gif: 'fa-image', webp: 'fa-image', svg: 'fa-image',
    zip: 'fa-file-zipper', rar: 'fa-file-zipper', '7z': 'fa-file-zipper', tar: 'fa-file-zipper', gz: 'fa-file-zipper',
    pdf: 'fa-file-pdf', doc: 'fa-file-word', docx: 'fa-file-word', xls: 'fa-file-excel', xlsx: 'fa-file-excel',
    ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint', txt: 'fa-file-lines', epub: 'fa-book',
    exe: 'fa-cube', msi: 'fa-cube', deb: 'fa-cube', dmg: 'fa-cube', apk: 'fa-mobile-screen',
  };
  return map[ext] || 'fa-file';
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.html = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<i class="fas fa-spinner fa-spin"></i> <span>${escapeHtml(label || 'Patientez…')}</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.html) button.innerHTML = button.dataset.html;
  }
}

// ================= NOTIFICATIONS =================
const toast = {
  show(message, type = 'info', duration = CONFIG.TOAST_DURATION) {
    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    const icon = document.createElement('i');
    icon.className = `fas ${icons[type] || icons.info}`;
    const text = document.createElement('span');
    text.textContent = message;
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Fermer');
    close.innerHTML = '<i class="fas fa-times"></i>';
    close.addEventListener('click', () => el.remove());
    el.append(icon, text, close);
    els.toastContainer.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, duration);
  },
  success(m) { this.show(m, 'success'); },
  error(m) { this.show(m, 'error', 9000); },
  warning(m) { this.show(m, 'warning', 7000); },
  info(m) { this.show(m, 'info'); },
};

const sound = {
  ctx: null,
  beep(type, from, to, duration, volume) {
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(from, this.ctx.currentTime);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, this.ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(volume, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch { /* audio indisponible */ }
  },
  success() { this.beep('sine', 880, 1320, 0.3, 0.12); },
  error() { this.beep('sawtooth', 200, 0, 0.2, 0.08); },
};

function desktopNotify(title, body) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try {
      new Notification(title, { body });
    } catch { /* ignore */ }
  }
}

function askNotificationPermission() {
  if (state.notifAsked || !('Notification' in window) || Notification.permission !== 'default') return;
  state.notifAsked = true;
  Notification.requestPermission().catch(() => {});
}

// ================= TEMPS RÉEL (SSE) =================
const live = {
  es: null,
  delay: 1000,
  timer: null,
  connect() {
    clearTimeout(this.timer);
    if (this.es) this.es.close();
    this.es = new EventSource(withKey('/events'));
    this.es.onopen = () => {
      this.delay = 1000;
      setConnected(true);
    };
    this.es.onmessage = (event) => {
      try {
        handleEvent(JSON.parse(event.data));
      } catch (e) {
        console.error('[SSE]', e);
      }
    };
    this.es.onerror = () => {
      setConnected(false);
      this.es.close();
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, CONFIG.MAX_RECONNECT_DELAY);
    };
  },
  close() {
    clearTimeout(this.timer);
    if (this.es) this.es.close();
  },
};

function setConnected(ok) {
  els.connection.classList.toggle('online', ok);
  els.connection.classList.toggle('offline', !ok);
  els.connection.querySelector('.status-text').textContent = ok ? 'Connecté' : 'Déconnecté';
}

function handleEvent(msg) {
  if (msg.type === 'snapshot') {
    state.jobs.clear();
    for (const job of msg.downloads || []) {
      state.jobs.set(job.id, job);
      if (job.status === 'completed') state.hidden.add(job.id);
    }
    renderJobs();
  } else if (msg.type === 'update' && msg.download) {
    const prev = state.jobs.get(msg.download.id);
    state.jobs.set(msg.download.id, msg.download);
    if (prev && prev.status !== msg.download.status) onStatusChange(msg.download);
    renderJob(msg.download);
  } else if (msg.type === 'removed') {
    state.jobs.delete(msg.id);
    $(`dl-${msg.id}`)?.remove();
    updateCounts();
  } else if (msg.type === 'library-changed') {
    scheduleLibraryReload();
  }
}

function onStatusChange(job) {
  const name = job.filename || job.title || shortUrl(job.url);
  if (job.status === 'completed') {
    sound.success();
    toast.success(`Terminé : ${name}`);
    desktopNotify('Téléchargement terminé', name);
    setTimeout(() => {
      state.hidden.add(job.id);
      const el = $(`dl-${job.id}`);
      if (!el) return;
      el.classList.add('fade-out');
      setTimeout(() => {
        el.remove();
        updateCounts();
      }, 400);
    }, CONFIG.AUTO_HIDE_DELAY);
  } else if (job.status === 'error') {
    sound.error();
    toast.error(`Échec : ${name}`);
    desktopNotify('Téléchargement échoué', name);
  }
}

// ================= LISTE DES TÉLÉCHARGEMENTS =================
function isVisible(job) {
  return job.status !== 'completed' || !state.hidden.has(job.id);
}

function statsTemplate(j) {
  const done = j.status === 'completed';
  return `
    <div class="download-stats">
      <div class="stat-item"><span class="stat-label">Progression</span><span class="stat-value">${escapeHtml(Math.round(j.progress || 0))}%</span></div>
      <div class="stat-item"><span class="stat-label">Vitesse</span><span class="stat-value">${done ? '—' : escapeHtml(j.speed || '—')}</span></div>
      <div class="stat-item"><span class="stat-label">Taille</span><span class="stat-value">${done ? escapeHtml(j.fullSize) : `${escapeHtml(j.currentSize || '0 B')} / ${escapeHtml(j.fullSize || '???')}`}</span></div>
      <div class="stat-item"><span class="stat-label">Temps restant</span><span class="stat-value">${done ? '—' : escapeHtml(j.eta || '—')}</span></div>
    </div>`;
}

function jobTemplate(j) {
  const st = STATUS[j.status] || { icon: 'fa-circle-question', label: j.status };
  const files = j.files || [];
  const name = (files[0] ? files[0].split('/').pop() : null) || j.name || j.title || shortUrl(j.url);
  const active = ACTIVE.has(j.status);
  const done = j.status === 'completed';
  const showProgress = active && j.status !== 'queued' && j.status !== 'retrying';
  const indeterminate = showProgress && (!j.progress || j.status === 'processing' || j.status === 'analyzing');
  const quality = j.quality && j.quality !== 'best' ? (j.quality === 'audio' ? 'MP3' : `≤ ${j.quality}p`) : '';
  const titleLine = done && files[0]
    ? `<a href="${withKey(`/dl/${encodePath(files[0])}`)}" class="file-name download-link" title="Télécharger sur ce PC">${escapeHtml(name)} <i class="fas fa-download"></i></a>`
    : `<div class="file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>`;
  return `
    <div class="download-header">
      <div class="file-info">
        <div class="file-icon ${done ? 'success' : ''}"><i class="fas ${fileIcon(name)}"></i></div>
        <div class="file-details">
          ${titleLine}
          <div class="file-url" title="${escapeHtml(j.url)}">${escapeHtml(j.url)}</div>
          <div class="job-tags">
            ${j.engine ? `<span class="tag">${escapeHtml(j.engine)}</span>` : ''}
            ${j.kind ? `<span class="tag tag-kind">${escapeHtml(KIND_LABELS[j.kind] || j.kind)}</span>` : ''}
            ${quality ? `<span class="tag">${escapeHtml(quality)}</span>` : ''}
            ${files.length > 1 ? `<span class="tag">${files.length} fichiers</span>` : ''}
            ${j.status === 'queued' && j.queuePosition ? `<span class="tag">n°${escapeHtml(j.queuePosition)} dans la file</span>` : ''}
            ${j.phase && !done ? `<span class="tag tag-phase">${escapeHtml(j.phase)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="download-actions">
        <span class="status-badge status-${escapeHtml(j.status)}"><i class="fas ${st.icon}"></i> ${escapeHtml(st.label)}</span>
        ${done && files[0] && PLAYABLE.test(files[0]) ? `<button class="btn-icon" data-action="play" data-file="${escapeHtml(files[0])}" title="Lire"><i class="fas fa-play"></i></button>` : ''}
        ${['error', 'cancelled'].includes(j.status) ? `<button class="btn-icon" data-action="retry" data-id="${escapeHtml(j.id)}" title="Réessayer"><i class="fas fa-rotate-right"></i></button>` : ''}
        ${active ? `<button class="btn-icon btn-danger" data-action="cancel" data-id="${escapeHtml(j.id)}" title="Annuler"><i class="fas fa-times"></i></button>` : `<button class="btn-icon" data-action="dismiss" data-id="${escapeHtml(j.id)}" title="Retirer de la liste"><i class="fas fa-xmark"></i></button>`}
      </div>
    </div>
    ${showProgress ? `<div class="progress-container${indeterminate ? ' indeterminate' : ''}"><div class="progress-bar" style="width:${indeterminate ? 100 : Math.max(2, Math.min(100, Number(j.progress) || 0))}%"></div></div>` : ''}
    ${active && j.status !== 'queued' ? statsTemplate(j) : ''}
    ${j.warning && active ? `<div class="warning-message"><i class="fas fa-circle-info"></i> ${escapeHtml(j.warning)}</div>` : ''}
    ${(j.status === 'error' || j.status === 'retrying') && j.error ? `<div class="error-message"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(j.error)}</div>` : ''}`;
}

function renderJob(job) {
  let el = $(`dl-${job.id}`);
  if (!isVisible(job)) {
    el?.remove();
    updateCounts();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = `dl-${job.id}`;
    els.activeList.querySelector('.empty-state')?.remove();
    els.activeList.prepend(el);
  }
  el.className = `download-item item-${job.status}`;
  el.innerHTML = jobTemplate(job);
  updateCounts();
}

function renderJobs() {
  els.activeList.innerHTML = '';
  const list = [...state.jobs.values()]
    .filter(isVisible)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  for (const job of list) renderJob(job);
  updateCounts();
}

function updateCounts() {
  const active = [...state.jobs.values()].filter((j) => ACTIVE.has(j.status)).length;
  els.activeCount.textContent = active;
  if (!els.activeList.children.length) {
    els.activeList.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-cloud-download-alt"></i>
        <p>Aucun téléchargement en cours</p>
      </div>`;
  }
}

// ================= ACTIONS =================
function formOptions() {
  const fd = new FormData(els.form);
  return {
    quality: fd.get('quality') || 'best',
    playlist: fd.get('playlist') === 'on',
    customFilename: (fd.get('customFilename') || '').trim(),
    referer: (fd.get('referer') || '').trim() || undefined,
    ua: (fd.get('ua') || '').trim() || navigator.userAgent,
    cookies: (fd.get('cookies') || '').trim() || undefined,
    format: (fd.get('format') || '').trim() || undefined,
    subtitles: fd.get('subtitles') === 'on',
    noCheckCert: fd.get('noCheckCert') === 'on',
    singleSegment: fd.get('singleSegment') === 'on',
  };
}

function parseUrls(text) {
  return String(text || '').split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
}

async function startDownloads(urls, extra = {}) {
  askNotificationPermission();
  const options = { ...formOptions(), ...extra };
  if (urls.length !== 1) options.customFilename = '';
  const data = await api('/download', { method: 'POST', body: { ...options, urls } });
  const n = data.jobs?.length || 1;
  toast.success(n > 1 ? `${n} téléchargements ajoutés` : 'Téléchargement ajouté');
  for (const e of data.errors || []) toast.error(`${shortUrl(e.url)} : ${e.error}`);
  return data;
}

async function handleSubmit(event) {
  event.preventDefault();
  const urls = parseUrls(els.urlInput.value);
  if (!urls.length) {
    toast.warning('Collez au moins un lien http(s)');
    els.urlInput.focus();
    return;
  }
  setBusy(els.submitBtn, true, 'Envoi…');
  try {
    await startDownloads(urls);
    els.urlInput.value = '';
    $('customFilename').value = '';
  } catch (e) {
    toast.error(e.message);
  } finally {
    setBusy(els.submitBtn, false);
  }
}

async function cancelJob(id) {
  try {
    await api('/cancel', { method: 'POST', body: { id } });
  } catch (e) {
    toast.error(e.message);
  }
}

async function retryJob(id) {
  try {
    await api('/retry', { method: 'POST', body: { id } });
    toast.info('Relancé');
  } catch (e) {
    toast.error(e.message);
  }
}

async function dismissJob(id) {
  try {
    await api(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    toast.error(e.message);
  }
}

async function cancelAll() {
  const active = [...state.jobs.values()].filter((j) => ACTIVE.has(j.status)).length;
  if (!active) return toast.info('Rien à arrêter');
  if (!confirm(`Arrêter les ${active} téléchargement(s) en cours ?`)) return;
  try {
    const data = await api('/cancel-all', { method: 'POST' });
    toast.success(data.message);
  } catch (e) {
    toast.error(e.message);
  }
}

async function clearFinished() {
  try {
    const data = await api('/api/jobs/clear', { method: 'POST' });
    toast.info(`${data.removed} élément(s) retiré(s)`);
  } catch (e) {
    toast.error(e.message);
  }
}

// ================= ANALYSE =================
async function analyzeLink() {
  const url = parseUrls(els.urlInput.value)[0];
  if (!url) {
    toast.warning('Collez un lien à analyser');
    els.urlInput.focus();
    return;
  }
  setBusy(els.analyzeBtn, true, 'Analyse…');
  try {
    const opts = formOptions();
    const data = await api('/api/analyze', {
      method: 'POST',
      body: { url, referer: opts.referer, ua: opts.ua, cookies: opts.cookies, playlist: opts.playlist, noCheckCert: opts.noCheckCert },
    });
    state.analysis = data;
    renderAnalysis(data);
  } catch (e) {
    toast.error(e.message);
  } finally {
    setBusy(els.analyzeBtn, false);
  }
}

function renderAnalysis(a) {
  const formats = [{ id: 'best', label: 'Meilleure qualité' }, ...(a.formats || [])];
  const canDownloadMain = !a.drm && (a.kind !== 'page' || a.engine === 'yt-dlp');
  const tags = [
    `<span class="tag tag-kind">${escapeHtml(KIND_LABELS[a.kind] || a.kind)}</span>`,
    a.engine ? `<span class="tag">${escapeHtml(a.engine)}</span>` : '',
    a.duration ? `<span class="tag"><i class="far fa-clock"></i> ${escapeHtml(formatDuration(a.duration))}</span>` : '',
    a.size ? `<span class="tag">${escapeHtml(formatFileSize(a.size))}</span>` : '',
    a.uploader ? `<span class="tag"><i class="fas fa-user"></i> ${escapeHtml(a.uploader)}</span>` : '',
    a.isPlaylist ? `<span class="tag">Playlist · ${escapeHtml(a.count)} éléments</span>` : '',
  ].join('');
  const thumb = a.thumbnail
    ? `<img class="analysis-thumb" src="${escapeHtml(a.thumbnail)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
    : '<div class="analysis-thumb placeholder"><i class="fas fa-film"></i></div>';
  const candidates = a.candidates || [];

  els.analysisCard.innerHTML = `
    <div class="analysis-header">
      ${thumb}
      <div class="analysis-info">
        <h3 class="analysis-title">${escapeHtml(a.title || a.filename || shortUrl(a.url))}</h3>
        <div class="file-url" title="${escapeHtml(a.url)}">${escapeHtml(a.url)}</div>
        <div class="job-tags">${tags}</div>
      </div>
      <button class="icon-btn" data-action="close-analysis" title="Fermer" aria-label="Fermer"><i class="fas fa-times"></i></button>
    </div>
    ${(a.warnings || []).map((w) => `<div class="warning-message"><i class="fas fa-circle-info"></i> ${escapeHtml(w)}</div>`).join('')}
    ${canDownloadMain ? `
      <div class="format-row">
        <span class="format-label">${a.isPlaylist ? 'Toute la playlist en :' : 'Télécharger en :'}</span>
        ${formats.map((f) => `<button type="button" class="chip" data-action="dl-format" data-quality="${escapeHtml(f.id)}">${escapeHtml(f.label)}${f.size ? ` <small>${escapeHtml(formatFileSize(f.size))}</small>` : ''}</button>`).join('')}
      </div>` : ''}
    ${candidates.length ? `
      <div class="candidates">
        <div class="candidates-header">
          <label class="checkbox-label"><input type="checkbox" id="candAll"><span class="checkbox-text">${a.isPlaylist ? 'Éléments de la playlist' : 'Médias trouvés dans la page'} (${candidates.length})</span></label>
          <button type="button" class="btn-secondary" data-action="dl-selected"><i class="fas fa-download"></i> Télécharger la sélection</button>
        </div>
        <div class="candidate-list">
          ${candidates.map((c, i) => `
            <div class="candidate">
              <input type="checkbox" class="cand-check" value="${i}" aria-label="Sélectionner">
              <span class="tag tag-kind">${escapeHtml(KIND_LABELS[c.kind] || c.kind)}</span>
              <span class="candidate-name" title="${escapeHtml(c.url)}">${escapeHtml(c.label || shortUrl(c.url))}</span>
              <button type="button" class="btn-icon" data-action="copy" data-index="${i}" title="Copier le lien"><i class="fas fa-copy"></i></button>
              <button type="button" class="btn-icon" data-action="dl-candidate" data-index="${i}" title="Télécharger"><i class="fas fa-download"></i></button>
            </div>`).join('')}
        </div>
      </div>` : ''}
    ${!canDownloadMain && !candidates.length && !a.drm ? '<div class="warning-message"><i class="fas fa-circle-info"></i> Rien de téléchargeable trouvé. Ouvrez la page dans le navigateur et utilisez l\'extension (elle voit les flux chargés par le lecteur).</div>' : ''}`;
  const img = els.analysisCard.querySelector('img.analysis-thumb');
  img?.addEventListener('error', () => {
    img.outerHTML = '<div class="analysis-thumb placeholder"><i class="fas fa-film"></i></div>';
  }, { once: true });
  els.analysisSection.hidden = false;
  els.analysisSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function onAnalysisClick(event) {
  const btn = event.target.closest('[data-action]');
  const a = state.analysis;
  if (event.target.id === 'candAll') {
    els.analysisCard.querySelectorAll('.cand-check').forEach((c) => { c.checked = event.target.checked; });
    return;
  }
  if (!btn || !a) return;
  const action = btn.dataset.action;
  const pageExtra = a.kind === 'page' ? { referer: a.url, pageUrl: a.url, title: a.title || undefined } : {};
  try {
    if (action === 'close-analysis') {
      els.analysisSection.hidden = true;
      state.analysis = null;
    } else if (action === 'dl-format') {
      await startDownloads([a.url], { quality: btn.dataset.quality, playlist: !!a.isPlaylist });
    } else if (action === 'dl-candidate') {
      const c = a.candidates[Number(btn.dataset.index)];
      await startDownloads([c.url], { ...pageExtra, customFilename: '' });
    } else if (action === 'copy') {
      const c = a.candidates[Number(btn.dataset.index)];
      await navigator.clipboard.writeText(c.url);
      toast.info('Lien copié');
    } else if (action === 'dl-selected') {
      const picked = [...els.analysisCard.querySelectorAll('.cand-check:checked')].map((c) => a.candidates[Number(c.value)].url);
      if (!picked.length) return toast.warning('Cochez au moins un média');
      await startDownloads(picked, pageExtra);
    }
  } catch (e) {
    toast.error(e.message);
  }
}

// ================= BIBLIOTHÈQUE =================
let libraryTimer = null;
function scheduleLibraryReload() {
  clearTimeout(libraryTimer);
  libraryTimer = setTimeout(loadLibrary, 400);
}

async function loadLibrary() {
  try {
    state.library = await api('/history');
    renderLibrary();
  } catch (e) {
    console.error('[BIBLIOTHÈQUE]', e);
  }
}

function libraryItemTemplate(f) {
  const href = withKey(`/files/${encodePath(f.filename)}`);
  return `
    <div class="download-item completed library-item">
      <div class="download-header">
        <div class="file-info">
          <div class="file-icon success"><i class="fas ${fileIcon(f.name || f.filename)}"></i></div>
          <div class="file-details">
            <a href="${href}" target="_blank" rel="noopener" class="file-name download-link" title="Ouvrir dans le navigateur">${escapeHtml(f.filename)}</a>
            <div class="file-meta">
              <span>${escapeHtml(formatFileSize(f.size))}</span>
              <span class="meta-separator">•</span>
              <span>${escapeHtml(formatDate(f.date))}</span>
            </div>
          </div>
        </div>
        <div class="download-actions">
          ${PLAYABLE.test(f.filename) ? `<button class="btn-icon" data-action="play" data-file="${escapeHtml(f.filename)}" title="Lire / voir"><i class="fas fa-play"></i></button>` : ''}
          <a class="btn-icon" href="${withKey(`/dl/${encodePath(f.filename)}`)}" title="Télécharger sur ce PC"><i class="fas fa-download"></i></a>
          <a class="btn-icon" href="${withKey(`/transfer/${encodePath(f.filename)}`)}" title="Récupérer puis supprimer du serveur"><i class="fas fa-file-export"></i></a>
          <button class="btn-icon btn-danger" data-action="delete" data-file="${escapeHtml(f.filename)}" title="Supprimer du serveur"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    </div>`;
}

function renderLibrary() {
  const q = state.search.trim().toLowerCase();
  const items = q ? state.library.filter((f) => f.filename.toLowerCase().includes(q)) : state.library;
  els.historyCount.textContent = state.library.length;
  const totalPages = Math.max(1, Math.ceil(items.length / CONFIG.ITEMS_PER_PAGE));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * CONFIG.ITEMS_PER_PAGE;
  const pageItems = items.slice(start, start + CONFIG.ITEMS_PER_PAGE);
  els.historyList.innerHTML = pageItems.length
    ? pageItems.map(libraryItemTemplate).join('')
    : `<div class="empty-state"><i class="fas fa-folder-open"></i><p>${q ? 'Aucun fichier ne correspond' : 'Aucun fichier dans la bibliothèque'}</p></div>`;
  els.pagination.style.display = totalPages > 1 ? 'flex' : 'none';
  els.currentPage.textContent = state.page;
  els.totalPages.textContent = totalPages;
  els.prevPage.disabled = state.page <= 1;
  els.nextPage.disabled = state.page >= totalPages;
}

async function deleteFile(file) {
  if (!confirm(`Supprimer « ${file} » du serveur ?`)) return;
  try {
    await api(`/files/${encodePath(file)}`, { method: 'DELETE' });
    toast.info('Fichier supprimé');
  } catch (e) {
    toast.error(e.message);
  }
}

async function clearLibrary() {
  if (!state.library.length) return toast.info('La bibliothèque est déjà vide');
  if (!confirm(`Supprimer définitivement les ${state.library.length} fichier(s) du serveur ?`)) return;
  try {
    const data = await api('/clear-history', { method: 'DELETE' });
    toast.success(data.message);
  } catch (e) {
    toast.error(e.message);
  }
}

// ================= FENÊTRES =================
function openModal(title, html) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = html;
  els.modal.hidden = false;
  document.body.classList.add('modal-open');
}

function closeModal() {
  els.modal.hidden = true;
  els.modalBody.innerHTML = '';
  document.body.classList.remove('modal-open');
}

function openPlayer(file) {
  const src = withKey(`/files/${encodePath(file)}`);
  let media;
  if (/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(file)) media = `<audio controls autoplay src="${src}"></audio>`;
  else if (/\.(jpg|jpeg|png|gif|webp|avif)$/i.test(file)) media = `<img src="${src}" alt="">`;
  else media = `<video controls autoplay playsinline src="${src}"></video>`;
  openModal(file.split('/').pop(), `<div class="player">${media}</div>
    <div class="modal-actions">
      <a class="btn-secondary" href="${withKey(`/dl/${encodePath(file)}`)}"><i class="fas fa-download"></i> Télécharger sur ce PC</a>
    </div>`);
}

async function openSettings(reason) {
  let cfg = state.config;
  try {
    cfg = await (await fetch(withKey('/config'))).json();
    state.config = cfg;
  } catch { /* hors ligne */ }
  const b = cfg?.binaries || {};
  const row = (label, value, hint) => `<li class="${value ? 'ok' : 'ko'}"><i class="fas ${value ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> <strong>${label}</strong> ${value ? escapeHtml(value) : `absent — ${hint}`}</li>`;
  openModal('Paramètres', `
    ${reason ? `<div class="warning-message"><i class="fas fa-key"></i> ${escapeHtml(reason)}</div>` : ''}
    <h4>Outils du serveur</h4>
    <ul class="tool-list">
      ${row('aria2c', b.aria2c, 'fichiers directs (installez aria2)')}
      ${row('yt-dlp', b.ytdlp, 'YouTube & plateformes (pipx install yt-dlp)')}
      ${row('ffmpeg', b.ffmpeg, 'fusion audio/vidéo, flux (installez ffmpeg)')}
    </ul>
    ${b.ytdlpAgeDays > 60 ? `<div class="warning-message"><i class="fas fa-triangle-exclamation"></i> yt-dlp date de ${escapeHtml(b.ytdlpAgeDays)} jours : mettez-le à jour (<code>pipx upgrade yt-dlp</code> ou <code>pip install -U yt-dlp</code>).</div>` : ''}
    <h4>Configuration</h4>
    <ul class="tool-list plain">
      <li>Version : <strong>${escapeHtml(cfg?.version || '?')}</strong></li>
      <li>Téléchargements simultanés : <strong>${escapeHtml(cfg?.maxConcurrent ?? '?')}</strong></li>
      <li>Taille max : <strong>${escapeHtml(cfg?.maxFileSize || '?')}</strong> · Nouvelles tentatives : <strong>${escapeHtml(cfg?.retryAttempts ?? '?')}</strong></li>
      <li>Domaines : <strong>${cfg?.allowedDomains?.length ? escapeHtml(cfg.allowedDomains.join(', ')) : 'tous'}</strong></li>
    </ul>
    <h4>Clé API ${cfg?.authRequired ? '(requise par ce serveur)' : '(optionnelle)'}</h4>
    <form id="apiKeyForm" class="inline-form">
      <input type="password" id="apiKeyInput" class="input-field" placeholder="Clé API (variable API_KEY du serveur)" value="${escapeHtml(getApiKey())}" autocomplete="off">
      <button type="submit" class="btn-primary"><i class="fas fa-floppy-disk"></i> Enregistrer</button>
    </form>
    <p class="muted">L'extension navigateur se règle dans ses options (adresse du serveur + clé).</p>`);
  $('apiKeyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    setApiKey($('apiKeyInput').value.trim());
    closeModal();
    toast.success('Clé enregistrée');
    live.connect();
    loadLibrary();
  });
}

// ================= CONFIG =================
async function loadConfig() {
  try {
    const cfg = await (await fetch(withKey('/config'))).json();
    state.config = cfg;
    els.footerVersion.textContent = `v${cfg.version}`;
    const warnings = [];
    const b = cfg.binaries || {};
    if (!b.ytdlp) warnings.push('yt-dlp absent : YouTube et les plateformes ne fonctionneront pas.');
    if (!b.aria2c) warnings.push('aria2c absent : téléchargements directs plus lents (via yt-dlp).');
    if (!b.ffmpeg) warnings.push('ffmpeg absent : pas de fusion audio/vidéo ni de Vimeo privé.');
    if (b.ytdlpAgeDays > 60) warnings.push(`yt-dlp date de ${b.ytdlpAgeDays} jours : mettez-le à jour (pipx upgrade yt-dlp), sinon certains sites échouent.`);
    els.serverWarning.hidden = !warnings.length;
    els.serverWarning.innerHTML = warnings.map((w) => `<div><i class="fas fa-triangle-exclamation"></i> ${escapeHtml(w)}</div>`).join('');
    if (cfg.authRequired && !cfg.authorized) openSettings('Ce serveur demande une clé API.');
  } catch (e) {
    console.error('[CONFIG]', e);
  }
}

// ================= ÉVÉNEMENTS =================
function initEvents() {
  els.form.addEventListener('submit', handleSubmit);
  els.analyzeBtn.addEventListener('click', analyzeLink);
  els.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) els.form.requestSubmit();
  });
  els.advToggle.addEventListener('click', () => {
    const open = els.advOptions.classList.toggle('show');
    els.advToggle.setAttribute('aria-expanded', String(open));
    els.advToggle.querySelector('.toggle-icon').style.transform = open ? 'rotate(180deg)' : 'rotate(0deg)';
  });

  els.activeList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id, file } = btn.dataset;
    if (action === 'cancel') cancelJob(id);
    else if (action === 'retry') retryJob(id);
    else if (action === 'dismiss') dismissJob(id);
    else if (action === 'play') openPlayer(file);
  });
  els.historyList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'play') openPlayer(btn.dataset.file);
    else if (btn.dataset.action === 'delete') deleteFile(btn.dataset.file);
  });
  els.analysisCard.addEventListener('click', onAnalysisClick);

  els.cancelAllBtn.addEventListener('click', cancelAll);
  els.clearFinishedBtn.addEventListener('click', clearFinished);
  els.clearHistoryBtn.addEventListener('click', clearLibrary);
  els.refreshHistoryBtn.addEventListener('click', () => {
    loadLibrary();
    toast.info('Bibliothèque actualisée');
  });
  els.librarySearch.addEventListener('input', () => {
    state.search = els.librarySearch.value;
    state.page = 1;
    renderLibrary();
  });
  els.prevPage.addEventListener('click', () => {
    state.page = Math.max(1, state.page - 1);
    renderLibrary();
  });
  els.nextPage.addEventListener('click', () => {
    state.page += 1;
    renderLibrary();
  });
  $('settingsBtn').addEventListener('click', () => openSettings());
  els.modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modal.hidden) closeModal();
  });
  window.addEventListener('beforeunload', () => live.close());
}

async function init() {
  els.uaInput.placeholder = navigator.userAgent;
  initEvents();
  updateCounts();
  await loadConfig();
  await loadLibrary();
  live.connect();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
