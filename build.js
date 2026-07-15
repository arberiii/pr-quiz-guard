#!/usr/bin/env node
// Assembles the distributable files from shared/core.js:
//   - pr-quiz-guard.user.js  (Tampermonkey header + core.js + userscript/adapter.js)
//   - extension/core.js      (a copy, so the extension folder is a self-contained
//                              unpacked-extension directory with no path traversal)
//
// Run `node build.js` after editing shared/core.js.
'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;

const HEADER = `// ==UserScript==
// @name         PR Quiz Guard
// @namespace    https://github.com/
// @version      1.4.0
// @description  Blocks GitHub PR "Approve" until you pass a short comprehension quiz generated from the actual diff.
// @author       you
// @match        https://github.com/*/*/pull/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.anthropic.com
// @connect      api.mistral.ai
// @connect      text.pollinations.ai
// @connect      github.com
// @connect      patch-diff.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==
`;

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

const core = read('shared/core.js');
const adapter = read('userscript/adapter.js');

const userscript = HEADER + '\n' + core + '\n' + adapter;
fs.writeFileSync(path.join(root, 'pr-quiz-guard.user.js'), userscript);
console.log('wrote pr-quiz-guard.user.js');

fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
fs.writeFileSync(path.join(root, 'extension', 'core.js'), core);
console.log('wrote extension/core.js');
