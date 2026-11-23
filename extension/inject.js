// inject.js — exécuté dans la page (MAIN world), le plus léger possible.
// Signale seulement : DRM réellement activé sur une vidéo, et lecteur MSE (vidéo en "blob:").
// La détection des flux se fait côté extension (réseau + scan de la page), sans modifier fetch/XHR.
(() => {
  if (window.__wgetProInjected) return;
  try {
    Object.defineProperty(window, '__wgetProInjected', { value: true });
  } catch {
    return;
  }

  const post = (type) => {
    try {
      window.postMessage({ __wgetPro: true, type }, '*');
    } catch { /* ignore */ }
  };

  // DRM : clés réellement appliquées à un élément vidéo (pas un simple test de compatibilité)
  try {
    const original = HTMLMediaElement.prototype.setMediaKeys;
    if (original) {
      HTMLMediaElement.prototype.setMediaKeys = function setMediaKeys(keys) {
        if (keys) post('drm');
        return original.apply(this, arguments);
      };
    }
  } catch { /* ignore */ }

  // MSE : le lecteur assemble la vidéo lui-même → il faut le flux HLS/DASH ou la page
  try {
    for (const MS of [window.MediaSource, window.ManagedMediaSource]) {
      const original = MS?.prototype?.addSourceBuffer;
      if (!original) continue;
      MS.prototype.addSourceBuffer = function addSourceBuffer() {
        post('mse');
        return original.apply(this, arguments);
      };
    }
  } catch { /* ignore */ }
})();
