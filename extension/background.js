// PR Quiz Guard — background service worker.
//
// Performs the actual network requests on behalf of the content script.
// Fetching from the background page (rather than from the content script's
// page context) is what bypasses GitHub's service worker on the .diff
// endpoint — mirroring why the Tampermonkey build uses GM_xmlhttpRequest
// instead of a plain page fetch().
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'prQuizGuard:httpRequest') return false;

  const { method, url, headers, data } = message.payload;
  fetch(url, { method, headers, body: data })
    .then(async (res) => ({ status: res.status, responseText: await res.text() }))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));

  return true; // keep the message channel open for the async sendResponse above
});
