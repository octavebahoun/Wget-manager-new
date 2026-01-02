// inject.js - Script injecté dans la page (MAIN WORLD)
// ================= CONSTANTS =================
(function () {
    const SCRIPT_VERSION = '3.0.0';
    const DEBUG_MODE = false;

    // Extensions vidéo/audio supportées
    const MEDIA_EXTENSIONS = {
        VIDEO: /\.(mp4|webm|mkv|flv|mov|avi|wmv|m4v|3gp|ogv)$/i,
        AUDIO: /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i,
        STREAM: /\.(m3u8|mpd|ts|m4s|f4m|ism|m3u|dash)$/i
    };

    // MIME types vidéo/audio
    const MEDIA_MIMES = {
        VIDEO: ['video/', 'application/x-mpegURL', 'application/dash+xml', 'application/vnd.apple.mpegurl'],
        AUDIO: ['audio/']
    };

    // Mots-clés indiquant du contenu vidéo
    const VIDEO_KEYWORDS = [
        'videoplayback',
        'manifest',
        'playlist',
        'master.json',
        'stream',
        'chunk',
        'segment',
        'googlevideo.com',
        'cdn',
        '/hls/',
        '/dash/',
        'mime=video',
        'mime=audio'
    ];

    // Patterns à exclure (publicités, analytics, trackers)
    const EXCLUDE_PATTERNS = [
        // Analytics & Tracking
        /google-analytics|googletagmanager|gtag|analytics/i,
        /facebook\.com\/tr|fbevents|pixel/i,
        /doubleclick|googleadservices|googlesyndication/i,

        // Ads
        /\/ad\/|\/ads\/|\/advert/i,
        /adserver|adsystem|adservice/i,

        // Tracking & Metrics
        /ptracking|tracking|tracker/i,
        /stats|metrics|telemetry/i,
        /log_event|logging|beacon/i,

        // Social & Other
        /twitter\.com\/i\/jot/i,
        /\/ping|\/pong|\/heartbeat/i,
        /\.gif\?|\.png\?.*track/i
    ];

    // Domaines de CDN vidéo connus
    const VIDEO_CDN_DOMAINS = [
        'googlevideo.com',
        'cloudfront.net',
        'akamaihd.net',
        'cdn.jwplayer.com',
        'vimeocdn.com',
        'twitch.tv',
        'dailymotion.com'
    ];

    // Message types
    const MESSAGE_TYPES = {
        DETECTED: 'WGET_PRO_DETECTED',
        DRM: 'WGET_PRO_DRM',
        BLOB: 'WGET_PRO_BLOB_DETECTED',
        MSE: 'WGET_PRO_MSE_DETECTED'
    };

    // ================= STATE MANAGEMENT =================
    class CaptureState {
        constructor() {
            this.capturedUrls = new Set();
            this.drmDetected = false;
            this.blobUrls = new Set();
            this.mseBuffers = new WeakMap();
            this.stats = {
                totalUrls: 0,
                validUrls: 0,
                filteredUrls: 0,
                drmAttempts: 0
            };
        }

        hasUrl(url) {
            return this.capturedUrls.has(url);
        }

        addUrl(url) {
            this.capturedUrls.add(url);
            this.stats.validUrls++;
        }

        addBlobUrl(url) {
            this.blobUrls.add(url);
        }

        incrementTotal() {
            this.stats.totalUrls++;
        }

        incrementFiltered() {
            this.stats.filteredUrls++;
        }

        incrementDRM() {
            this.stats.drmAttempts++;
        }

        getStats() {
            return { ...this.stats };
        }
    }

    const state = new CaptureState();

    // ================= UTILITY FUNCTIONS =================
    // Logger avec préfixe
    function log(level, message, data = null) {
        if (!DEBUG_MODE && level === 'debug') return;

        const prefix = '[WgetPro]';
        const styles = {
            info: 'color: #3b82f6',
            success: 'color: #10b981',
            warn: 'color: #f59e0b',
            error: 'color: #ef4444',
            debug: 'color: #6b7280'
        };

        console.log(`%c${prefix} ${message}`, styles[level] || '');
        if (data) console.log('  ↳', data);
    }

    // Vérifier si l'URL est valide
    function isValidUrl(url) {
        if (!url || typeof url !== 'string') return false;

        try {
            const urlObj = new URL(url);
            return ['http:', 'https:'].includes(urlObj.protocol);
        } catch (e) {
            return false;
        }
    }

    // Vérifier si l'URL est une extension média
    function hasMediaExtension(url) {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname.toLowerCase();

            return MEDIA_EXTENSIONS.VIDEO.test(pathname) ||
                MEDIA_EXTENSIONS.AUDIO.test(pathname) ||
                MEDIA_EXTENSIONS.STREAM.test(pathname);
        } catch (e) {
            return false;
        }
    }

    // Vérifier si l'URL contient des mots-clés vidéo
    function hasVideoKeywords(url) {
        const lowerUrl = url.toLowerCase();
        return VIDEO_KEYWORDS.some(keyword => lowerUrl.includes(keyword));
    }

    // Vérifier si l'URL est d'un CDN vidéo connu
    function isVideoCDN(url) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return VIDEO_CDN_DOMAINS.some(domain => hostname.includes(domain));
        } catch (e) {
            return false;
        }
    }

    // Vérifier si l'URL doit être exclue
    function shouldExclude(url) {
        return EXCLUDE_PATTERNS.some(pattern => pattern.test(url));
    }

    // Vérifier si c'est une URL Blob
    function isBlobUrl(url) {
        return typeof url === 'string' && url.startsWith('blob:');
    }

    // ================= DETECTION LOGIC =================
    // Analyser et classifier une URL
    function analyzeUrl(url) {
        const score = {
            extension: 0,
            keywords: 0,
            cdn: 0,
            mime: 0
        };

        // Extension média (+3 points)
        if (hasMediaExtension(url)) {
            score.extension = 3;
        }

        // Mots-clés vidéo (+2 points)
        if (hasVideoKeywords(url)) {
            score.keywords = 2;
        }

        // CDN vidéo connu (+2 points)
        if (isVideoCDN(url)) {
            score.cdn = 2;
        }

        // MIME type dans l'URL (+1 point)
        if (url.includes('mime=video') || url.includes('mime=audio')) {
            score.mime = 1;
        }

        const totalScore = Object.values(score).reduce((a, b) => a + b, 0);

        return {
            score: totalScore,
            isVideo: totalScore >= 2, // Seuil: minimum 2 points
            details: score
        };
    }

    // Notifier l'extension d'une URL détectée
    function notifyExtension(url, source = 'Unknown', metadata = {}) {
        state.incrementTotal();

        // Vérifications de base
        if (!isValidUrl(url)) {
            log('debug', 'URL invalide ignorée', { url, source });
            return;
        }

        if (state.hasUrl(url)) {
            log('debug', 'URL déjà capturée', { url: url.substring(0, 50) });
            return;
        }

        // Filtrer les URLs indésirables
        if (shouldExclude(url)) {
            state.incrementFiltered();
            log('debug', 'URL filtrée (ads/tracking)', { url: url.substring(0, 50) });
            return;
        }

        // Analyser l'URL
        const analysis = analyzeUrl(url);

        if (analysis.isVideo) {
            state.addUrl(url);

            log('success', `[${source}] Flux détecté (score: ${analysis.score})`, {
                url: url.substring(0, 80),
                score: analysis.details
            });

            // Notifier le content script
            window.postMessage({
                type: MESSAGE_TYPES.DETECTED,
                url: url,
                source: source,
                score: analysis.score,
                timestamp: Date.now(),
                ...metadata
            }, '*');
        } else {
            log('debug', `URL rejetée (score: ${analysis.score})`, {
                url: url.substring(0, 50),
                source
            });
        }
    }

    // ================= NETWORK INTERCEPTION =================
    // Intercepter fetch()
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
        const request = args[0];
        let url = null;

        // Extraire l'URL selon le type d'argument
        if (typeof request === 'string') {
            url = request;
        } else if (request instanceof Request) {
            url = request.url;
        } else if (request?.url) {
            url = request.url;
        }

        if (url) {
            notifyExtension(url, 'Fetch');
        }

        return originalFetch.apply(this, args);
    };

    // Intercepter XMLHttpRequest
    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (typeof url === 'string') {
            notifyExtension(url, 'XHR');
        }

        return originalXHROpen.apply(this, [method, url, ...rest]);
    };

    // ================= DRM DETECTION =================
    // Détecter les tentatives d'accès DRM
    const originalRequestMediaKeySystemAccess = navigator.requestMediaKeySystemAccess;
    if (originalRequestMediaKeySystemAccess) {
        navigator.requestMediaKeySystemAccess = function (keySystem, configurations) {
            if (!state.drmDetected) {
                state.drmDetected = true;
                state.incrementDRM();

                log('warn', 'DRM détecté', {
                    keySystem,
                    configurations: configurations?.length
                });

                window.postMessage({
                    type: MESSAGE_TYPES.DRM,
                    keySystem: keySystem,
                    timestamp: Date.now()
                }, '*');
            }

            return originalRequestMediaKeySystemAccess.apply(this, arguments);
        };
    }

    // Détecter setMediaKeys sur les vidéos
    const originalSetMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
    if (originalSetMediaKeys) {
        HTMLMediaElement.prototype.setMediaKeys = function (mediaKeys) {
            if (mediaKeys && !state.drmDetected) {
                state.drmDetected = true;
                state.incrementDRM();

                log('warn', 'MediaKeys appliquées (DRM actif)');

                window.postMessage({
                    type: MESSAGE_TYPES.DRM,
                    details: 'setMediaKeys called',
                    timestamp: Date.now()
                }, '*');
            }

            return originalSetMediaKeys.apply(this, arguments);
        };
    }

    // ================= BLOB DETECTION =================
    // Détecter les créations de Blob URLs
    const originalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (obj) {
        const blobUrl = originalCreateObjectURL.apply(this, arguments);

        // Vérifier si c'est un Blob vidéo
        if (obj instanceof Blob) {
            const isVideoBlob = obj.type.startsWith('video/') || obj.type.startsWith('audio/');

            if (isVideoBlob && !state.blobUrls.has(blobUrl)) {
                state.addBlobUrl(blobUrl);

                log('info', 'Blob vidéo créé', {
                    url: blobUrl.substring(0, 50),
                    type: obj.type,
                    size: obj.size
                });

                window.postMessage({
                    type: MESSAGE_TYPES.BLOB,
                    blobUrl: blobUrl,
                    mimeType: obj.type,
                    size: obj.size,
                    timestamp: Date.now()
                }, '*');
            }
        }

        return blobUrl;
    };

    // ================= MSE (Media Source Extensions) =================
    // Détecter les MediaSource
    const originalMediaSourceAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    if (originalMediaSourceAddSourceBuffer) {
        MediaSource.prototype.addSourceBuffer = function (mimeType) {
            const sourceBuffer = originalMediaSourceAddSourceBuffer.apply(this, arguments);

            log('info', 'SourceBuffer créé (MSE)', { mimeType });

            window.postMessage({
                type: MESSAGE_TYPES.MSE,
                mimeType: mimeType,
                timestamp: Date.now()
            }, '*');

            return sourceBuffer;
        };
    }

    // ================= VIDEO ELEMENT MONITORING =================
    // Observer les éléments <video> et <audio>
    function monitorMediaElements() {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Vérifier si c'est un élément média
                        if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
                            attachMediaListeners(node);
                        }

                        // Chercher les médias dans les enfants
                        const mediaElements = node.querySelectorAll?.('video, audio');
                        mediaElements?.forEach(attachMediaListeners);
                    }
                });
            });
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        // Traiter les éléments existants
        document.querySelectorAll('video, audio').forEach(attachMediaListeners);
    }

    // Attacher des listeners sur un élément média
    function attachMediaListeners(element) {
        // Vérifier la source
        if (element.src) {
            notifyExtension(element.src, 'Media Element', {
                tagName: element.tagName.toLowerCase()
            });
        }

        if (element.currentSrc) {
            notifyExtension(element.currentSrc, 'Media Element', {
                tagName: element.tagName.toLowerCase()
            });
        }

        // Observer les changements de source
        const srcObserver = new MutationObserver(() => {
            if (element.src) notifyExtension(element.src, 'Media Element (Updated)');
            if (element.currentSrc) notifyExtension(element.currentSrc, 'Media Element (Updated)');
        });

        srcObserver.observe(element, {
            attributes: true,
            attributeFilter: ['src']
        });

        // Écouter l'événement loadedmetadata
        element.addEventListener('loadedmetadata', () => {
            if (element.currentSrc) {
                notifyExtension(element.currentSrc, 'Media Loaded', {
                    duration: element.duration,
                    tagName: element.tagName.toLowerCase()
                });
            }
        });
    }

    // ================= INITIALIZATION =================
    function initialize() {
        log('success', `Niveau 3 activé (v${SCRIPT_VERSION}) - Filtrage intelligent`);

        // Démarrer le monitoring des vidéos
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', monitorMediaElements);
        } else {
            monitorMediaElements();
        }

        // Exposer l'API de debug
        if (DEBUG_MODE) {
            window.__wgetProInject = {
                getStats: () => state.getStats(),
                getCaptured: () => Array.from(state.capturedUrls),
                getBlobs: () => Array.from(state.blobUrls),
                clearState: () => {
                    state.capturedUrls.clear();
                    state.blobUrls.clear();
                    state.drmDetected = false;
                    log('info', 'État nettoyé');
                }
            };
        }
    }

    // ================= START =================
    initialize();

    // ================= PERIODIC STATS =================
    if (DEBUG_MODE) {
        setInterval(() => {
            const stats = state.getStats();
            if (stats.totalUrls > 0) {
                log('debug', 'Statistiques', stats);
            }
        }, 30000); // Toutes les 30 secondes
    }

    // Protéger le script contre les réécritures
    Object.freeze(window.fetch);
    Object.freeze(XMLHttpRequest.prototype.open);

    log('info', 'Protections activées');

})();