# PR Quiz Guard

Blocks GitHub's **Approve** button on a pull request review until you pass a
short comprehension quiz generated from that PR's actual diff. The goal: stop
rubber-stamping reviews — you have to demonstrate you understood the specific
change before the approval goes through.

Available as both a **Tampermonkey userscript** and a **Chrome extension**.
Both share the same engine (`shared/core.js`) — the only difference is the
thin platform adapter that provides settings storage and network access.

## LLM providers

Three providers are supported; pick one in the extension popup (or the
Tampermonkey menu):

| Provider | Cost | API key | Default model |
|---|---|---|---|
| **Free** (default) | Free | **None needed** | `openai-fast` (GPT-OSS 20B via [pollinations.ai](https://pollinations.ai)) |
| **Mistral** | Free tier (Experiment plan) | Required — free at [console.mistral.ai](https://console.mistral.ai/api-keys) | `mistral-small-latest` |
| **Claude** | Paid | Required — [platform.claude.com](https://platform.claude.com) | `claude-haiku-4-5` |

The **Free** provider works with zero setup — install and go. It uses
pollinations.ai's anonymous community endpoint, which is rate-limited and
best-effort; if you want something more dependable (or specifically Mistral's
models), create a free Mistral key. Note there is no keyless Mistral API —
Mistral's free tier still requires creating a (free) key.

## How it works

1. You click "Submit review" with **Approve** selected, as usual (or use the
   ⌘/Ctrl+Enter shortcut — both are intercepted).
2. The extension fetches the PR's diff and description, and asks the
   configured LLM to write 1–3 questions that probe understanding of *this*
   change (specific functions, edge cases, risk) — not generic "what does
   this PR do" filler, and not obscure gotchas either.
3. You answer each question in a small modal.
4. The LLM grades your answers against the diff. If every answer passes, the
   modal closes and your approval submits for real. If not, you see what was
   weak and can revise and resubmit.
5. Once you've passed for a given PR at its current commit, re-approving
   (e.g. after a page reload) skips straight through — a new commit pushed
   to the PR resets it and triggers a fresh quiz.

Nothing is sent anywhere except directly from your browser to the LLM
provider you chose — there's no server of ours, no proxy, nothing to keep
running.

## Project layout

```
shared/core.js               Platform-agnostic engine: diff/description
                              fetching, LLM provider layer, modal UI, Approve
                              interception. Takes an injected `adapter`.
userscript/adapter.js        Tampermonkey glue (GM_* APIs, menu commands).
extension/                   Chrome extension (manifest v3):
  manifest.json
  background.js              Proxies network requests for the content script
                              (bypasses github.com's service worker, same
                              reason the userscript uses GM_xmlhttpRequest).
  content-adapter.js         chrome.storage/chrome.runtime glue.
  core.js                    Generated copy of shared/core.js (see below).
  popup.html / popup.js      Settings UI (API key + model).
build.js                     Node script: assembles pr-quiz-guard.user.js
                              and extension/core.js from shared/core.js.
pr-quiz-guard.user.js         Generated — the file you actually install into
                              Tampermonkey.
```

**If you edit `shared/core.js`, run `node build.js` afterwards** to
regenerate `pr-quiz-guard.user.js` and `extension/core.js`.

## Install — Tampermonkey

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser
   extension (Chrome, Firefox, Edge, Safari all supported).
2. Open the Tampermonkey dashboard → **Create a new script**.
3. Delete the placeholder content and paste in the contents of
   `pr-quiz-guard.user.js`.
4. Save (Ctrl/Cmd+S). Tampermonkey will prompt you to allow the script to
   connect to the provider's API host the first time it runs — accept it.
5. That's it — the default **Free** provider needs no key. To use Mistral or
   Claude instead: Tampermonkey icon → **PR Quiz Guard** →
   **Provider: … — change…**, pick one, and paste the API key when prompted
   (Mistral: free key from
   [console.mistral.ai](https://console.mistral.ai/api-keys); Claude: from
   [platform.claude.com](https://platform.claude.com)). Keys are stored
   locally in Tampermonkey's script storage, not synced anywhere.
6. (Optional) **Set model** — each provider has a sensible default. Reload
   the PR page after changing anything.

## Install — Chrome extension

1. Run `node build.js` once (regenerates `extension/core.js` from
   `shared/core.js` if you haven't already).
2. Go to `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select this repo's `extension/` folder.
4. Click the PR Quiz Guard icon in the toolbar and pick a provider. The
   default **Free** provider needs no key — you can hit **Test** to confirm
   it's reachable and you're done. For Mistral or Claude, paste your API key,
   optionally pick a model, hit **Test** to verify, then **Save**.
5. Reload any open GitHub PR tabs.

Settings are stored in `chrome.storage.local` — local to your browser
profile, never synced or sent anywhere except directly to your chosen
provider's API.

## Using it

Just review PRs on GitHub normally. When you select **Approve** and hit
**Submit review**, the quiz modal appears instead of submitting immediately.
Answer the questions, submit, and — if you pass — your approval goes through
automatically.

Cancelling the modal at any point just closes it without approving; nothing
is submitted.

## Notes / limitations

- Only intercepts the **Approve** path — "Request changes" and "Comment"
  reviews submit normally, unaffected.
- Relies on GitHub's review form containing a checked radio input whose
  value matches `approve` and a submit control labeled "Submit review". If
  GitHub changes this markup significantly, the interception may stop
  matching — if approvals start going through without a quiz, that's the
  first thing to check.
- Large diffs are truncated to roughly 12,000 characters (kept from the
  start of the diff) before being sent to the model, to keep quiz-generation
  fast and cheap.
- The pass/fail cache is keyed by PR + a hash of the diff text, stored in
  `localStorage` — clearing site data for github.com resets it.
