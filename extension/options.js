// options.js — réglages de l'extension
import { DEFAULT_SETTINGS, getSettings, normalizeServerUrl } from './common.js';

const $ = (id) => document.getElementById(id);
const CHECKS = ['sendCookies', 'autoFetch', 'notifications', 'autoClose'];

function readForm() {
  const out = {
    serverUrl: normalizeServerUrl($('serverUrl').value),
    apiKey: $('apiKey').value.trim(),
    defaultQuality: $('defaultQuality').value,
  };
  for (const key of CHECKS) out[key] = $(key).checked;
  return out;
}

async function load() {
  const s = await getSettings();
  $('serverUrl').value = s.serverUrl;
  $('apiKey').value = s.apiKey;
  $('defaultQuality').value = s.defaultQuality;
  for (const key of CHECKS) $(key).checked = !!s[key];
}

async function save() {
  const values = readForm();
  await chrome.storage.sync.set(values);
  $('serverUrl').value = values.serverUrl;
  $('saved').textContent = '✓ Enregistré';
  setTimeout(() => { $('saved').textContent = ''; }, 2500);
}

async function test() {
  const { serverUrl, apiKey } = readForm();
  const result = $('result');
  result.className = '';
  result.textContent = 'Test en cours…';
  try {
    const health = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    const headers = apiKey ? { 'X-API-Key': apiKey } : {};
    const jobs = await fetch(`${serverUrl}/api/jobs`, { headers, signal: AbortSignal.timeout(5000) });
    if (jobs.status === 401) throw new Error('le serveur refuse la clé API');
    const b = health.binaries || {};
    const missing = ['aria2c', 'ytdlp', 'ffmpeg'].filter((k) => !b[k]).map((k) => (k === 'ytdlp' ? 'yt-dlp' : k));
    result.className = 'ok';
    result.textContent = `✓ Connecté à Web Wget ${health.version || ''}${missing.length ? ` — outils manquants : ${missing.join(', ')}` : ''}`;
  } catch (e) {
    result.className = 'ko';
    result.textContent = `✗ Échec : ${e.message === 'Failed to fetch' ? 'serveur injoignable' : e.message}`;
  }
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') save();
});
load().catch(() => {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if ($(k)) $(k)[typeof v === 'boolean' ? 'checked' : 'value'] = v;
});
