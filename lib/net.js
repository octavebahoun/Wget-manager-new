'use strict';
// Réseau : protection SSRF, fetch sûr (redirections vérifiées), en-têtes
const dns = require('dns').promises;
const net = require('net');
const config = require('./config');
const { cleanHeaderValue } = require('./util');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// ================= IP PRIVÉES =================
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), (0xffffffff << (32 - bits)) >>> 0]);

function isPrivateIp(ip) {
  const addr = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(addr)) {
    const n = ipv4ToInt(addr);
    return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (!net.isIPv6(addr)) return false;
  if (addr === '::' || addr === '::1') return true;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (dotted) return isPrivateIp(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(addr.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

function isDomainAllowed(host) {
  if (!config.ALLOWED_DOMAINS.length) return true;
  return config.ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Vérifie protocole + domaine autorisé + résolution DNS vers une IP publique
async function checkUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl).trim());
  } catch {
    return { ok: false, status: 400, error: 'URL invalide' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    return { ok: false, status: 400, error: 'Protocole non autorisé (http/https uniquement)' };
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, status: 400, error: 'URL sans domaine' };
  if (!isDomainAllowed(host)) return { ok: false, status: 403, error: `Domaine non autorisé: ${host}` };

  if (!config.ALLOW_PRIVATE_NETWORKS) {
    if (host === 'localhost' || host.endsWith('.localhost')) {
      return { ok: false, status: 403, error: 'Adresse non autorisée (localhost)' };
    }
    let addresses;
    if (net.isIP(host)) {
      addresses = [host];
    } else {
      try {
        const res = await withTimeout(dns.lookup(host, { all: true, verbatim: true }), 6000, 'DNS timeout');
        addresses = res.map((r) => r.address);
      } catch {
        return { ok: false, status: 400, error: `Domaine introuvable: ${host}` };
      }
    }
    const bad = addresses.find(isPrivateIp);
    if (bad) return { ok: false, status: 403, error: `Adresse non autorisée (réseau privé/localhost): ${bad}` };
  }
  return { ok: true, url: u.href, host };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// fetch qui re-vérifie chaque redirection (anti-SSRF)
async function safeFetch(url, { method = 'GET', headers = {}, timeout = 15000, maxRedirects = 6, signal } = {}) {
  let current = url;
  let currentMethod = method;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await checkUrl(current);
    if (!check.ok) throw httpError(check.status, check.error);
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    const res = await fetch(current, {
      method: currentMethod,
      headers,
      redirect: 'manual',
      signal: AbortSignal.any(signals),
    });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), current).href;
      res.body?.cancel().catch(() => {});
      if (res.status === 303) currentMethod = 'GET';
      current = next;
      continue;
    }
    return { res, finalUrl: current };
  }
  throw httpError(508, 'Trop de redirections');
}

// Lit au plus maxBytes du corps (et coupe la connexion ensuite)
async function readBody(res, maxBytes = 5 * 1024 * 1024) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

// En-têtes HTTP "navigateur" à partir de la config d'un job
function buildHeaders(cfg = {}) {
  const headers = {
    'User-Agent': cleanHeaderValue(cfg.ua) || DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  const referer = cfg.referer || cfg.pageUrl;
  if (referer) headers.Referer = cleanHeaderValue(referer);
  if (cfg.origin) headers.Origin = cleanHeaderValue(cfg.origin);
  if (cfg.cookies) headers.Cookie = cleanHeaderValue(cfg.cookies);
  for (const [k, v] of Object.entries(cfg.headers || {})) headers[k] = cleanHeaderValue(v);
  return headers;
}

function filenameFromDisposition(cd) {
  if (!cd) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch { /* ignore */ }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(cd);
  return plain ? (plain[1] || plain[2]).trim() : null;
}

module.exports = {
  DEFAULT_UA,
  isPrivateIp,
  isDomainAllowed,
  checkUrl,
  safeFetch,
  readBody,
  buildHeaders,
  filenameFromDisposition,
  httpError,
};
