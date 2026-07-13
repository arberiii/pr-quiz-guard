'use strict';

const DEFAULT_MODEL = 'claude-haiku-4-5';

const apiKeyInput = document.getElementById('apiKey');
const modelInput = document.getElementById('model');
const status = document.getElementById('status');

chrome.storage.local.get(['prQuizGuard:apiKey', 'prQuizGuard:model']).then((r) => {
  if (r['prQuizGuard:apiKey']) apiKeyInput.placeholder = '••••••••' + r['prQuizGuard:apiKey'].slice(-4);
  modelInput.value = r['prQuizGuard:model'] || DEFAULT_MODEL;
});

document.getElementById('save').addEventListener('click', () => {
  const updates = {};
  if (apiKeyInput.value.trim()) updates['prQuizGuard:apiKey'] = apiKeyInput.value.trim();
  updates['prQuizGuard:model'] = modelInput.value.trim() || DEFAULT_MODEL;

  chrome.storage.local.set(updates).then(() => {
    apiKeyInput.value = '';
    status.textContent = 'Saved. Reload the PR tab to apply.';
    setTimeout(() => (status.textContent = ''), 2500);
  });
});
