'use strict';

/*
 * Advanced options (CONFIG.custom): the code that carries them, and the
 * cores built for them. The default rules must give the very same game as
 * before; every value on offer must give maps and games that work.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('../tools/load-core');
const { playGame } = require('../tools/arena');

const core = loadCore();
const { CONFIG, Custom, createCore } = core;

const coreFor = (choices) => createCore(Custom.configFor(choices));

test('custom: the default rules have an empty code, changed ones a short one that reads back', () => {
  assert.equal(Custom.encode(Custom.DEFAULTS), '');
  assert.equal(Custom.encode({}), '');
  assert.ok(Custom.isDefault(null));
  const choices = { ...Custom.DEFAULTS, rounds: 20, size: 6, sea: 0.08, powers: false };
  const code = Custom.encode(choices);
  assert.equal(code, 'R20S6W8X0');
  assert.deepEqual(Custom.decode(code), choices);
  assert.deepEqual(Custom.decode(code.toLowerCase()), choices);
  for (const option of Custom.NAMES) {
    for (const value of CONFIG.custom[option].values) {
      const one = { ...Custom.DEFAULTS, [option]: value };
      assert.deepEqual(Custom.decode(Custom.encode(one)), one, `${option} = ${value}`);
    }
  }
});

test('custom: values not on offer and unknown letters fall back to the default', () => {
  assert.deepEqual(Custom.clean({ rounds: 21, size: 'big', nonsense: 1 }), Custom.DEFAULTS);
  assert.deepEqual(Custom.decode('R21Q5S9'), Custom.DEFAULTS);
  assert.deepEqual(Custom.decode('R30-junk'), { ...Custom.DEFAULTS, rounds: 30 });
});

test('custom: a map code splits into the seed and the rules after the dash', () => {
  assert.deepEqual(Custom.split('m4zath-r20s6'), { map: 'M4ZATH', rules: 'R20S6' });
  assert.deepEqual(Custom.split('M4ZATH'), { map: 'M4ZATH', rules: '' });
  assert.deepEqual(Custom.split(' m4 zath - r20 '), { map: 'M4ZATH', rules: 'R20' });
});

test('custom: the chosen rules land in the config, everything else stays', () => {
  const config = Custom.configFor({ rounds: 60, stack: 16, powers: false });
  assert.equal(config.rules.maxRounds, 60);
  assert.equal(config.rules.maxUnits, 16);
  assert.equal(config.perks.enabled, false);
  assert.equal(config.rules.incomeBase, CONFIG.rules.incomeBase);
  assert.deepEqual(config.ai, CONFIG.ai);
  assert.ok(Object.isFrozen(config.rules));
  assert.equal(CONFIG.rules.maxRounds, 40, 'CONFIG itself is untouched');
});

test('custom: a core built for the default rules plays exactly the game of the default core', () => {
  const fresh = createCore(Custom.configFor(Custom.DEFAULTS));
  for (const adventure of [false, true]) {
    const a = playGame(core, { seed: 'SAME1', levels: ['hard', 'normal'], adventure });
    const b = playGame(fresh, { seed: 'SAME1', levels: ['hard', 'normal'], adventure });
    assert.deepEqual([b.winner, b.rounds, b.actions], [a.winner, a.rounds, a.actions]);
    assert.deepEqual(Array.from(b.state.owner), Array.from(a.state.owner));
  }
});

test('custom: every value on offer gives connected maps and games that finish', () => {
  for (const option of Custom.NAMES) {
    for (const value of CONFIG.custom[option].values) {
      if (value === Custom.DEFAULTS[option]) continue;
      const choices = { ...Custom.DEFAULTS, [option]: value };
      const custom = coreFor(choices);
      for (let s = 0; s < 40; s++) {
        const map = custom.MapGen.generate(`C${s}`, { landmarks: s % 2 === 0 });
        assert.equal(map.radius, choices.size);
        const seen = new Set([map.capitals[0]]);
        const queue = [map.capitals[0]];
        while (queue.length) for (const next of map.adj[queue.shift()]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
        assert.equal(seen.size, map.landCount, `${option} = ${value}, seed C${s}: land is not connected`);
      }
      for (const adventure of [false, true]) {
        const game = playGame(custom, { seed: `G${option}`, levels: ['normal', 'easy'], adventure });
        assert.ok(game.rounds <= choices.rounds, `${option} = ${value}: ${game.rounds} rounds`);
        assert.ok(game.state.units.every((units) => units <= choices.stack), `${option} = ${value}: a tile over the limit`);
      }
    }
  }
});

test('custom: with powers off an adventure never offers one', () => {
  const custom = coreFor({ powers: false });
  for (let s = 0; s < 5; s++) {
    const game = playGame(custom, { seed: `P${s}`, levels: ['hard', 'normal'], adventure: true });
    assert.equal(game.state.perksOn, false);
    assert.deepEqual(game.state.perks.map((held) => held.length), [0, 0]);
  }
});

test('custom: rule values reach the game: capital garrison, reinforcements, round limit', () => {
  const custom = coreFor({ capital: 8, income: 3, perTiles: 2, rounds: 20 });
  const { state } = custom.Rules.createGame({ seed: 'RULES' });
  assert.equal(state.units[state.map.capitals[0]], 8);
  assert.equal(custom.Rules.income(state, 0), 3 + Math.floor(1 / 2));
  const game = playGame(custom, { seed: 'RULES', levels: ['easy', 'easy'] });
  assert.ok(game.rounds <= 20);
});
