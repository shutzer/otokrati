'use strict';

/*
 * Loads the game logic straight out of index.html, so tests and tools always
 * exercise the code that ships. The game itself never needs this file.
 */

const fs = require('node:fs');
const path = require('node:path');

const INDEX_PATH = path.join(__dirname, '..', 'index.html');

/**
 * @param {(source: string) => string} [patch] optional source rewrite, used by
 *   tools that try out different tuning values without editing index.html
 */
function loadCore(patch = (source) => source) {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new Error(`Expected one inline script in index.html, found ${scripts.length}`);
  const sandbox = { exports: {} };
  new Function('module', patch(scripts[0][1]))(sandbox);
  return sandbox.exports;
}

module.exports = { loadCore, INDEX_PATH };
