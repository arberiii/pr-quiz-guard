// PR Quiz Guard — Chrome extension content-script adapter. Wires the shared
// engine (core.js, loaded before this file per manifest.json) up to
// chrome.storage/chrome.runtime and starts it.
(function () {
  'use strict';

  const DEFAULT_MODEL = 'claude-haiku-4-5';

  function getApiKey() {
    return chrome.storage.local.get('prQuizGuard:apiKey').then((r) => r['prQuizGuard:apiKey'] || '');
  }

  function getModel() {
    return chrome.storage.local
      .get('prQuizGuard:model')
      .then((r) => r['prQuizGuard:model'] || DEFAULT_MODEL);
  }

  // Relayed through the background service worker so the request bypasses
  // github.com's own service worker (see extension/background.js).
  function httpRequest({ method, url, headers, data }) {
    return chrome.runtime
      .sendMessage({ type: 'prQuizGuard:httpRequest', payload: { method, url, headers, data } })
      .then((res) => {
        if (!res || !res.ok) throw new Error((res && res.error) || 'Network error requesting ' + url);
        return res.result;
      });
  }

  window.PRQuizGuardCore.init({
    getApiKey,
    getModel,
    httpRequest,
    apiKeySetupHint: 'Click the PR Quiz Guard extension icon and set it there.',
  });
})();
