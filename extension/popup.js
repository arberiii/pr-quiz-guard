'use strict';

// Settings popup. core.js (loaded first) provides window.PRQuizGuardCore with
// the provider registry and request builders, so this file stays pure UI.
const Core = window.PRQuizGuardCore;
const PROVIDERS = Core.PROVIDERS;

const providersEl = document.getElementById('providers');
const noteEl = document.getElementById('providerNote');
const keyRow = document.getElementById('keyRow');
const keyLink = document.getElementById('keyLink');
const apiKeyInput = document.getElementById('apiKey');
const modelInput = document.getElementById('model');
const modelList = document.getElementById('modelList');
const statusEl = document.getElementById('status');
const testBtn = document.getElementById('test');
const saveBtn = document.getElementById('save');

let stored = {}; // raw chrome.storage snapshot
let selected = Core.DEFAULT_PROVIDER;
// Unsaved per-provider edits, so switching cards back and forth keeps typing.
const draftKeys = {};
const draftModels = {};

function storedKeyFor(id) {
  return (
    stored['prQuizGuard:apiKey:' + id] ||
    (id === 'anthropic' ? stored['prQuizGuard:apiKey'] || '' : '')
  );
}

function storedModelFor(id) {
  return (
    stored['prQuizGuard:model:' + id] ||
    (id === 'anthropic' ? stored['prQuizGuard:model'] || '' : '')
  );
}

function setStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind || '';
}

function renderProviders() {
  providersEl.innerHTML = '';
  Object.values(PROVIDERS).forEach((p) => {
    const card = document.createElement('div');
    card.className = 'provider' + (p.id === selected ? ' selected' : '');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.label;
    const tag = document.createElement('span');
    tag.className = 'tag' + (p.needsKey ? '' : ' free-badge');
    tag.textContent = p.tagline;
    card.appendChild(name);
    card.appendChild(tag);
    const select = () => selectProvider(p.id);
    card.addEventListener('click', select);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') select();
    });
    providersEl.appendChild(card);
  });
}

function selectProvider(id) {
  // Stash in-progress edits for the provider we're leaving.
  if (id !== selected) {
    if (apiKeyInput.value.trim()) draftKeys[selected] = apiKeyInput.value.trim();
    draftModels[selected] = modelInput.value.trim();
  }

  selected = id;
  const p = PROVIDERS[id];
  renderProviders();
  noteEl.textContent = p.note;

  keyRow.classList.toggle('hidden', !p.needsKey);
  if (p.needsKey) {
    keyLink.href = p.keyUrl;
    apiKeyInput.value = draftKeys[id] || '';
    const savedKey = storedKeyFor(id);
    apiKeyInput.placeholder = savedKey ? '••••••••' + savedKey.slice(-4) : p.keyPlaceholder || '';
  }

  modelInput.value = draftModels[id] !== undefined ? draftModels[id] : storedModelFor(id);
  modelInput.placeholder = p.defaultModel;
  modelList.innerHTML = '';
  p.models.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    modelList.appendChild(opt);
  });
  setStatus('', '');
}

function currentFormSettings() {
  const p = PROVIDERS[selected];
  return {
    provider: selected,
    apiKey: p.needsKey ? apiKeyInput.value.trim() || storedKeyFor(selected) : '',
    model: modelInput.value.trim() || p.defaultModel,
  };
}

saveBtn.addEventListener('click', () => {
  const p = PROVIDERS[selected];
  const updates = { 'prQuizGuard:provider': selected };
  if (p.needsKey && apiKeyInput.value.trim()) {
    updates['prQuizGuard:apiKey:' + selected] = apiKeyInput.value.trim();
  }
  updates['prQuizGuard:model:' + selected] = modelInput.value.trim() || p.defaultModel;

  chrome.storage.local.set(updates).then(() => {
    Object.assign(stored, updates);
    delete draftKeys[selected];
    apiKeyInput.value = '';
    const savedKey = storedKeyFor(selected);
    if (p.needsKey) {
      apiKeyInput.placeholder = savedKey ? '••••••••' + savedKey.slice(-4) : p.keyPlaceholder || '';
    }
    if (p.needsKey && !savedKey) {
      setStatus('Saved — but ' + p.label + ' needs an API key before it will work.', 'err');
    } else {
      setStatus('Saved. Reload the PR tab to apply.', 'ok');
      setTimeout(() => setStatus('', ''), 2500);
    }
  });
});

testBtn.addEventListener('click', async () => {
  const p = PROVIDERS[selected];
  const settings = currentFormSettings();
  if (p.needsKey && !settings.apiKey) {
    setStatus('Enter an API key first — or use the Free provider.', 'err');
    return;
  }
  testBtn.disabled = true;
  setStatus('Testing ' + p.label + '…', '');
  try {
    const req = Core.buildChatRequest(selected, {
      apiKey: settings.apiKey,
      model: settings.model,
      system: 'You are a connectivity check. Reply with JSON only.',
      messages: [{ role: 'user', content: 'Return {"ok": true}.' }],
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    });
    const res = await chrome.runtime.sendMessage({
      type: 'prQuizGuard:httpRequest',
      payload: req,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Network error.');
    if (res.result.status < 200 || res.result.status >= 300) {
      throw new Error('HTTP ' + res.result.status + ': ' + String(res.result.responseText).slice(0, 160));
    }
    Core.parseChatResponse(selected, res.result.responseText);
    setStatus('✓ ' + p.label + ' works with model ' + settings.model + '.', 'ok');
  } catch (err) {
    setStatus('✗ ' + (err.message || String(err)), 'err');
  } finally {
    testBtn.disabled = false;
  }
});

chrome.storage.local.get(null).then((r) => {
  stored = r || {};
  const savedProvider = stored['prQuizGuard:provider'];
  if (savedProvider && PROVIDERS[savedProvider]) {
    selected = savedProvider;
  } else if (stored['prQuizGuard:apiKey']) {
    selected = 'anthropic'; // legacy install
  }
  selectProvider(selected);
});
