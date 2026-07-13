// ==UserScript==
// @name         PR Quiz Guard
// @namespace    https://github.com/
// @version      1.3.0
// @description  Blocks GitHub PR "Approve" until you pass a short comprehension quiz generated from the actual diff.
// @author       you
// @match        https://github.com/*/*/pull/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.anthropic.com
// @connect      github.com
// @connect      patch-diff.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

// PR Quiz Guard — shared engine.
//
// This file contains everything that doesn't depend on Tampermonkey (GM_*) or
// Chrome-extension (chrome.*) APIs: diff/description fetching (via an injected
// adapter), the Claude API calls, the modal UI, and the "Approve" button
// interception. Platform-specific glue lives in userscript/adapter.js and
// extension/content-adapter.js, each of which builds an `adapter` object and
// calls PRQuizGuardCore.init(adapter).
//
// adapter shape:
//   {
//     getApiKey(): Promise<string>,
//     getModel(): Promise<string>,
//     httpRequest({ method, url, headers, data }): Promise<{ status, responseText }>,
//     apiKeySetupHint: string,   // human-readable instructions shown when no key is set
//   }
(function (global) {
  'use strict';

  const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
  const MAX_DIFF_CHARS = 12000;
  const MAX_DESCRIPTION_CHARS = 3000;

  function init(adapter) {
    // -------------------------------------------------------------------
    // Diff hashing + result cache
    // -------------------------------------------------------------------

    function fnv1aHash(str) {
      let hash = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
      }
      return (hash >>> 0).toString(16);
    }

    function prKey() {
      // /owner/repo/pull/123 -> owner/repo#123
      const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!m) return null;
      return `${m[1]}/${m[2]}#${m[3]}`;
    }

    function cacheKey(diffHash) {
      return `prQuizGuard:${prKey()}:${diffHash}`;
    }

    function hasPassedCache(diffHash) {
      try {
        return localStorage.getItem(cacheKey(diffHash)) === 'passed';
      } catch (e) {
        return false;
      }
    }

    function markPassedCache(diffHash) {
      try {
        localStorage.setItem(cacheKey(diffHash), 'passed');
      } catch (e) {
        /* ignore quota errors */
      }
    }

    // -------------------------------------------------------------------
    // Fetch PR diff + title
    // -------------------------------------------------------------------

    function prBaseUrl() {
      const m = location.pathname.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)/);
      if (!m) throw new Error('Could not determine PR path from ' + location.pathname);
      return location.origin + m[1];
    }

    function prDiffUrl() {
      // GitHub's PR sub-pages are /pull/123/changes, /pull/123/files, /pull/123/commits, etc.
      // The .diff endpoint only exists at the bare /pull/123 path.
      return prBaseUrl() + '.diff';
    }

    // GitHub registers a service worker on github.com that intercepts/rejects plain
    // fetch()/XHR calls to the .diff endpoint from page scripts. adapter.httpRequest is
    // dispatched outside the page's own fetch pipeline (GM_xmlhttpRequest for the
    // userscript, the extension's background service worker for the extension), so it
    // bypasses that entirely.
    function fetchDiff() {
      return adapter.httpRequest({ method: 'GET', url: prDiffUrl() }).then((res) => {
        if (res.status < 200 || res.status >= 300) {
          throw new Error('Failed to fetch diff: HTTP ' + res.status);
        }
        let text = res.responseText;
        if (text.length > MAX_DIFF_CHARS) {
          text = text.slice(0, MAX_DIFF_CHARS) + '\n\n[... diff truncated for length ...]';
        }
        return text;
      });
    }

    function getPrTitle() {
      // document.title looks like "<title> by <author> · Pull Request #123 · owner/repo"
      const raw = document.title || '';
      return raw.split(' · Pull Request')[0].replace(/\s+by\s+\S+$/, '').trim() || raw;
    }

    // Fetches the PR's opening comment (the description GitHub shows on the
    // Conversation tab) so the quiz has the "why" behind the change, not just the
    // diff. Uses the same adapter.httpRequest path as fetchDiff() for the same reason
    // (bypasses github.com's service worker / fetch wrapper).
    function fetchPrDescription() {
      return adapter
        .httpRequest({ method: 'GET', url: prBaseUrl() })
        .then((res) => {
          if (res.status < 200 || res.status >= 300) return ''; // nice-to-have; never block the quiz on it
          try {
            const doc = new DOMParser().parseFromString(res.responseText, 'text/html');
            // The opening comment is the first .markdown-body on the page.
            const body = doc.querySelector('.markdown-body, .comment-body');
            let text = body ? body.textContent.trim() : '';
            if (!text) {
              const ogDesc = doc.querySelector('meta[property="og:description"]');
              text = ogDesc ? ogDesc.getAttribute('content') || '' : '';
            }
            if (text.length > MAX_DESCRIPTION_CHARS) {
              text = text.slice(0, MAX_DESCRIPTION_CHARS) + '\n\n[... description truncated ...]';
            }
            return text;
          } catch (e) {
            return '';
          }
        })
        .catch(() => '');
    }

    // -------------------------------------------------------------------
    // Anthropic API calls
    // -------------------------------------------------------------------

    async function callClaude({ system, messages, schema }) {
      const apiKey = await adapter.getApiKey();
      if (!apiKey) {
        throw new Error('No Anthropic API key set. ' + adapter.apiKeySetupHint);
      }
      const model = await adapter.getModel();

      const body = {
        model,
        max_tokens: 4096,
        system,
        messages,
        output_config: {
          format: {
            type: 'json_schema',
            schema,
          },
        },
      };

      const res = await adapter.httpRequest({
        method: 'POST',
        url: ANTHROPIC_URL,
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        data: JSON.stringify(body),
      });

      if (res.status < 200 || res.status >= 300) {
        throw new Error('Anthropic API error ' + res.status + ': ' + res.responseText);
      }
      let parsed;
      try {
        parsed = JSON.parse(res.responseText);
      } catch (e) {
        throw new Error('Failed to parse Anthropic response: ' + e.message);
      }
      const textBlock = (parsed.content || []).find((b) => b.type === 'text');
      if (!textBlock) {
        throw new Error('No text content in Anthropic response.');
      }
      return JSON.parse(textBlock.text);
    }

    const QUIZ_SCHEMA = {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          // Note: Anthropic's structured-output json_schema only supports minItems/maxItems
          // values of 0 or 1 for arrays — the exact question count is enforced via the prompt
          // (see generateQuiz's system message) instead of a schema constraint.
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              question: { type: 'string' },
            },
            required: ['id', 'question'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    };

    const GRADE_SCHEMA = {
      type: 'object',
      properties: {
        overall_pass: { type: 'boolean' },
        per_question: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              verdict: { type: 'string', enum: ['pass', 'weak', 'fail'] },
              feedback: { type: 'string' },
            },
            required: ['id', 'verdict', 'feedback'],
            additionalProperties: false,
          },
        },
      },
      required: ['overall_pass', 'per_question'],
      additionalProperties: false,
    };

    // Rough count of added/removed lines (excludes the +++/--- file headers), used
    // to anchor the model's question count to actual diff size instead of its own
    // fuzzy sense of "small".
    function countChangedLines(diff) {
      return diff
        .split('\n')
        .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
        .length;
    }

    function generateQuiz(diff, title, description) {
      const changedLines = countChangedLines(diff);
      return callClaude({
        system:
          'You are a code-review comprehension quiz generator. You will be given a pull ' +
          'request title, its description (the "why" - the problem being fixed, the goal), its ' +
          'unified diff (the "what" and "how"), and a count of changed lines in the diff. Use the ' +
          'description only for context on intent - never ask about it directly, and never ask ' +
          'questions answerable just by reading the description or title ("what problem does this ' +
          'fix", "what is the goal of this PR"). Every question must be about the actual code change: ' +
          'pick specific functions, variables, branches, or lines from the diff and probe whether the ' +
          'reviewer traced through them. Favor simple, direct questions like: what does [specific ' +
          'function/line] do; what would happen if [a specific input] were empty/null/unexpected at ' +
          '[specific line]; what would break if [specific line/check] were removed; how does this ' +
          'interact with [other code visible in the diff, e.g. a caller or a related branch]. Avoid ' +
          'questions with an obvious, one-word, or purely descriptive answer - each question should ' +
          'still require the reviewer to have actually looked at the diff, not just skimmed it. Never ' +
          'ask generic questions like "what does this PR do" or "summarize the changes". ' +
          'Keep every question easy: answerable in one short sentence from something directly visible ' +
          'in the diff, with no multi-step reasoning, no chasing code outside the diff, and no obscure ' +
          'edge cases or "gotcha" details a reviewer would reasonably skip over. The goal is a quick ' +
          'sanity check that the reviewer opened and read the diff, not a test of how deep they can go. ' +
          'When in doubt, pick the easier, more obviously-answerable question every time. ' +
          'Scale the number of questions to the size of the change, using the changed-line count as the ' +
          'primary signal: fewer than 15 changed lines -> exactly 1 question; 15 to 60 changed lines -> ' +
          '1 or 2 questions; more than 60 changed lines -> up to 3 questions, and only write 3 if the ' +
          'diff genuinely has three distinct, non-redundant things worth asking about. Never pad with a ' +
          'weak or redundant question just to hit a higher count - fewer good questions is always better ' +
          'than more weak ones. Always write at least 1 question. Assume the reviewer can see the diff ' +
          'while answering.',
        messages: [
          {
            role: 'user',
            content:
              `PR title: ${title}\n\n` +
              (description ? `PR description:\n${description}\n\n` : '') +
              `Changed lines in diff: ${changedLines}\n\n` +
              `Diff:\n${diff}`,
          },
        ],
        schema: QUIZ_SCHEMA,
      });
    }

    function gradeQuiz(diff, title, description, questions, answers) {
      const qa = questions
        .map((q) => `Q (${q.id}): ${q.question}\nA: ${answers[q.id] || '(no answer)'}`)
        .join('\n\n');
      return callClaude({
        system:
          'You are a lenient but honest code-review comprehension grader. Given a PR title, description, ' +
          'diff, and a reviewer\'s answers to questions about it, grade each answer against what the ' +
          'diff actually does. "pass" = shows real understanding of the specific logic being asked ' +
          'about, even if imperfectly worded. "weak" = on the right track - shows the reviewer engaged ' +
          'with the actual code, even if the answer is incomplete, partially wrong, vague, or hedged. ' +
          '"fail" = shows no real engagement with the actual change - e.g. empty, off-topic, or ' +
          'contradicted by what the diff actually does. Give the reviewer the benefit of the doubt: ' +
          'if an answer is plausible and shows they looked at the diff, prefer "weak" over "fail". ' +
          'overall_pass is true as long as no answer is "fail" - "weak" answers do not block ' +
          'overall_pass, since the goal is a comprehension nudge, not a perfect score. ' +
          'For every "weak" or "fail" verdict, the feedback must explain what is wrong or missing in ' +
          'their answer (e.g. which case they overlooked, what actually happens vs. what they said) - ' +
          'but must NOT state the correct answer outright. The reviewer must go back to the diff and ' +
          'work it out themselves; do not hand them the answer to copy in on a retry.',
        messages: [
          {
            role: 'user',
            content:
              `PR title: ${title}\n\n` +
              (description ? `PR description:\n${description}\n\n` : '') +
              `Diff:\n${diff}\n\nQuestions and answers:\n${qa}`,
          },
        ],
        schema: GRADE_SCHEMA,
      });
    }

    // -------------------------------------------------------------------
    // Modal UI (closed Shadow DOM)
    // -------------------------------------------------------------------

    const STYLE = `
      :host { all: initial; color-scheme: light; }
      .overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        z-index: 2147483647; display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      }
      .card {
        background: #ffffff; color: #1f2328; width: 560px; max-width: 92vw;
        max-height: 86vh; overflow-y: auto; border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.35);
        padding: 24px 28px 20px;
      }
      .eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
        color: #656d76; font-weight: 600; margin: 0 0 4px; }
      .title { font-size: 17px; font-weight: 600; margin: 0 0 18px; line-height: 1.35; }
      .dots { display: flex; gap: 6px; margin-bottom: 18px; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #d0d7de; transition: background .2s; }
      .dot.active { background: #1f883d; }
      .dot.done { background: #57606a; }
      .question { font-size: 15px; font-weight: 500; margin: 0 0 10px; line-height: 1.4; }
      textarea {
        width: 100%; box-sizing: border-box; min-height: 96px; resize: vertical;
        border: 1px solid #d0d7de; border-radius: 8px; padding: 10px 12px;
        font-size: 14px; font-family: inherit; line-height: 1.45;
        background-color: #ffffff; color: #1f2328;
      }
      textarea::placeholder { color: #6e7781; }
      textarea:focus { outline: none; border-color: #1f883d; box-shadow: 0 0 0 3px rgba(31,136,61,0.15); }
      .row { display: flex; justify-content: space-between; align-items: center; margin-top: 18px; }
      .row-right { display: flex; gap: 8px; }
      button {
        font-family: inherit; font-size: 13px; font-weight: 600; border-radius: 6px;
        padding: 7px 14px; cursor: pointer; border: 1px solid transparent;
      }
      .btn-primary { background: #1f883d; color: #fff; }
      .btn-primary:hover { background: #1a7f37; }
      .btn-primary:disabled { background: #94d3a2; cursor: not-allowed; }
      .btn-secondary { background: #f6f8fa; color: #1f2328; border-color: #d0d7de; }
      .btn-secondary:hover { background: #eef1f4; }
      .btn-text { background: none; color: #656d76; }
      .btn-text:hover { color: #1f2328; }
      .loading { display: flex; align-items: center; gap: 10px; color: #656d76; font-size: 14px; padding: 12px 0; }
      .spinner { width: 16px; height: 16px; border: 2px solid #d0d7de; border-top-color: #1f883d;
        border-radius: 50%; animation: spin 0.7s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .error { color: #d1242f; font-size: 13px; margin-top: 10px; }
      .result-item { border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; font-size: 13px; }
      .result-item.pass { background: #dafbe1; }
      .result-item.weak { background: #fff8c5; }
      .result-item.fail { background: #ffebe9; }
      .result-verdict { font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
      .result-question { font-weight: 600; margin: 4px 0 3px; }
      .result-feedback { color: #424a53; }
      .success { text-align: center; padding: 10px 0 4px; }
      .success-check {
        width: 44px; height: 44px; border-radius: 50%; background: #1f883d; color: #fff;
        display: flex; align-items: center; justify-content: center; margin: 0 auto 10px;
        font-size: 22px; animation: pop .25s ease-out;
      }
      @keyframes pop { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    `;

    function buildModal() {
      const host = document.createElement('div');
      host.id = 'pr-quiz-guard-host';
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = STYLE;
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      const card = document.createElement('div');
      card.className = 'card';
      overlay.appendChild(card);
      shadow.appendChild(style);
      shadow.appendChild(overlay);
      document.body.appendChild(host);

      // Closed shadow roots retarget event.target to the host <div> for listeners
      // outside the shadow tree. GitHub's own keyboard-shortcut handler (on document)
      // checks event.target to decide whether the user is typing in a field; with
      // retargeting it sees a <div>, not our <textarea>, and fires shortcuts like "t"
      // while the user types. Stop these events here so they never reach GitHub's
      // listeners at all — native typing/button behavior is untouched since we only
      // stop propagation, never preventDefault.
      ['keydown', 'keyup', 'keypress'].forEach((type) => {
        overlay.addEventListener(type, (e) => e.stopPropagation());
      });
      return { host, overlay, card };
    }

    function destroyModal(host) {
      host.remove();
    }

    function renderDots(card, total, currentIndex) {
      let dots = card.querySelector('.dots');
      if (!dots) {
        dots = document.createElement('div');
        dots.className = 'dots';
        card.appendChild(dots);
      }
      dots.innerHTML = '';
      for (let i = 0; i < total; i++) {
        const dot = document.createElement('div');
        dot.className = 'dot' + (i === currentIndex ? ' active' : i < currentIndex ? ' done' : '');
        dots.appendChild(dot);
      }
    }

    // Runs the whole quiz flow. Resolves true if the user passed, false if they cancelled.
    function runQuizFlow({ title, diff: knownDiff }) {
      return new Promise((resolveArg) => {
        quizModalOpen = true;
        const resolve = (v) => {
          quizModalOpen = false;
          resolveArg(v);
        };
        const { host, card } = buildModal();

        const eyebrow = document.createElement('p');
        eyebrow.className = 'eyebrow';
        eyebrow.textContent = 'PR Comprehension Check';
        const heading = document.createElement('p');
        heading.className = 'title';
        heading.textContent = title;
        card.appendChild(eyebrow);
        card.appendChild(heading);

        const body = document.createElement('div');
        card.appendChild(body);

        function showLoading(message) {
          body.innerHTML = '';
          const loading = document.createElement('div');
          loading.className = 'loading';
          loading.innerHTML = '<div class="spinner"></div><span>' + message + '</span>';
          body.appendChild(loading);
        }

        function showError(err, onRetry) {
          body.innerHTML = '';
          const p = document.createElement('div');
          p.className = 'error';
          p.textContent = err.message || String(err);
          body.appendChild(p);
          const row = document.createElement('div');
          row.className = 'row';
          const cancel = document.createElement('button');
          cancel.className = 'btn-text';
          cancel.textContent = 'Cancel';
          cancel.onclick = () => {
            destroyModal(host);
            resolve(false);
          };
          row.appendChild(document.createElement('span'));
          const rightWrap = document.createElement('div');
          rightWrap.className = 'row-right';
          if (onRetry) {
            const retry = document.createElement('button');
            retry.className = 'btn-primary';
            retry.textContent = 'Retry';
            retry.onclick = onRetry;
            rightWrap.appendChild(retry);
          }
          rightWrap.appendChild(cancel);
          row.appendChild(rightWrap);
          body.appendChild(row);
        }

        let diff, description, questions;
        let currentIndex = 0;
        const answers = {};

        function start() {
          showLoading('Reading the diff and description and writing your quiz…');
          Promise.all([knownDiff ? Promise.resolve(knownDiff) : fetchDiff(), fetchPrDescription()])
            .then(([d, desc]) => {
              diff = d;
              description = desc;
              return generateQuiz(diff, title, description);
            })
            .then((quiz) => {
              questions = quiz.questions;
              currentIndex = 0;
              renderQuestion();
            })
            .catch((err) => showError(err, start));
        }

        function renderQuestion() {
          body.innerHTML = '';
          renderDots(body, questions.length, currentIndex);
          const q = questions[currentIndex];
          const qEl = document.createElement('p');
          qEl.className = 'question';
          qEl.textContent = q.question;
          const textarea = document.createElement('textarea');
          textarea.value = answers[q.id] || '';
          textarea.placeholder = 'Answer in your own words…';
          textarea.oninput = () => {
            answers[q.id] = textarea.value;
          };
          body.appendChild(qEl);
          body.appendChild(textarea);

          const row = document.createElement('div');
          row.className = 'row';
          const backBtn = document.createElement('button');
          backBtn.className = 'btn-secondary';
          backBtn.textContent = 'Back';
          backBtn.disabled = currentIndex === 0;
          backBtn.onclick = () => {
            currentIndex -= 1;
            renderQuestion();
          };
          const rightWrap = document.createElement('div');
          rightWrap.className = 'row-right';
          const cancel = document.createElement('button');
          cancel.className = 'btn-text';
          cancel.textContent = 'Cancel';
          cancel.onclick = () => {
            destroyModal(host);
            resolve(false);
          };
          const nextBtn = document.createElement('button');
          nextBtn.className = 'btn-primary';
          nextBtn.textContent = currentIndex === questions.length - 1 ? 'Submit' : 'Next';
          nextBtn.onclick = () => {
            if (currentIndex === questions.length - 1) {
              submitAnswers();
            } else {
              currentIndex += 1;
              renderQuestion();
            }
          };
          rightWrap.appendChild(cancel);
          rightWrap.appendChild(nextBtn);
          row.appendChild(backBtn);
          row.appendChild(rightWrap);
          body.appendChild(row);
          textarea.focus();
        }

        function submitAnswers() {
          showLoading('Grading your answers against the diff…');
          gradeQuiz(diff, title, description, questions, answers)
            .then((grade) => {
              const hasFail = grade.per_question.some((r) => r.verdict === 'fail');
              if (!hasFail) {
                renderSuccess();
              } else {
                renderResults(grade);
              }
            })
            .catch((err) => showError(err, submitAnswers));
        }

        function renderResults(grade) {
          body.innerHTML = '';
          grade.per_question.forEach((r) => {
            const q = questions.find((qq) => qq.id === r.id);
            const item = document.createElement('div');
            item.className = 'result-item ' + r.verdict;
            const verdict = document.createElement('div');
            verdict.className = 'result-verdict';
            verdict.textContent = r.verdict;
            const question = document.createElement('div');
            question.className = 'result-question';
            question.textContent = q ? q.question : r.id;
            const feedback = document.createElement('div');
            feedback.className = 'result-feedback';
            feedback.textContent = r.feedback;
            item.appendChild(verdict);
            item.appendChild(question);
            item.appendChild(feedback);
            body.appendChild(item);
          });
          const row = document.createElement('div');
          row.className = 'row';
          const cancel = document.createElement('button');
          cancel.className = 'btn-text';
          cancel.textContent = 'Cancel';
          cancel.onclick = () => {
            destroyModal(host);
            resolve(false);
          };
          const revise = document.createElement('button');
          revise.className = 'btn-primary';
          revise.textContent = 'Revise answers';
          revise.onclick = () => {
            currentIndex = 0;
            renderQuestion();
          };
          row.appendChild(document.createElement('span'));
          const rightWrap = document.createElement('div');
          rightWrap.className = 'row-right';
          rightWrap.appendChild(cancel);
          rightWrap.appendChild(revise);
          row.appendChild(rightWrap);
          body.appendChild(row);
        }

        function renderSuccess() {
          body.innerHTML = '';
          const success = document.createElement('div');
          success.className = 'success';
          success.innerHTML = '<div class="success-check">✓</div><div>Nice — you clearly understood this one.</div>';
          body.appendChild(success);
          markPassedCache(fnv1aHash(diff));
          setTimeout(() => {
            destroyModal(host);
            resolve(true);
          }, 700);
        }

        start();
      });
    }

    // -------------------------------------------------------------------
    // Interception
    // -------------------------------------------------------------------

    let bypass = false;
    let quizModalOpen = false;

    // GitHub's review UI (as of 2026) is a React dialog (role="dialog") with no
    // wrapping <form> — radios are name="reviewEvent", values "comment" / "approve" /
    // "request changes", and the submit button is a plain type="button". Detect the
    // review panel by its dialog role rather than by (nonexistent) form structure.
    function findApproveDialog(target) {
      const dialog = target.closest('[role="dialog"]');
      if (!dialog) return null;
      const checked = dialog.querySelector('input[type=radio]:checked');
      if (checked && /approve/i.test(checked.value)) return dialog;
      return null;
    }

    function findSubmitButtonIn(dialog) {
      return Array.from(dialog.querySelectorAll('button')).find((b) =>
        /submit review/i.test(b.textContent)
      );
    }

    // Any currently-open review dialog with "Approve" selected, regardless of how
    // the user is about to submit it (click or keyboard shortcut).
    function findOpenApproveDialog() {
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        const checked = dialog.querySelector('input[type=radio]:checked');
        if (checked && /approve/i.test(checked.value)) return dialog;
      }
      return null;
    }

    function handleApproveSubmission(submitButton) {
      const title = getPrTitle();
      (async () => {
        let diff = null;
        try {
          diff = await fetchDiff();
          if (hasPassedCache(fnv1aHash(diff))) {
            reclick(submitButton);
            return;
          }
        } catch (e) {
          // fall through to the full quiz flow, which will surface the fetch error itself
        }
        const passed = await runQuizFlow({ title, diff });
        if (passed) {
          reclick(submitButton);
        }
      })();
    }

    document.addEventListener(
      'click',
      (event) => {
        if (bypass || quizModalOpen) return;
        const target = event.target.closest('button, input[type=submit]');
        if (!target) return;
        // Match GitHub's "Submit review" button text as a secondary signal.
        const label = (target.value || target.textContent || '').trim();
        if (!/submit review/i.test(label)) return;

        const dialog = findApproveDialog(target);
        if (!dialog) return; // not an approve submission — let it through untouched

        event.preventDefault();
        event.stopImmediatePropagation();
        handleApproveSubmission(target);
      },
      true // capture phase — run before GitHub's own listeners
    );

    // GitHub's "Submit review" button advertises a ⌘/Ctrl+Enter shortcut. That
    // shortcut submits the review without ever dispatching a click on the button,
    // so it needs its own interception path.
    document.addEventListener(
      'keydown',
      (event) => {
        if (bypass || quizModalOpen) return;
        const isSubmitShortcut = (event.metaKey || event.ctrlKey) && event.key === 'Enter';
        if (!isSubmitShortcut) return;

        const dialog = findOpenApproveDialog();
        if (!dialog) return; // no open review dialog with Approve selected

        const submitButton = findSubmitButtonIn(dialog);
        if (!submitButton) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        handleApproveSubmission(submitButton);
      },
      true // capture phase — run before GitHub's own listeners
    );

    function reclick(target) {
      bypass = true;
      target.click();
      // Reset shortly after; form submission/navigation will have already been triggered.
      setTimeout(() => {
        bypass = false;
      }, 500);
    }
  }

  global.PRQuizGuardCore = { init: init };
})(typeof window !== 'undefined' ? window : this);

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
