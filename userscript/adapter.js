// PR Quiz Guard — Tampermonkey adapter. Wires the shared engine (core.js) up
// to GM_* APIs and starts it. Concatenated after core.js by build.js to
// produce the distributable pr-quiz-guard.user.js.
(function () {
  'use strict';

  const DEFAULT_MODEL = 'claude-haiku-4-5';

  function getApiKey() {
    return Promise.resolve(GM_getValue('prQuizGuard:apiKey', ''));
  }

  function getModel() {
    return Promise.resolve(GM_getValue('prQuizGuard:model', DEFAULT_MODEL));
  }

  GM_registerMenuCommand('Set Anthropic API Key', () => {
    const current = GM_getValue('prQuizGuard:apiKey', '');
    const next = prompt(
      'Anthropic API key (starts with sk-ant-):',
      current ? '••••••••' + current.slice(-4) : ''
    );
    if (next && !next.startsWith('••••')) {
      GM_setValue('prQuizGuard:apiKey', next.trim());
      alert('API key saved.');
    }
  });

  GM_registerMenuCommand('Set Model (current: ' + GM_getValue('prQuizGuard:model', DEFAULT_MODEL) + ')', () => {
    const next = prompt('Model ID to use for quiz generation/grading:', GM_getValue('prQuizGuard:model', DEFAULT_MODEL));
    if (next && next.trim()) {
      GM_setValue('prQuizGuard:model', next.trim());
      alert('Model set to ' + next.trim() + '. Reload the page to apply.');
    }
  });

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

  window.PRQuizGuardCore.init({
    getApiKey,
    getModel,
    httpRequest,
    apiKeySetupHint: 'Use the Tampermonkey menu → "Set Anthropic API Key".',
  });
})();
