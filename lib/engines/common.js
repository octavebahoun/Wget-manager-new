'use strict';
// Erreurs typées partagées par les moteurs

class EngineError extends Error {
  /**
   * @param {string} message
   * @param {{retryable?: boolean, fallback?: boolean, reroute?: string}} opts
   *  - retryable : erreur passagère (réseau...) → on réessaie
   *  - fallback  : ce moteur ne sait pas faire → on essaie le moteur suivant
   *  - reroute   : le contenu réel est d'un autre type (ex: "hls") → on change de moteur
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'EngineError';
    this.retryable = !!opts.retryable;
    this.fallback = !!opts.fallback;
    this.reroute = opts.reroute || null;
  }
}

// Repère les erreurs réseau passagères dans un message
function isTransient(text) {
  return /timed? ?out|timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|socket hang up|Connection (reset|refused|aborted)|Temporary failure|HTTP Error (5\d\d|429)|\b(500|502|503|504|429)\b|IncompleteRead|EOF occurred|network/i.test(String(text || ''));
}

// Extrait les lignes d'erreur utiles d'une sortie
function pickErrorLine(lines, fallback) {
  const list = (lines || []).filter(Boolean);
  const hit = [...list].reverse().find((l) => /^ERROR:|error|failed|exception|denied|forbidden|not found|invalid|refused/i.test(l));
  const line = (hit || list[list.length - 1] || fallback || 'Erreur inconnue').replace(/^ERROR:\s*/, '');
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

module.exports = { EngineError, isTransient, pickErrorLine };
