'use strict';
// Cookies : fichier Netscape (yt-dlp / aria2c) et en-tête Cookie filtré par URL
const fsp = require('fs').promises;
const path = require('path');

const MAX_COOKIES = 800;

function clean(v, max = 8192) {
  return String(v ?? '').replace(/[\t\r\n]/g, '').slice(0, max);
}

// Valide le tableau de cookies envoyé par l'extension (format chrome.cookies)
function normalizeCookieJar(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const c of input.slice(0, MAX_COOKIES)) {
    if (!c || typeof c !== 'object' || !c.name || !c.domain) continue;
    out.push({
      domain: clean(c.domain, 255).toLowerCase(),
      hostOnly: c.hostOnly === true || (c.hostOnly === undefined && !String(c.domain).startsWith('.')),
      path: clean(c.path || '/', 1024) || '/',
      secure: !!c.secure,
      expirationDate: Number(c.expirationDate) > 0 ? Math.floor(Number(c.expirationDate)) : 0,
      name: clean(c.name, 1024),
      value: clean(c.value),
    });
  }
  return out;
}

function toNetscape(jar) {
  const lines = ['# Netscape HTTP Cookie File', '# Généré par Web Wget Pro', ''];
  for (const c of jar) {
    const domain = c.hostOnly ? c.domain.replace(/^\./, '') : `.${c.domain.replace(/^\./, '')}`;
    lines.push([domain, c.hostOnly ? 'FALSE' : 'TRUE', c.path, c.secure ? 'TRUE' : 'FALSE', String(c.expirationDate || 0), c.name, c.value].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

async function writeCookieFile(dir, jar) {
  const file = path.join(dir, 'cookies.txt');
  await fsp.writeFile(file, toNetscape(jar), { mode: 0o600 });
  return file;
}

// En-tête "Cookie" que le navigateur enverrait pour cette URL
function cookieHeaderFor(url, jar) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase();
  const now = Date.now() / 1000;
  return jar
    .filter((c) => {
      const d = c.domain.replace(/^\./, '');
      const domainOk = c.hostOnly ? host === d : host === d || host.endsWith(`.${d}`);
      const pathOk = u.pathname.startsWith(c.path || '/');
      const secureOk = !c.secure || u.protocol === 'https:';
      const alive = !c.expirationDate || c.expirationDate > now;
      return domainOk && pathOk && secureOk && alive;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

module.exports = { normalizeCookieJar, toNetscape, writeCookieFile, cookieHeaderFor };
