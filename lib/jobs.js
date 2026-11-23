'use strict';
// Gestionnaire de téléchargements : file d'attente, moteurs, secours, annulation, reprise
const EventEmitter = require('events');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { log } = require('./logger');
const { binaries } = require('./tools');
const { classifyUrl, normalizeUrl, isPlatformUrl } = require('./detect');
const { buildHeaders, safeFetch, readBody } = require('./net');
const { probeUrl } = require('./probe');
const { scrapeHtml } = require('./scraper');
const { writeCookieFile, cookieHeaderFor } = require('./cookies');
const util = require('./util');
const { EngineError } = require('./engines/common');
const { runAria2 } = require('./engines/aria2');
const { runYtdlp } = require('./engines/ytdlp');
const { runFfmpeg } = require('./engines/ffmpeg');
const { runVimeo } = require('./engines/vimeo');

const ACTIVE = new Set(['queued', 'analyzing', 'downloading', 'processing', 'retrying']);
const FINAL = new Set(['completed', 'error', 'cancelled']);

const ENGINES = {
  aria2: { run: runAria2, available: () => !!binaries.aria2c, label: 'aria2c', needs: 'aria2c' },
  ytdlp: { run: runYtdlp, available: () => !!binaries.ytdlp, label: 'yt-dlp', needs: 'yt-dlp' },
  ffmpeg: { run: runFfmpeg, available: () => !!binaries.ffmpeg, label: 'ffmpeg', needs: 'ffmpeg' },
  vimeo: { run: runVimeo, available: () => !!binaries.ffmpeg, label: 'vimeo-dash', needs: 'ffmpeg' },
  scrape: { run: null, available: () => true, label: 'scraping', needs: '' },
};

// Ordre des moteurs essayés selon le type de lien
const PLANS = {
  platform: ['ytdlp'],
  hls: ['ytdlp', 'ffmpeg'],
  dash: ['ytdlp', 'ffmpeg'],
  stream: ['ytdlp', 'ffmpeg'],
  'vimeo-json': ['vimeo'],
  direct: ['aria2', 'ytdlp'],
  segment: ['aria2', 'ytdlp'],
  page: ['ytdlp', 'scrape'],
};
const STREAM_KINDS = new Set(['hls', 'dash', 'stream', 'vimeo-json']);

function nowIso() {
  return new Date().toISOString();
}

class Job {
  constructor(cfg, id) {
    this.id = id || crypto.randomUUID();
    this.config = cfg;
    this.retryCount = 0;
    this.controller = null;
    this.cancelRequested = false;
    this.lastEmit = 0;
    this.emitTimer = null;
    this.reserved = [];
    this.info = {
      id: this.id,
      url: cfg.url,
      pageUrl: cfg.pageUrl || null,
      title: cfg.title || null,
      name: cfg.customFilename || null,
      filename: null,
      files: [],
      status: 'queued',
      phase: null,
      engine: null,
      kind: null,
      quality: cfg.quality || 'best',
      progress: 0,
      speed: '',
      eta: '',
      currentSize: '0 B',
      fullSize: '???',
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      warning: null,
      retryCount: 0,
      source: cfg.source || 'web',
      createdAt: nowIso(),
      startedAt: null,
      completedAt: null,
    };
  }
}

class JobManager extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.queue = [];
    this.running = new Set();
    this.retryTimers = new Map();
    this.reservedNames = new Set();
    this.saveTimer = null;
    this.shuttingDown = false;
  }

  // ================= LECTURE =================
  list() {
    return [...this.jobs.values()]
      .map((j) => this.snapshot(j))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  counts() {
    const c = { queued: 0, running: 0, retrying: 0, completed: 0, error: 0, cancelled: 0 };
    for (const j of this.jobs.values()) {
      const s = j.info.status;
      if (s === 'queued') c.queued++;
      else if (s === 'retrying') c.retrying++;
      else if (FINAL.has(s)) c[s]++;
      else c.running++;
    }
    return c;
  }

  activeFilenames() {
    return new Set(this.reservedNames);
  }

  // ================= ACTIONS =================
  add(cfg) {
    const job = new Job(cfg);
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    log('INFO', `Nouveau téléchargement en file: ${util.truncate(cfg.url, 120)}`, { id: job.id, source: job.info.source });
    this.emitUpdate(job, true);
    this.prune();
    this.schedule();
    this.scheduleSave();
    return job;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (FINAL.has(job.info.status)) return job;
    job.cancelRequested = true;
    const qi = this.queue.indexOf(id);
    if (qi >= 0) this.queue.splice(qi, 1);
    const timer = this.retryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }
    if (job.controller) {
      job.controller.abort(new Error('Annulé'));
    } else {
      this.update(job, { status: 'cancelled', phase: null, speed: '', eta: '' }, true);
      util.removePath(path.join(config.TMP_DIR, job.id));
      this.scheduleSave();
    }
    log('INFO', `Annulation demandée: ${job.info.title || util.truncate(job.info.url, 80)}`);
    return job;
  }

  cancelAll() {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (ACTIVE.has(job.info.status)) {
        this.cancel(job.id);
        n++;
      }
    }
    return n;
  }

  retry(id) {
    const job = this.jobs.get(id);
    if (!job || !['error', 'cancelled'].includes(job.info.status)) return null;
    job.retryCount = 0;
    job.cancelRequested = false;
    this.update(job, {
      status: 'queued', progress: 0, error: null, warning: null, phase: null, speed: '', eta: '',
      retryCount: 0, files: [], filename: null, completedAt: null, engine: null,
    }, true);
    this.queue.push(id);
    this.schedule();
    this.scheduleSave();
    return job;
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (!job || !FINAL.has(job.info.status)) return false;
    this.jobs.delete(id);
    this.emit('removed', id);
    this.scheduleSave();
    return true;
  }

  clearFinished() {
    let n = 0;
    for (const [id, job] of this.jobs) {
      if (FINAL.has(job.info.status)) {
        this.jobs.delete(id);
        this.emit('removed', id);
        n++;
      }
    }
    this.scheduleSave();
    return n;
  }

  // Garde seulement les N derniers jobs terminés
  prune() {
    const finished = [...this.jobs.values()]
      .filter((j) => FINAL.has(j.info.status))
      .sort((a, b) => String(b.info.completedAt || b.info.createdAt).localeCompare(String(a.info.completedAt || a.info.createdAt)));
    for (const job of finished.slice(config.JOBS_HISTORY_LIMIT)) {
      this.jobs.delete(job.id);
      this.emit('removed', job.id);
    }
  }

  // ================= FILE D'ATTENTE =================
  schedule() {
    if (this.shuttingDown) return;
    while (this.running.size < config.MAX_CONCURRENT_DOWNLOADS && this.queue.length) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.info.status !== 'queued') continue;
      this.running.add(id);
      this.run(job)
        .catch((e) => log('ERROR', 'Erreur interne du gestionnaire', e.stack || e.message))
        .finally(() => {
          this.running.delete(id);
          this.schedule();
        });
    }
  }

  // ================= MISES À JOUR =================
  update(job, patch, force = false) {
    Object.assign(job.info, patch);
    if (patch.retryCount !== undefined) job.info.retryCount = patch.retryCount;
    this.emitUpdate(job, force);
    if (force) this.scheduleSave();
  }

  progress(job, patch) {
    const p = {};
    let force = false;
    if (patch.status && patch.status !== job.info.status) {
      p.status = patch.status;
      force = true;
    }
    if (Number.isFinite(patch.progress)) p.progress = Math.max(0, Math.min(100, Math.round(patch.progress * 10) / 10));
    if (Number.isFinite(patch.downloadedBytes)) {
      p.downloadedBytes = patch.downloadedBytes;
      p.currentSize = util.formatBytes(patch.downloadedBytes);
    }
    if (Number.isFinite(patch.totalBytes) && patch.totalBytes > 0) {
      p.totalBytes = Math.round(patch.totalBytes);
      p.fullSize = util.formatBytes(patch.totalBytes);
    }
    if (Number.isFinite(patch.speedBps)) p.speed = `${util.formatBytes(patch.speedBps)}/s`;
    if (Number.isFinite(patch.etaSec)) p.eta = util.formatDuration(patch.etaSec);
    if ('phase' in patch) p.phase = patch.phase || null;
    this.update(job, p, force);
  }

  snapshot(job) {
    return { ...job.info, queuePosition: job.info.status === 'queued' ? this.queue.indexOf(job.id) + 1 : 0 };
  }

  // Envoi temps réel limité à ~3 mises à jour/seconde par téléchargement
  emitUpdate(job, force = false) {
    const now = Date.now();
    if (force || now - job.lastEmit >= 300) {
      clearTimeout(job.emitTimer);
      job.emitTimer = null;
      job.lastEmit = now;
      this.emit('update', this.snapshot(job));
    } else if (!job.emitTimer) {
      job.emitTimer = setTimeout(() => {
        job.emitTimer = null;
        job.lastEmit = Date.now();
        if (this.jobs.has(job.id)) this.emit('update', this.snapshot(job));
      }, 300 - (now - job.lastEmit));
    }
  }

  // ================= NOMS DE FICHIERS =================
  reserve(job, base) {
    const key = base.toLowerCase();
    this.reservedNames.add(key);
    job.reserved.push(key);
  }

  releaseNames(job) {
    for (const key of job.reserved) this.reservedNames.delete(key);
    job.reserved = [];
  }

  async uniqueBase(job, base, ext, anyExt) {
    let unique = await util.uniqueBaseName(config.DOWNLOADS_DIR, base, ext, this.reservedNames, anyExt);
    while (this.reservedNames.has(unique.toLowerCase())) {
      unique = await util.uniqueBaseName(config.DOWNLOADS_DIR, base, ext, this.reservedNames, anyExt);
    }
    this.reserve(job, unique);
    return unique;
  }

  // Nom lisible : nom choisi > nom serveur > nom d'URL > titre de page > domaine+date
  baseNameFor(job, target) {
    const cfg = job.config;
    if (cfg.customFilename) {
      const b = util.sanitizeFilename(util.splitExt(cfg.customFilename).base);
      if (b) return b;
    }
    if (target.probe?.filename) {
      const b = util.sanitizeFilename(util.splitExt(target.probe.filename).base);
      if (b && !util.isGenericName(b)) return b;
    }
    let fromUrl = '';
    try {
      fromUrl = decodeURIComponent(new URL(target.url).pathname.split('/').pop() || '');
    } catch { /* ignore */ }
    const urlBase = util.sanitizeFilename(util.splitExt(fromUrl).base);
    const title = util.sanitizeFilename(cfg.title || job.info.title || '');
    const preferTitle = STREAM_KINDS.has(target.kind) || util.isGenericName(urlBase) || util.looksLikeHash(urlBase);
    if (title && (preferTitle || !urlBase)) return title;
    if (urlBase && !util.isGenericName(urlBase)) return urlBase;
    if (title) return title;
    let host = 'download';
    try {
      host = util.sanitizeFilename(new URL(target.url).hostname) || host;
    } catch { /* ignore */ }
    return `${host}_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  }

  async finalizeFile(job, target, src, ext) {
    const base = await this.uniqueBase(job, this.baseNameFor(job, target), ext, false);
    const dst = path.join(config.DOWNLOADS_DIR, ext ? `${base}.${ext}` : base);
    await util.moveFile(src, dst);
    return dst;
  }

  // ================= EXÉCUTION =================
  headersFor(job, url) {
    const h = buildHeaders(job.config);
    const jar = job.config.cookieJar || [];
    if (jar.length) {
      const c = cookieHeaderFor(url, jar);
      if (c) h.Cookie = c;
    }
    return h;
  }

  async resolveTarget(job, signal) {
    const cfg = job.config;
    let url = normalizeUrl(cfg.url);
    let { kind } = classifyUrl(url);
    const notes = [];
    if (kind === 'googlevideo') {
      const page = cfg.pageUrl || cfg.referer;
      if (page && isPlatformUrl(page)) {
        url = normalizeUrl(page);
        kind = 'platform';
        notes.push('Lien googlevideo remplacé par la page YouTube');
      } else {
        kind = 'direct';
      }
    }
    if (kind === 'unknown' && cfg.kind) kind = cfg.kind;

    let probe = null;
    if (['unknown', 'direct', 'segment'].includes(kind)) {
      this.update(job, { phase: 'Sonde du lien' });
      try {
        probe = await probeUrl(url, this.headersFor(job, url), signal);
        if (probe.ok && probe.kind && (kind === 'unknown' || probe.kind !== 'direct')) kind = probe.kind;
        if (!probe.ok) notes.push(`Sonde : HTTP ${probe.status}`);
      } catch (e) {
        if (signal.aborted) throw new EngineError('Annulé');
        if (e.status === 403 || e.status === 400) throw new EngineError(e.message);
        notes.push(`Sonde impossible (${e.message})`);
      }
    }
    if (kind === 'unknown') kind = 'page';
    if (kind === 'segment') notes.push('Lien de fragment : seul ce morceau sera récupéré');

    const maxBytes = util.parseSize(config.MAX_FILE_SIZE);
    if (maxBytes && probe?.size && probe.size > maxBytes) {
      throw new EngineError(`Fichier trop volumineux (${util.formatBytes(probe.size)} > limite ${config.MAX_FILE_SIZE})`);
    }
    if (probe?.size) {
      try {
        const st = await fsp.statfs(config.DOWNLOADS_DIR);
        const free = st.bavail * st.bsize;
        if (free < probe.size * 1.05) {
          throw new EngineError(`Espace disque insuffisant (${util.formatBytes(probe.size)} requis, ${util.formatBytes(free)} libres)`);
        }
      } catch (e) {
        if (e instanceof EngineError) throw e;
      }
    }
    this.update(job, { kind, warning: notes.join(' · ') || null, totalBytes: probe?.size || null, fullSize: probe?.size ? util.formatBytes(probe.size) : '???' });
    return { url, kind, probe, referer: null };
  }

  async makeContext(job, target, opts, engine) {
    const headers = this.headersFor(job, target.url);
    if (target.referer) headers.Referer = target.referer;
    const ctx = {
      job,
      url: target.url,
      kind: target.kind,
      probe: target.probe || null,
      headers,
      cookieFile: opts.cookieFile,
      tmpDir: opts.tmpDir,
      outDir: config.DOWNLOADS_DIR,
      signal: opts.signal,
      maxBytes: util.parseSize(config.MAX_FILE_SIZE),
      baseName: null,
      preferredExt: null,
      progress: (patch) => this.progress(job, patch),
      setTitle: (title) => {
        if (title && !job.config.title && title !== job.info.title) this.update(job, { title });
      },
      finalize: (src, ext) => this.finalizeFile(job, target, src, ext),
    };
    // Extension finale pour aria2 : nom serveur > URL > type MIME
    if (target.probe) {
      const fromName = util.splitExt(target.probe.filename || '').ext;
      ctx.preferredExt = fromName || util.extFromUrl(target.url) || target.probe.ext || util.extFromMime(target.probe.mime) || null;
    } else {
      ctx.preferredExt = util.extFromUrl(target.url) || null;
    }
    // Nom imposé à yt-dlp : nom choisi, ou titre de la page pour un flux brut
    // (les autres moteurs choisissent le nom à la fin, dans finalize)
    const wantsName = job.config.customFilename || (STREAM_KINDS.has(target.kind) && (job.config.title || job.info.title));
    if (engine === 'ytdlp' && wantsName && !job.config.playlist) {
      ctx.baseName = await this.uniqueBase(job, this.baseNameFor(job, target), '', true);
    }
    return ctx;
  }

  async execute(job, target, opts, depth = 0) {
    if (depth > 3) throw new EngineError('Trop de changements de moteur');
    const all = PLANS[target.kind] || PLANS.page;
    const plan = all.filter((name) => ENGINES[name].available());
    if (!plan.length) {
      const needs = [...new Set(all.map((n) => ENGINES[n].needs).filter(Boolean))].join(' ou ');
      throw new EngineError(`Outil manquant pour ce type de lien (${target.kind}) : installez ${needs}`);
    }
    let firstError = null;
    for (const name of plan) {
      if (opts.signal.aborted) throw new EngineError('Annulé');
      this.update(job, { engine: ENGINES[name].label, status: 'downloading', phase: `Préparation (${ENGINES[name].label})`, kind: target.kind }, true);
      try {
        if (name === 'scrape') return await this.runScrape(job, target, opts, depth);
        const ctx = await this.makeContext(job, target, opts, name);
        const { files } = await ENGINES[name].run(ctx);
        return files;
      } catch (err) {
        if (opts.signal.aborted) throw err;
        if (err.reroute && err.reroute !== target.kind) {
          log('INFO', `Changement de moteur : ${target.kind} → ${err.reroute}`, util.truncate(target.url, 100));
          return this.execute(job, { ...target, kind: err.reroute, probe: null }, opts, depth + 1);
        }
        if (!firstError) firstError = err;
        if (err.fallback && name !== plan[plan.length - 1]) {
          log('WARN', `${ENGINES[name].label} a échoué, essai du moteur suivant`, err.message);
          continue;
        }
        if (firstError !== err) {
          // "Unsupported URL" de yt-dlp n'apporte rien : on garde l'erreur du secours
          const message = /Unsupported URL|Unable to extract/i.test(firstError.message)
            ? err.message
            : `${firstError.message} (secours ${ENGINES[name].label} : ${err.message})`;
          throw new EngineError(message, { retryable: firstError.retryable || err.retryable });
        }
        throw err;
      }
    }
    throw firstError || new EngineError('Échec du téléchargement');
  }

  // Secours "page" : on cherche le meilleur média dans le HTML puis on le télécharge
  async runScrape(job, target, opts, depth) {
    this.update(job, { phase: 'Recherche de médias dans la page' });
    const headers = { ...this.headersFor(job, target.url), Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
    const { res, finalUrl } = await safeFetch(target.url, { headers, timeout: 20000, signal: opts.signal });
    if (!res.ok) throw new EngineError(`La page répond HTTP ${res.status}`, { retryable: res.status >= 500 });
    const html = (await readBody(res, 6 * 1024 * 1024)).toString('utf8');
    const { candidates, title } = scrapeHtml(html, finalUrl);
    if (title && !job.config.title && !job.info.title) this.update(job, { title });
    const best = candidates[0];
    if (!best) {
      throw new EngineError('Aucune vidéo trouvée sur cette page. Ouvrez-la dans le navigateur et utilisez l\'extension.');
    }
    log('INFO', `Scraping : ${candidates.length} média(s) trouvé(s), choix : ${util.truncate(best.url, 100)}`);
    this.update(job, {
      phase: `Média trouvé (${best.kind})`,
      warning: candidates.length > 1 ? `${candidates.length} médias trouvés : le meilleur a été choisi (bouton Analyser pour choisir)` : null,
    });
    const sub = { url: best.url, kind: best.kind, referer: finalUrl, probe: null };
    if (sub.kind === 'direct') {
      try {
        sub.probe = await probeUrl(sub.url, { ...this.headersFor(job, sub.url), Referer: finalUrl }, opts.signal);
        if (sub.probe.ok && sub.probe.kind && sub.probe.kind !== 'direct' && sub.probe.kind !== 'page') sub.kind = sub.probe.kind;
      } catch { /* on tente quand même */ }
    }
    return this.execute(job, sub, opts, depth + 1);
  }

  async run(job) {
    const controller = new AbortController();
    job.controller = controller;
    job.cancelRequested = false;
    let timedOut = false;
    const timer = config.DOWNLOAD_TIMEOUT > 0
      ? setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Délai dépassé'));
      }, config.DOWNLOAD_TIMEOUT * 1000)
      : null;
    const tmpDir = path.join(config.TMP_DIR, job.id);
    let keepTmp = false;
    this.update(job, { status: 'analyzing', phase: 'Analyse du lien', startedAt: job.info.startedAt || nowIso(), error: null }, true);
    log('INFO', `Démarrage: ${util.truncate(job.config.url, 120)}${job.retryCount ? ` (tentative ${job.retryCount + 1})` : ''}`);

    try {
      await util.ensureDir(tmpDir);
      const jar = job.config.cookieJar || [];
      const cookieFile = jar.length ? await writeCookieFile(tmpDir, jar) : null;
      const target = await this.resolveTarget(job, controller.signal);
      const files = await this.execute(job, target, { tmpDir, cookieFile, signal: controller.signal });
      const rel = files.map((f) => path.relative(config.DOWNLOADS_DIR, f).split(path.sep).join('/'));
      let total = 0;
      for (const f of files) {
        try {
          total += (await fsp.stat(f)).size;
        } catch { /* ignore */ }
      }
      this.update(job, {
        status: 'completed', progress: 100, phase: null, files: rel, filename: rel[0], error: null,
        fullSize: util.formatBytes(total), currentSize: util.formatBytes(total), totalBytes: total,
        downloadedBytes: total, speed: '', eta: '', completedAt: nowIso(),
      }, true);
      job.config.cookieJar = undefined;
      job.config.cookies = undefined;
      log('SUCCESS', `Téléchargement terminé: ${rel.join(', ')}`, { size: util.formatBytes(total), engine: job.info.engine });
      this.emit('library-changed');
    } catch (err) {
      if (this.shuttingDown) {
        keepTmp = true;
        this.update(job, { status: 'queued', phase: 'Reprise au prochain démarrage', speed: '', eta: '' }, true);
      } else if (job.cancelRequested) {
        this.update(job, { status: 'cancelled', phase: null, speed: '', eta: '', completedAt: nowIso() }, true);
        log('INFO', `Téléchargement annulé: ${job.info.title || util.truncate(job.info.url, 80)}`);
      } else if (timedOut) {
        this.update(job, { status: 'error', error: `Délai maximum dépassé (${util.formatDuration(config.DOWNLOAD_TIMEOUT)})`, phase: null, speed: '', eta: '', completedAt: nowIso() }, true);
      } else if (err.retryable && job.retryCount < config.RETRY_ATTEMPTS) {
        job.retryCount++;
        keepTmp = true;
        const delay = config.RETRY_DELAY * job.retryCount;
        this.update(job, {
          status: 'retrying', error: err.message, retryCount: job.retryCount, speed: '', eta: '',
          phase: `Nouvelle tentative ${job.retryCount}/${config.RETRY_ATTEMPTS} dans ${Math.round(delay / 1000)}s`,
        }, true);
        log('WARN', `Erreur passagère, nouvelle tentative ${job.retryCount}/${config.RETRY_ATTEMPTS}`, err.message);
        const t = setTimeout(() => {
          this.retryTimers.delete(job.id);
          if (job.info.status !== 'retrying') return;
          job.info.status = 'queued';
          this.queue.unshift(job.id);
          this.emitUpdate(job, true);
          this.schedule();
        }, delay);
        this.retryTimers.set(job.id, t);
      } else {
        this.update(job, { status: 'error', error: err.message || String(err), phase: null, speed: '', eta: '', completedAt: nowIso() }, true);
        log('ERROR', `Téléchargement échoué: ${util.truncate(job.info.url, 100)}`, { error: err.message, engine: job.info.engine });
      }
    } finally {
      clearTimeout(timer);
      job.controller = null;
      this.releaseNames(job);
      if (!keepTmp) await util.removePath(tmpDir);
      this.prune();
      this.scheduleSave();
    }
  }

  // ================= PERSISTANCE =================
  serialize() {
    return {
      version: 2,
      savedAt: nowIso(),
      jobs: [...this.jobs.values()].map((j) => {
        const cfg = { ...j.config };
        if (FINAL.has(j.info.status)) {
          delete cfg.cookieJar;
          delete cfg.cookies;
          delete cfg.headers;
        }
        return { info: j.info, config: cfg, retryCount: j.retryCount };
      }),
    };
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 1000);
  }

  async save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const tmp = `${config.STATE_FILE}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(this.serialize(), null, 2), { mode: 0o600 });
      await fsp.rename(tmp, config.STATE_FILE);
    } catch (e) {
      log('ERROR', 'Erreur sauvegarde état', e.message);
    }
  }

  async load() {
    let data;
    try {
      data = JSON.parse(await fsp.readFile(config.STATE_FILE, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') log('WARN', 'Fichier d\'état illisible, ignoré', e.message);
      return;
    }
    const entries = Array.isArray(data) ? data : data.jobs || [];
    let resumed = 0;
    for (const entry of entries) {
      const info = entry.info || entry;
      if (!info?.id || !info.url) continue;
      const cfg = entry.config && entry.config.url ? entry.config : { url: info.url, customFilename: null };
      const job = new Job(cfg, info.id);
      Object.assign(job.info, info, { id: info.id });
      job.info.files = Array.isArray(info.files) ? info.files : info.filename && info.status === 'completed' ? [info.filename] : [];
      job.retryCount = entry.retryCount || 0;
      if (ACTIVE.has(info.status)) {
        Object.assign(job.info, { status: 'queued', progress: 0, speed: '', eta: '', phase: 'Reprise après redémarrage', error: null });
        this.queue.push(job.id);
        resumed++;
      } else if (!FINAL.has(info.status)) {
        job.info.status = 'error';
        job.info.error = job.info.error || 'Interrompu';
      }
      this.jobs.set(job.id, job);
    }
    this.prune();
    log('INFO', `État restauré : ${this.jobs.size} téléchargement(s), ${resumed} à reprendre`);
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    for (const id of this.running) this.jobs.get(id)?.controller?.abort(new Error('Arrêt du serveur'));
    const deadline = Date.now() + 7000;
    while (this.running.size && Date.now() < deadline) await util.sleep(100);
    await this.save();
  }
}

module.exports = { JobManager, ACTIVE, FINAL, PLANS };
