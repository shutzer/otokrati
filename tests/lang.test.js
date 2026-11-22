'use strict';

/*
 * Translations: every pack is complete and well formed, index.html carries
 * exactly what lang/ holds, and the game asks only for keys that exist,
 * while every key in lang/en.json is used somewhere.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadCore, INDEX_PATH } = require('../tools/load-core');
const { loadPacks, validate, block, embedded, SOURCE } = require('../tools/lang');

const { CONFIG, AI, Career, Lang } = loadCore();
const packs = loadPacks();
const html = fs.readFileSync(INDEX_PATH, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const keys = Object.keys(packs[SOURCE].strings);

/** Keys the page names literally: any quoted key in the script, L.noun/counted('kind'), data-i18n*="…". */
const literalKeys = () => {
  const found = new Set();
  // any quoted key in the script: L.t('a'), L.t(x ? 'a' : 'b'), L.list('a')
  for (const [, key] of script.matchAll(/'([a-z][\w.]*)'/g)) if (keys.includes(key)) found.add(key);
  for (const [, kind] of script.matchAll(/L\.noun\('(\w+)'/g)) found.add(`noun.${kind}`);
  for (const [, kind] of script.matchAll(/L\.counted\('(\w+)'/g)) found.add(`count.${kind}`);
  for (const [, key] of html.matchAll(/data-i18n(?:-title|-aria)?="([\w.]+)"/g)) found.add(key);
  return found;
};

/** Keys the page builds from ids: tricks, powers, badges, rivals, modes, outcomes, advanced options. */
const builtKeys = () => {
  const found = new Set();
  for (const id of Object.keys(CONFIG.tricks)) {
    for (const part of ['name', 'text', 'none']) found.add(`trick.${id}.${part}`);
    if (id !== 'lucky') found.add(`trick.${id}.aim`);
  }
  for (const id of Object.keys(CONFIG.perks.kinds)) for (const part of ['name', 'text']) found.add(`perk.${id}.${part}`);
  for (const id of Career.BADGES) for (const part of ['name', 'how']) found.add(`badge.${id}.${part}`);
  for (const level of AI.LEVELS) {
    for (const part of ['name', 'short', 'about', 'won', 'lost', 'drew', 'start', 'gain', 'loss', 'flop', 'cheer', 'trick']) found.add(`rival.${level}.${part}`);
  }
  for (const part of ['name', 'about']) found.add(`rival.friend.${part}`);
  for (const mode of ['adventure', 'classic']) found.add(`mode.${mode}.about`);
  for (const outcome of ['win', 'loss', 'draw']) found.add(`end.${outcome}`);
  for (const option of Object.keys(CONFIG.custom)) found.add(`custom.${option}`);
  return found;
};

test('lang: every pack is complete, well formed and carried by index.html as it is', () => {
  assert.deepEqual(validate(packs), []);
  assert.equal(embedded(html), block(packs), 'run node tools/lang.js');
  assert.equal(Object.keys(packs)[0], 'en');
});

test('lang: the game asks only for keys that exist, and every key is used', () => {
  const used = new Set([...literalKeys(), ...builtKeys()]);
  const missing = [...used].filter((key) => !keys.includes(key));
  assert.deepEqual(missing, [], 'keys the game uses but lang/en.json lacks');
  const unused = keys.filter((key) => !used.has(key));
  assert.deepEqual(unused, [], 'keys in lang/en.json the game never uses');
});

test('lang: every text with a count reads right for 0, 1, 2, 5 and 21 in every language', () => {
  for (const pack of Object.values(packs)) {
    const L = Lang.create(pack, packs.en);
    for (const [key, value] of Object.entries(pack.strings)) {
      if (typeof value === 'string' || Array.isArray(value)) continue;
      for (const n of [0, 1, 2, 5, 21]) {
        const text = L.t(key, { n, trick: 'X', name: 'X' });
        assert.ok(text && !/\{n\}/.test(text), `${pack.meta.code} ${key} n=${n}: ${text}`);
      }
    }
  }
});

test('lang: no text is left in the page outside the packs', () => {
  // Croatian letters in the script outside the lettering's own glyph table mean a forgotten text.
  const glyphTable = /^\s+[ČĆĐŠŽ]: \[/;
  const leftovers = script.split('\n').filter((line) => /[čćđšžČĆĐŠŽ]/.test(line) && !glyphTable.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.deepEqual(leftovers.filter((line) => !line.includes("for (const char of '")), []);
  const markup = html.slice(html.indexOf('<body>'), html.indexOf('<!-- lang:begin'));
  assert.ok(!/[čćđšžČĆĐŠŽ]/.test(markup), 'Croatian text in the markup');
});
