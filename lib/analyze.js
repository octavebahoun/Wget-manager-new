'use strict';
// Analyse d'un lien SANS télécharger : type, titre, qualités, médias trouvés dans la page
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { classifyUrl, normalizeUrl } = require('./detect');
const { checkUrl, safeFetch, readBody, buildHeaders, httpError } = require('./net');
const { probeUrl } = require('./probe');
const { scrapeHtml, parseHls } = require('./scraper');
const { ytdlpInfo } = require('./engines/ytdlp');
const { fetchManifest, summarizeManifest } = require('./engines/vimeo');
const { normalizeCookieJar, cookieHeaderFor, writeCookieFile } = require('./cookies');
const { binaries } = require('./tools');
const { ensureDir, removePath } = require('./util');

const ENGINE_LABEL = {
  platform: 'yt-dlp',
  hls: 'yt-dlp (secours ffmpeg)',
  dash: 'yt-dlp (secours ffmpeg)',
  stream: 'yt-dlp',
  'vimeo-json': 'Vimeo DASH',
  direct: 'aria2c',
  segment: 'aria2c',
  page: 'yt-dlp + scraping',
};

function applyInfo(result, info) {
  if (!info) return;
  result.title = info.title || result.title;
  result.thumbnail = info.thumbnail || result.thumbnail;
  result.duration = info.duration || result.duration;
  result.extractor = info.extractor || null;
  result.uploader = info.uploader || null;
  result.isLive = !!info.isLive;
  if (info.drm) {
    result.drm = true;
    result.warnings.push('Contenu protégé par DRM : téléchargement impossible.');
  }
  if (info.isPlaylist) {
    result.isPlaylist = true;
    result.count = info.count;
    result.candidates = info.entries.map((e, i) => ({
      url: e.url,
      kind: 'platform',
      label: e.title || `Élément ${i + 1}`,
      source: 'playlist',
      duration: e.duration,
      score: 100 - i,
    }));
  } else if (info.formats?.length) {
    result.formats = info.formats;
  }
}

async function analyze(input) {
  const url = normalizeUrl(input.url);
  const check = await checkUrl(url);
  if (!check.ok) throw httpError(check.status, check.error);

  const jar = normalizeCookieJar(input.cookieJar);
  const baseHeaders = buildHeaders(input);
  const headersFor = (u) => {
    const h = { ...baseHeaders };
    const c = jar.length ? cookieHeaderFor(u, jar) : '';
    if (c) h.Cookie = c;
    return h;
  };

  const result = {
    url,
    kind: null,
    engine: null,
    title: input.title || null,
    thumbnail: null,
    duration: null,
    size: null,
    mime: null,
    filename: null,
    formats: [],
    candidates: [],
    warnings: [],
    isPlaylist: false,
    drm: false,
  };

  let { kind } = classifyUrl(url);
  if (kind === 'googlevideo') {
    result.warnings.push('Lien interne YouTube (googlevideo) : utilisez plutôt l\'adresse de la page YouTube.');
    kind = 'direct';
  }
  if (kind === 'segment') {
    result.warnings.push('Ce lien est un fragment de flux, pas la vidéo complète. Utilisez le .m3u8/.mpd ou la page.');
  }

  if (['unknown', 'direct', 'segment'].includes(kind)) {
    try {
      const probe = await probeUrl(url, headersFor(url));
      result.size = probe.size;
      result.mime = probe.mime;
      result.filename = probe.filename;
      if (!probe.ok) result.warnings.push(`Le serveur répond HTTP ${probe.status}`);
      else if (probe.kind && (kind === 'unknown' || probe.kind !== 'direct')) kind = probe.kind;
    } catch (e) {
      result.warnings.push(`Sonde impossible : ${e.message}`);
    }
  }
  if (kind === 'unknown') kind = 'page';
  result.kind = kind;
  result.engine = ENGINE_LABEL[kind] || kind;

  const tmp = jar.length ? path.join(config.TMP_DIR, `analyze-${crypto.randomUUID()}`) : null;
  try {
    let cookieFile = null;
    if (tmp) {
      await ensureDir(tmp);
      cookieFile = await writeCookieFile(tmp, jar);
    }
    const ytOpts = { headers: baseHeaders, cookieFile, noCheckCert: !!input.noCheckCert, playlist: !!input.playlist };

    if (kind === 'platform' || kind === 'dash' || kind === 'stream') {
      applyInfo(result, await ytdlpInfo(url, ytOpts));
    } else if (kind === 'hls') {
      const { res, finalUrl } = await safeFetch(url, { headers: headersFor(url) });
      if (!res.ok) {
        result.warnings.push(`Playlist inaccessible (HTTP ${res.status})`);
      } else {
        const pl = parseHls((await readBody(res, 5 * 1024 * 1024)).toString('utf8'), finalUrl);
        if (!pl) {
          result.warnings.push('Playlist HLS illisible');
        } else {
          result.drm = pl.drm;
          if (pl.drm) result.warnings.push('Flux protégé par DRM : téléchargement impossible.');
          if (pl.isLive) result.warnings.push('Flux en direct : l\'enregistrement continue jusqu\'à l\'arrêt (ou le délai max).');
          result.duration = pl.duration || null;
          if (pl.isMaster) {
            const heights = [...new Set(pl.variants.map((v) => v.height).filter(Boolean))];
            result.formats = heights.map((h) => ({ id: String(h), label: `${h}p`, height: h }));
            result.formats.push({ id: 'audio', label: 'Audio MP3', audio: true });
            const best = pl.variants.find((v) => v.url);
            if (best) {
              try {
                const sub = await safeFetch(best.url, { headers: headersFor(best.url) });
                const media = parseHls((await readBody(sub.res, 5 * 1024 * 1024)).toString('utf8'), sub.finalUrl);
                if (media?.duration) result.duration = media.duration;
              } catch { /* durée inconnue */ }
            }
          }
        }
      }
    } else if (kind === 'vimeo-json') {
      const { manifest } = await fetchManifest(url, headersFor(url));
      Object.assign(result, summarizeManifest(manifest));
    } else if (kind === 'page') {
      const [page, info] = await Promise.allSettled([
        (async () => {
          const { res, finalUrl } = await safeFetch(url, {
            headers: { ...headersFor(url), Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
            timeout: 20000,
          });
          const html = (await readBody(res, 6 * 1024 * 1024)).toString('utf8');
          return { ...scrapeHtml(html, finalUrl), status: res.status };
        })(),
        binaries.ytdlp ? ytdlpInfo(url, ytOpts) : Promise.reject(new Error('yt-dlp non installé')),
      ]);
      if (info.status === 'fulfilled') {
        applyInfo(result, info.value);
        result.engine = 'yt-dlp';
      }
      if (page.status === 'fulfilled') {
        const p = page.value;
        if (!result.isPlaylist) result.candidates = p.candidates;
        result.title = result.title || p.title;
        result.thumbnail = result.thumbnail || p.thumbnail;
        if (p.status >= 400) result.warnings.push(`La page répond HTTP ${p.status} (connexion requise ?)`);
      } else {
        result.warnings.push(`Page illisible : ${page.reason.message}`);
      }
      if (info.status === 'rejected') {
        result.engine = result.candidates.length ? 'scraping' : result.engine;
        if (!result.candidates.length) result.warnings.push(`yt-dlp : ${info.reason.message}`);
      }
    }
  } catch (e) {
    result.warnings.push(e.message);
  } finally {
    if (tmp) await removePath(tmp);
  }
  return result;
}

module.exports = { analyze };
