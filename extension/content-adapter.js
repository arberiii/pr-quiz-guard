// PR Quiz Guard — Chrome extension content-script adapter. Wires the shared
// engine (core.js, loaded before this file per manifest.json) up to
// chrome.storage/chrome.runtime and starts it.
(function () {
  'use strict';

  const Core = window.PRQuizGuardCore;

  // Storage layout: provider choice under 'prQuizGuard:provider', keys and
  // models namespaced per provider ('prQuizGuard:apiKey:<provider>'). Legacy
  // installs stored a single Anthropic key under 'prQuizGuard:apiKey' /
  // 'prQuizGuard:model'; those are read as fallbacks.
  function getSettings() {
    return chrome.storage.local.get(null).then((r) => {
      let providerId = r['prQuizGuard:provider'];
      if (!providerId || !Core.PROVIDERS[providerId]) {
        providerId = r['prQuizGuard:apiKey'] ? 'anthropic' : Core.DEFAULT_PROVIDER;
      }
      const legacyKey = providerId === 'anthropic' ? r['prQuizGuard:apiKey'] || '' : '';
      const legacyModel = providerId === 'anthropic' ? r['prQuizGuard:model'] || '' : '';
      return {
        provider: providerId,
        apiKey: r['prQuizGuard:apiKey:' + providerId] || legacyKey,
        model: r['prQuizGuard:model:' + providerId] || legacyModel,
      };
    });
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

  Core.init({
    getSettings,
    httpRequest,
    setupHint: 'Click the PR Quiz Guard extension icon and set it there.',
  });
})();
