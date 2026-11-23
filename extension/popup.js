// popup.js — fenêtre de l'extension : liste des médias, envoi au serveur, suivi
import { getSettings, classifyMedia, displayName, hostOf, formatBytes, KIND_LABELS, VERSION } from './common.js';

const ICONS = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

// Ces types ont besoin du serveur (assemblage de flux / extraction)
const SERVER_ONLY = new Set(['hls', 'dash', 'vimeo-json', 'platform', 'page']);
const JOB_LABELS = {
  queued: 'En file', analyzing: 'Analyse', downloading: 'En cours', processing: 'Finalisation',
  retrying: 'Nouvel essai', completed: 'Terminé', error: 'Échec', cancelled: 'Annulé',
};

const $ = (id) => document.getElementById(id);
const state = { tab: null, items: [], selectedUrl: null, urlEdited: false, settings: null, jobsTimer: null };

// ================= OUTILS =================
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'icon') node.innerHTML = ICONS[v] || '';
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

function send(message) {
  return chrome.runtime.sendMessage(message).then((res) => {
    if (res && res.error) throw new Error(res.error);
    return res;
  });
}

let statusTimer = null;
function showStatus(text, type = 'info', duration = 0) {
  const s = $('status');
  s.textContent = text;
  s.className = `status visible ${type}`;
  clearTimeout(statusTimer);
  if (duration) statusTimer = setTimeout(() => s.classList.remove('visible'), duration);
}

function setBusy(busy) {
  for (const id of ['send', 'local', 'rescan']) $(id).disabled = busy;
}

// ================= SERVEUR =================
async function checkServer() {
  const pill = $('serverPill');
  const text = $('serverText');
  const res = await send({ type: 'SERVER_STATUS' }).catch((e) => ({ ok: false, error: e.message }));
  pill.classList.toggle('ok', !!res.ok);
  pill.classList.toggle('ko', !res.ok);
  if (res.ok) {
    const active = (res.jobs?.running || 0) + (res.jobs?.queued || 0);
    text.textContent = active ? `${active} en cours` : 'Serveur prêt';
    pill.title = `Web Wget ${res.version || ''} — ${state.settings.serverUrl}`;
    const b = res.binaries || {};
    if (!b.ytdlp) addBanner('warn', 'yt-dlp n\'est pas installé sur le serveur : les plateformes (YouTube…) ne marcheront pas.');
    else if (b.ytdlpAgeDays > 60) addBanner('warn', `yt-dlp du serveur date de ${b.ytdlpAgeDays} jours : mettez-le à jour (pipx upgrade yt-dlp).`);
  } else {
    text.textContent = 'Hors ligne';
    pill.title = res.error || 'Serveur injoignable';
    addBanner('error', `Serveur injoignable (${state.settings.serverUrl}). Lancez « npm start » ou réglez l'adresse dans les options.`);
  }
  return res.ok;
}

function addBanner(type, text) {
  $('banners').append(el('div', { class: `banner ${type}`, text }));
}

// ================= LISTE DES MÉDIAS =================
function itemMeta(item) {
  const parts = [];
  if (item.isPage) parts.push('lien de la page');
  if (item.height) parts.push(`${item.height}p`);
  if (item.duration) parts.push(`${Math.floor(item.duration / 60)}:${String(item.duration % 60).padStart(2, '0')}`);
  if (item.size) parts.push(formatBytes(item.size));
  if (item.source && !item.isPage) parts.push(item.source);
  parts.push(hostOf(item.url));
  return parts.filter(Boolean).join(' · ');
}

function badgeText(item) {
  if (item.isPage) return 'PAGE';
  const fixed = { platform: 'LECTEUR', 'vimeo-json': 'VIMEO', hls: 'HLS', dash: 'DASH' }[item.kind];
  if (fixed) return fixed;
  return String(item.typeLabel || KIND_LABELS[item.kind] || item.kind).toUpperCase().slice(0, 6);
}

function selectItem(item) {
  state.selectedUrl = item.url;
  state.urlEdited = false;
  $('url').value = item.url;
  for (const node of $('list').children) node.classList.toggle('selected', node.dataset.url === item.url);
  $('local').disabled = SERVER_ONLY.has(item.kind);
}

function renderItems() {
  const list = $('list');
  list.replaceChildren();
  const items = state.items;
  $('listTitle').textContent = items.length ? `Médias détectés (${items.length})` : 'Médias détectés';
  const sendable = items.filter((i) => i.kind !== 'file');
  $('sendAll').hidden = sendable.length < 2;
  $('sendAll').textContent = `Tout envoyer (${sendable.length})`;

  if (!items.length) {
    list.append(el('div', { class: 'empty', text: 'Rien de détecté pour l\'instant. Lancez la lecture de la vidéo puis cliquez sur ↻.' }));
    return;
  }
  for (const item of items) {
    const name = item.isPage ? (state.tab.title || displayName(item.url)) : (item.label || displayName(item.url));
    const row = el('div', { class: 'item', 'data-url': item.url, title: item.url, onclick: () => selectItem(item) },
      el('span', { class: `badge k-${item.kind}`, text: badgeText(item) }),
      el('div', { class: 'item-main' },
        el('div', { class: 'item-name', text: name }),
        el('div', { class: 'item-meta', text: itemMeta(item) })),
      el('div', { class: 'item-actions' },
        el('button', { title: 'Envoyer au serveur', icon: 'up', onclick: (e) => { e.stopPropagation(); sendItems([item]); } }),
        el('button', {
          title: SERVER_ONLY.has(item.kind) ? 'Ce type passe par le serveur' : 'Télécharger sur ce PC',
          icon: 'down',
          disabled: SERVER_ONLY.has(item.kind),
          onclick: (e) => { e.stopPropagation(); downloadLocal(item); },
        }),
        el('button', { title: 'Copier le lien', icon: 'copy', onclick: (e) => { e.stopPropagation(); copyUrl(item.url); } })));
    list.append(row);
  }
}

function renderFlags(flags) {
  if (flags.drm) addBanner('error', 'DRM détecté : la vidéo protégée ne pourra pas être téléchargée (les autres médias, oui).');
  else if (flags.mse && !state.items.some((i) => ['hls', 'dash', 'vimeo-json', 'platform'].includes(i.kind))) {
    addBanner('info', 'Lecteur en « blob: » : lancez la lecture puis ↻ pour capter le flux HLS/DASH.');
  }
}

async function scan() {
  setBusy(true);
  try {
    const res = await send({ type: 'GET_MEDIA', tabId: state.tab.id });
    state.items = res.items || [];
    renderItems();
    renderFlags(res.flags || {});
    const best = state.items.find((i) => i.kind !== 'file') || state.items[0];
    if (best && !state.urlEdited && (!$('url').value || $('url').value === state.selectedUrl)) selectItem(best);
    else if (!best && !$('url').value && /^https?:/i.test(state.tab.url || '')) $('url').value = state.tab.url;
  } catch (e) {
    $('list').replaceChildren(el('div', { class: 'empty', text: `Analyse impossible : ${e.message}` }));
  } finally {
    setBusy(false);
  }
}

// ================= ACTIONS =================
function currentItem() {
  const url = $('url').value.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const known = state.items.find((i) => i.url === url);
  if (known) return known;
  return { url, kind: classifyMedia(url)?.kind || 'page', referer: state.tab.url };
}

async function sendItems(items) {
  if (!items.length) return;
  setBusy(true);
  showStatus(items.length > 1 ? `Envoi de ${items.length} médias…` : 'Envoi au serveur…', 'info');
  try {
    const filename = $('filename').value.trim();
    const res = await send({ type: 'SEND', tabId: state.tab.id, items, options: { quality: $('quality').value, filename } });
    if (res.ok) {
      const extra = res.errors.length ? ` (${res.errors.length} refusé(s) : ${res.errors[0]})` : '';
      showStatus(`✓ ${res.jobs.length} téléchargement(s) lancé(s) sur le serveur${extra}`, res.errors.length ? 'warning' : 'success', 6000);
      $('filename').value = '';
      loadJobs();
      if (state.settings.autoClose && !res.errors.length) setTimeout(() => window.close(), 1200);
    } else {
      showStatus(`✗ ${res.errors[0] || 'Échec de l\'envoi'}`, 'error');
    }
  } catch (e) {
    showStatus(`✗ ${e.message}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function downloadLocal(item) {
  if (SERVER_ONLY.has(item.kind)) {
    showStatus('Ce média est un flux ou une page : utilisez « Envoyer au serveur ».', 'warning', 5000);
    return;
  }
  try {
    await send({ type: 'DOWNLOAD_LOCAL', url: item.url, filename: $('filename').value.trim() || undefined });
    showStatus('✓ Téléchargement lancé dans le navigateur', 'success', 4000);
  } catch (e) {
    showStatus(`✗ ${e.message}`, 'error');
  }
}

async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
    showStatus('Lien copié', 'info', 2000);
  } catch {
    showStatus('Copie impossible', 'error', 3000);
  }
}

// ================= SUIVI DES TÉLÉCHARGEMENTS SERVEUR =================
function renderJobs(jobs) {
  const box = $('jobs');
  box.replaceChildren();
  $('jobsBlock').hidden = !jobs.length;
  for (const job of jobs) {
    const name = (job.files?.[0] || '').split('/').pop() || job.name || job.title || displayName(job.url);
    const active = ['queued', 'analyzing', 'downloading', 'processing', 'retrying'].includes(job.status);
    const pct = Math.round(job.progress || 0);
    const label = job.status === 'downloading' && pct ? `${pct}%` : JOB_LABELS[job.status] || job.status;
    const actions = [];
    if (job.status === 'completed' && job.files?.length) {
      actions.push(el('button', {
        title: 'Récupérer sur ce PC',
        icon: 'down',
        onclick: () => send({ type: 'DOWNLOAD_FROM_SERVER', file: job.files[0] })
          .then(() => showStatus('✓ Récupération lancée', 'success', 3000))
          .catch((e) => showStatus(`✗ ${e.message}`, 'error')),
      }));
    }
    if (active) {
      actions.push(el('button', {
        title: 'Annuler',
        icon: 'x',
        onclick: () => send({ type: 'CANCEL_JOB', id: job.id }).then(loadJobs).catch((e) => showStatus(`✗ ${e.message}`, 'error')),
      }));
    }
    const meta = job.status === 'error'
      ? el('div', { class: 'job-meta err', text: job.error || 'Erreur' })
      : el('div', { class: 'job-meta', text: [job.phase, job.speed, job.eta && `reste ${job.eta}`, job.engine].filter(Boolean).join(' · ') || (job.fullSize !== '???' ? job.fullSize : '') });
    box.append(el('div', { class: 'job' },
      el('div', { class: 'job-line' },
        el('span', { class: 'job-name', text: name, title: job.url }),
        el('span', { class: `job-status s-${job.status}`, text: label }),
        ...actions),
      active && job.status !== 'queued' ? el('div', { class: 'bar' }, el('div', { style: `width:${Math.max(3, pct)}%` })) : null,
      meta));
  }
}

async function loadJobs() {
  try {
    const res = await send({ type: 'JOBS' });
    renderJobs(res.jobs || []);
  } catch {
    $('jobsBlock').hidden = true;
  }
}

// ================= INITIALISATION =================
async function init() {
  document.querySelectorAll('[data-icon]').forEach((node) => { node.innerHTML = ICONS[node.dataset.icon] || ''; });
  $('version').textContent = `v${VERSION}`;
  state.settings = await getSettings();
  $('quality').value = state.settings.defaultQuality || 'best';

  // popup.html?tabId=123 : ouvre la fenêtre pour un onglet précis (mode détaché / tests)
  const forcedId = Number(new URLSearchParams(location.search).get('tabId'));
  const tab = forcedId
    ? await chrome.tabs.get(forcedId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  state.tab = tab || { id: -1, url: '', title: '' };
  $('pageTitle').textContent = state.tab.title || 'Onglet';
  $('pageHost').textContent = hostOf(state.tab.url) || state.tab.url || '';
  if (state.tab.favIconUrl && /^https?:|^data:/.test(state.tab.favIconUrl)) $('favicon').src = state.tab.favIconUrl;
  else $('favicon').style.visibility = 'hidden';

  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openDashboard').addEventListener('click', () => chrome.tabs.create({ url: state.settings.serverUrl }));
  $('rescan').addEventListener('click', () => {
    $('banners').replaceChildren();
    checkServer();
    scan();
  });
  $('send').addEventListener('click', () => {
    const item = currentItem();
    if (!item) {
      showStatus('Entrez un lien http(s) valide', 'warning', 4000);
      $('url').focus();
      return;
    }
    sendItems([item]);
  });
  $('local').addEventListener('click', () => {
    const item = currentItem();
    if (item) downloadLocal(item);
    else showStatus('Entrez un lien http(s) valide', 'warning', 4000);
  });
  $('sendAll').addEventListener('click', () => sendItems(state.items.filter((i) => i.kind !== 'file')));
  $('url').addEventListener('input', () => {
    state.urlEdited = true;
    const kind = classifyMedia($('url').value.trim())?.kind || 'page';
    $('local').disabled = SERVER_ONLY.has(kind);
    for (const node of $('list').children) node.classList.remove('selected');
  });
  $('url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('send').click();
  });

  if (state.tab.id < 0 || !/^https?:/i.test(state.tab.url || '')) {
    $('list').replaceChildren(el('div', { class: 'empty', text: 'Ouvrez une page web pour détecter ses médias (ou collez un lien ci-dessous).' }));
    checkServer().then((ok) => ok && loadJobs());
    return;
  }
  const serverOk = checkServer();
  await scan();
  if (await serverOk) {
    loadJobs();
    state.jobsTimer = setInterval(loadJobs, 2000);
  }
}

init().catch((e) => showStatus(`Erreur : ${e.message}`, 'error'));
