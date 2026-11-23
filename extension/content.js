// content.js — relaie les signaux du lecteur (DRM, MSE) vers le service worker
(() => {
  if (window.__wgetProContent) return;
  window.__wgetProContent = true;

  const sent = new Set();
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__wgetPro !== true || (data.type !== 'drm' && data.type !== 'mse')) return;
    if (sent.has(data.type)) return; // un seul signal de chaque type par page
    sent.add(data.type);
    try {
      chrome.runtime.sendMessage({ type: 'PAGE_SIGNAL', signal: data.type }).catch(() => {});
    } catch {
      // extension rechargée : contexte invalide
    }
  });
})();
