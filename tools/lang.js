'use strict';

/*
 * Translations live in lang/<code>.json; the game carries them inside
 * index.html, because a page opened straight from disk may not load files.
 *
 *   node tools/lang.js           checks every pack and writes them into index.html
 *   node tools/lang.js --check   only checks, and fails if index.html is out of date
 *
 * English (lang/en.json) is the source: every other pack has exactly its keys,
 * the same kind of value for each (text, list, or plural forms), the same
 * {placeholders}, and every plural form its language needs for whole numbers.
 */

const fs = require('node:fs');
const path = require('node:path');
const { INDEX_PATH } = require('./load-core');

const LANG_DIR = path.join(__dirname, '..', 'lang');
const SOURCE = 'en';
const BEGIN = '<!-- lang:begin · written by tools/lang.js from lang/*.json, do not edit by hand -->';
const END = '<!-- lang:end -->';
const PLACEHOLDER = /\{(\w+)\}/g;

/*
 * Texts the game writes in its own hand-drawn lettering (Sketch in index.html):
 * on the board they must use only characters it can draw, and headings that
 * cannot be drawn fall back to plain type, which looks out of place.
 */
const LETTERED = ['fx.capital', 'fx.boom', 'fx.streak', 'fx.here', 'end.win', 'end.loss', 'end.draw', 'end.wins',
  'pick.title', 'help.title', 'leave.title', 'log.title', 'crew.title', 'rotate.title', 'banner.you', 'banner.rival', 'banner.duel'];
const LETTERING = /^(?:[A-Za-z0-9 !?.,:%+\-×'’¡¿\u00A0\u202FčćđšžČĆĐŠŽàáâãäçèéêëìíîïñòóôõöùúûüÿßÀÁÂÃÄÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜŸ]|\{\w+\})*$/u;

/** Every pack, English first and the rest by code. */
const loadPacks = () => {
  const codes = fs.readdirSync(LANG_DIR).filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5));
  codes.sort((a, b) => (a === SOURCE ? -1 : b === SOURCE ? 1 : a.localeCompare(b)));
  return Object.fromEntries(codes.map((code) => [code, JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${code}.json`), 'utf8'))]));
};

const kindOf = (value) => {
  if (typeof value === 'string') return 'text';
  if (Array.isArray(value)) return 'list';
  if (value && typeof value === 'object') return 'plural';
  return 'invalid';
};

const textsOf = (value) => (typeof value === 'string' ? [value] : Object.values(value));
const placeholders = (value) => new Set(textsOf(value).flatMap((text) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1])));
const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));

/** The plural categories a language uses for the whole numbers a game can show. */
const categoriesFor = (locale) => {
  const rules = new Intl.PluralRules(locale);
  return new Set(Array.from({ length: 1001 }, (_, n) => rules.select(n)));
};

/** All problems with the packs, as readable lines; an empty list means they are fine. */
const validate = (packs) => {
  const problems = [];
  const source = packs[SOURCE];
  if (!source) return [`lang/${SOURCE}.json is missing`];
  const keys = Object.keys(source.strings);

  for (const [code, pack] of Object.entries(packs)) {
    const where = `lang/${code}.json`;
    const { meta, strings } = pack;
    if (meta?.code !== code) problems.push(`${where}: meta.code must be "${code}"`);
    if (!meta?.locale || !meta?.name) problems.push(`${where}: meta needs locale and name`);
    if (!strings) { problems.push(`${where}: no strings`); continue; }
    const needed = categoriesFor(meta.locale ?? code);

    for (const key of keys) {
      if (!(key in strings)) { problems.push(`${where}: missing "${key}"`); continue; }
      const want = source.strings[key];
      const have = strings[key];
      const kind = kindOf(want);
      if (kindOf(have) !== kind) { problems.push(`${where}: "${key}" must be ${kind}`); continue; }
      if (kind === 'list') {
        if (have.length !== want.length) problems.push(`${where}: "${key}" must have ${want.length} items`);
        if (have.some((item) => typeof item !== 'string' || !item.trim())) problems.push(`${where}: "${key}" has an empty or non-text item`);
        continue;
      }
      if (kind === 'plural') {
        const forms = new Set(Object.keys(have));
        const missing = [...needed].filter((category) => !forms.has(category));
        const extra = [...forms].filter((category) => !needed.has(category));
        if (missing.length) problems.push(`${where}: "${key}" needs plural forms ${missing.join(', ')}`);
        if (extra.length) problems.push(`${where}: "${key}" has plural forms ${meta.locale} never uses: ${extra.join(', ')}`);
      }
      if (textsOf(have).some((text) => typeof text !== 'string' || !text.trim())) {
        problems.push(`${where}: "${key}" has an empty text`);
        continue;
      }
      if (LETTERED.includes(key) && !LETTERING.test(have)) problems.push(`${where}: "${key}" is hand-lettered and may use only letters, digits and ! ? . , : % + - × ' ¡ ¿`);
      const allowed = placeholders(want);
      const used = placeholders(have);
      if (code !== SOURCE && !sameSet(allowed, used)) {
        problems.push(`${where}: "${key}" must use {${[...allowed].join('}, {')}}, uses {${[...used].join('}, {')}}`);
      }
    }
    for (const key of Object.keys(strings)) if (!(key in source.strings)) problems.push(`${where}: "${key}" is not in lang/${SOURCE}.json`);
  }
  return problems;
};

/** The block index.html carries: one pack per line, safe inside a script element. */
const block = (packs) => {
  const lines = Object.entries(packs).map(([code, pack], i, all) => `${JSON.stringify(code)}:${JSON.stringify(pack)}${i < all.length - 1 ? ',' : ''}`);
  const json = `{\n${lines.join('\n')}\n}`.replace(/</g, '\\u003c');
  return `${BEGIN}\n<script type="application/json" id="lang-packs">\n${json}\n</script>\n${END}`;
};

const embedded = (html) => {
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END);
  if (start < 0 || end < start) return null;
  return html.slice(start, end + END.length);
};

const main = (argv) => {
  const packs = loadPacks();
  const problems = validate(packs);
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem(s) in lang/`);
    return 1;
  }
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const current = embedded(html);
  if (current === null) { console.error(`index.html has no ${BEGIN.split(' ·')[0]} … ${END} block`); return 1; }
  const wanted = block(packs);
  const summary = `${Object.keys(packs).length} languages (${Object.keys(packs).join(', ')}), ${Object.keys(packs[SOURCE].strings).length} keys each`;
  if (argv.includes('--check')) {
    if (current !== wanted) { console.error('index.html is out of date with lang/: run node tools/lang.js'); return 1; }
    console.log(`lang: ${summary}; index.html is up to date`);
    return 0;
  }
  if (current !== wanted) fs.writeFileSync(INDEX_PATH, html.replace(current, wanted));
  console.log(`lang: ${summary}; index.html ${current === wanted ? 'already up to date' : 'updated'}`);
  return 0;
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { loadPacks, validate, block, embedded, categoriesFor, SOURCE };
