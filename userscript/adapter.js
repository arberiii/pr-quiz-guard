// PR Quiz Guard — Tampermonkey adapter. Wires the shared engine (core.js) up
// to GM_* APIs and starts it. Concatenated after core.js by build.js to
// produce the distributable pr-quiz-guard.user.js.
(function () {
  'use strict';

  const Core = window.PRQuizGuardCore;
  const PROVIDERS = Core.PROVIDERS;

  // Storage layout: provider choice under 'prQuizGuard:provider', keys and
  // models namespaced per provider so switching back and forth never loses
  // anything. Legacy installs stored a single Anthropic key under
  // 'prQuizGuard:apiKey' / 'prQuizGuard:model'; those are read as fallbacks.
  function currentProviderId() {
    const stored = GM_getValue('prQuizGuard:provider', '');
    if (stored && PROVIDERS[stored]) return stored;
    // Legacy install with an Anthropic key set keeps working unchanged.
    return GM_getValue('prQuizGuard:apiKey', '') ? 'anthropic' : Core.DEFAULT_PROVIDER;
  }

  function getKeyFor(providerId) {
    const key = GM_getValue('prQuizGuard:apiKey:' + providerId, '');
    if (key) return key;
    return providerId === 'anthropic' ? GM_getValue('prQuizGuard:apiKey', '') : '';
  }

  function getModelFor(providerId) {
    const model = GM_getValue('prQuizGuard:model:' + providerId, '');
    if (model) return model;
    return providerId === 'anthropic' ? GM_getValue('prQuizGuard:model', '') : '';
  }

  function getSettings() {
    const providerId = currentProviderId();
    return Promise.resolve({
      provider: providerId,
      apiKey: getKeyFor(providerId),
      model: getModelFor(providerId),
    });
  }

  // -------------------------------------------------------------------
  // Menu commands (labels are snapshotted at registration; page reload
  // refreshes them after a change)
  // -------------------------------------------------------------------

  const active = PROVIDERS[currentProviderId()];

  GM_registerMenuCommand('Provider: ' + active.label + ' — change…', () => {
    const ids = Object.keys(PROVIDERS);
    const menu = ids
      .map((id, i) => `${i + 1}) ${PROVIDERS[id].label} — ${PROVIDERS[id].tagline}`)
      .join('\n');
    const answer = prompt('Choose LLM provider:\n\n' + menu + '\n\nEnter a number:', String(ids.indexOf(currentProviderId()) + 1));
    if (!answer) return;
    const chosen = ids[parseInt(answer.trim(), 10) - 1];
    if (!chosen) {
      alert('Invalid choice.');
      return;
    }
    GM_setValue('prQuizGuard:provider', chosen);
    const p = PROVIDERS[chosen];
    if (p.needsKey && !getKeyFor(chosen)) {
      const key = prompt(p.label + ' API key (get one at ' + p.keyUrl + '):');
      if (key && key.trim()) GM_setValue('prQuizGuard:apiKey:' + chosen, key.trim());
    }
    alert('Provider set to ' + p.label + '. Reload the PR page to apply.');
  });

  GM_registerMenuCommand('Set API key (' + active.label + ')', () => {
    const providerId = currentProviderId();
    const p = PROVIDERS[providerId];
    if (!p.needsKey) {
      alert(p.label + ' needs no API key — you are all set.');
      return;
    }
    const current = getKeyFor(providerId);
    const next = prompt(
      p.label + ' API key (get one at ' + p.keyUrl + '):',
      current ? '••••••••' + current.slice(-4) : ''
    );
    if (next && !next.startsWith('••••')) {
      GM_setValue('prQuizGuard:apiKey:' + providerId, next.trim());
      alert('API key saved.');
    }
  });

  GM_registerMenuCommand(
    'Set model (' + active.label + ', current: ' + (getModelFor(currentProviderId()) || active.defaultModel) + ')',
    () => {
      const providerId = currentProviderId();
      const p = PROVIDERS[providerId];
      const next = prompt(
        'Model for ' + p.label + ' (suggestions: ' + p.models.join(', ') + '):',
        getModelFor(providerId) || p.defaultModel
      );
      if (next && next.trim()) {
        GM_setValue('prQuizGuard:model:' + providerId, next.trim());
        alert('Model set to ' + next.trim() + '. Reload the page to apply.');
      }
    }
  );

  // Dispatched by the browser extension itself (not the page), bypassing
  // github.com's service worker and any page-level CORS restrictions.
  function httpRequest({ method, url, headers, data }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data,
        onload(res) {
          resolve({ status: res.status, responseText: res.responseText });
        },
        onerror() {
          reject(new Error('Network error requesting ' + url));
        },
      });
    });
  }

  Core.init({
    getSettings,
    httpRequest,
    setupHint: 'Use the Tampermonkey menu → "Set API key".',
  });
})();
