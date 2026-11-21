'use strict';

/* Run with: node --test */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('../tools/load-core');
const { playGame } = require('../tools/arena');

const core = loadCore();
const { CONFIG, NEUTRAL, WATER, Prng, MapGen, Combat, Rules, AI, Lang } = core;
const R = CONFIG.rules;
const MAP_SEEDS = 2000;

/* ── helpers ─────────────────────────────────────────────────────────── */

const newGame = (seed = 'TEST', firstPlayer = 0) => Rules.createGame({ seed, firstPlayer }).state;
const apply = (state, action) => Rules.applyAction(state, action).state;

/** A copy of the state with some tiles and fields overwritten. */
function withBoard(state, tiles = {}, fields = {}) {
  const owner = state.owner.slice();
  const units = state.units.slice();
  for (const [tile, [tileOwner, tileUnits]] of Object.entries(tiles)) {
    owner[tile] = tileOwner;
    units[tile] = tileUnits;
  }
  return { ...state, owner, units, ...fields };
}

/** A game in the action phase of player 0, who also owns `friend` next to the capital. */
function actionSetup(seed = 'TEST') {
  const state = newGame(seed);
  const capital = state.map.capitals[0];
  const [friend, target] = state.map.adj[capital];
  const ready = withBoard(state, { [capital]: [0, 8], [friend]: [0, 3], [target]: [NEUTRAL, 2] },
    { phase: 'action', reinforcements: 0 });
  return { state: ready, capital, friend, target };
}

/** The same state with a dice stream on which the given attack ends as wanted. */
function withDiceFor(state, action, wantConquest) {
  for (let rng = 1; rng < 5000; rng++) {
    const candidate = { ...state, rng };
    const combat = Rules.applyAction(candidate, action).events.find((e) => e.type === 'combat');
    if (combat.conquered === wantConquest) return candidate;
  }
  throw new Error('no suitable dice found');
}

const illegal = (state, action, reason) => {
  assert.match(Rules.validate(state, action) ?? '', reason);
  assert.throws(() => Rules.applyAction(state, action), /Illegal action/);
};

/* ── random numbers ──────────────────────────────────────────────────── */

test('prng: same seed gives the same stream, values stay in range', () => {
  const a = Prng.create(Prng.hash('abc'));
  const b = Prng.create(Prng.hash('abc'));
  const c = Prng.create(Prng.hash('abd'));
  const fromA = Array.from({ length: 50 }, () => a.next());
  assert.deepEqual(fromA, Array.from({ length: 50 }, () => b.next()));
  assert.notDeepEqual(fromA, Array.from({ length: 50 }, () => c.next()));

  const faces = new Array(6).fill(0);
  for (let i = 0; i < 60000; i++) faces[a.int(6)]++;
  faces.forEach((hits) => assert.ok(Math.abs(hits - 10000) < 500, `die face count ${hits}`));
});

test('prng: a generator resumes from its stored state', () => {
  const a = Prng.create(123);
  a.next();
  const resumed = Prng.create(a.state);
  assert.equal(a.next(), resumed.next());
});

/* ── map ─────────────────────────────────────────────────────────────── */

test(`map: ${MAP_SEEDS} seeds give connected land, about 15% water and fair starts`, () => {
  const waterCounts = new Set();
  for (let n = 0; n < MAP_SEEDS; n++) {
    const map = MapGen.generate(`SEED${n}`);
    const [home, away] = map.capitals;
    assert.equal(map.count, 91);

    const water = map.water.reduce((sum, wet) => sum + wet, 0);
    waterCounts.add(water);
    assert.ok(water >= 12 && water <= 15, `seed ${n}: ${water} water tiles`);
    assert.equal(map.landCount, 91 - water);
    assert.ok(MapGen.landIsConnected(map, home), `seed ${n}: land is not connected`);

    assert.ok(!map.water[home] && !map.water[away]);
    assert.equal(map.mirror[home], away, 'capitals are opposite each other');
    assert.ok(map.r[home] > 0 || (map.r[home] === 0 && map.q[home] < 0), 'player 0 starts in the lower half');
    assert.equal(map.adj[home].length, map.neighbors[home].length, 'no water next to a capital');

    for (let i = 0; i < map.count; i++) {
      assert.equal(map.water[i], map.water[map.mirror[i]], 'water is symmetric');
      assert.equal(map.garrison[i], map.garrison[map.mirror[i]], 'garrisons are symmetric');
      if (map.water[i]) {
        assert.equal(map.adj[i].length, 0);
      } else if (i !== home && i !== away) {
        assert.ok(map.garrison[i] >= 1 && map.garrison[i] <= 3, `neutral garrison ${map.garrison[i]}`);
      }
      assert.ok(map.adj[i].every((n) => !map.water[n] && map.adj[n].includes(i)));
    }
  }
  assert.deepEqual([...waterCounts], [14], 'every map has exactly 14 of 91 tiles under water');
});

test('map: the same seed always gives the same map, seeds are normalised', () => {
  const a = MapGen.generate('otok 7');
  const b = MapGen.generate('OTOK7');
  assert.equal(a.seed, 'OTOK7');
  assert.deepEqual(a.water, b.water);
  assert.deepEqual(a.garrison, b.garrison);
  assert.deepEqual(a.capitals, b.capitals);
  assert.notDeepEqual(a.water, MapGen.generate('OTOK8').water);
});

test('setup: capitals hold 5 units, neutral tiles 1 to 3, the opening income is 2', () => {
  const state = newGame('SETUP');
  const { map } = state;
  assert.equal(state.owner[map.capitals[0]], 0);
  assert.equal(state.owner[map.capitals[1]], 1);
  for (let i = 0; i < map.count; i++) {
    if (map.water[i]) {
      assert.equal(state.owner[i], WATER);
      assert.equal(state.units[i], 0);
    } else if (map.capitals.includes(i)) {
      assert.equal(state.units[i], R.capitalUnits);
    } else {
      assert.equal(state.owner[i], NEUTRAL);
      assert.ok(state.units[i] >= 1 && state.units[i] <= 3);
    }
  }
  assert.equal(state.phase, 'reinforce');
  assert.equal(state.reinforcements, 2);
  assert.equal(state.round, 1);
});

/* ── combat ──────────────────────────────────────────────────────────── */

test('combat: round odds are 15/36, and 10/36 against a capital', () => {
  assert.equal(Combat.roundOdds(false), 15 / 36);
  assert.equal(Combat.roundOdds(true), 10 / 36);
});

test('combat: win probability matches hand-computed and brute-force values', () => {
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);
  const p = 15 / 36;
  close(Combat.winProbability(1, 1, false), p);
  close(Combat.winProbability(2, 1, false), 1 - (1 - p) ** 2);
  close(Combat.winProbability(1, 2, false), p ** 2);
  close(Combat.winProbability(1, 1, true), 10 / 36);
  assert.equal(Combat.winProbability(3, 0, false), 1);
  assert.equal(Combat.winProbability(0, 3, false), 0);

  // Independent check: a fight of a vs d is won when d round wins come before a round losses.
  const choose = (n, k) => { let c = 1; for (let i = 1; i <= k; i++) c = c * (n - k + i) / i; return c; };
  for (const capital of [false, true]) {
    const win = Combat.roundOdds(capital);
    for (let a = 1; a <= 11; a++) {
      for (let d = 1; d <= 12; d++) {
        let expected = 0;
        for (let lost = 0; lost < a; lost++) expected += choose(d - 1 + lost, lost) * win ** d * (1 - win) ** lost;
        close(Combat.winProbability(a, d, capital), expected);
      }
    }
  }
});

test('combat: more attackers help, more defenders and a capital hurt', () => {
  for (let a = 1; a <= 11; a++) {
    for (let d = 1; d <= 12; d++) {
      const odds = Combat.winProbability(a, d, false);
      assert.ok(odds > 0 && odds < 1);
      assert.ok(Combat.winProbability(a + 1, d, false) > odds);
      if (d < 12) assert.ok(Combat.winProbability(a, d + 1, false) < odds);
      assert.ok(Combat.winProbability(a, d, true) < odds);
    }
  }
});

test('combat: every round removes one unit from the lower roll, ties go to the defender', () => {
  const rng = Prng.create(42);
  for (let fight = 0; fight < 3000; fight++) {
    const attackers = 1 + rng.int(11);
    const defenders = 1 + rng.int(12);
    const capital = fight % 3 === 0;
    const result = Combat.resolve(rng, attackers, defenders, capital);
    assert.ok((result.attackersLeft === 0) !== (result.defendersLeft === 0), 'exactly one side is wiped out');
    let attackerLosses = 0;
    for (const round of result.rounds) {
      assert.ok(round.attack >= 1 && round.attack <= 6 && round.defense >= 1 && round.defense <= 6);
      assert.equal(round.bonus, capital ? 1 : 0);
      assert.equal(round.attackerHit, round.attack <= round.defense + round.bonus);
      attackerLosses += round.attackerHit ? 1 : 0;
    }
    assert.equal(attackers - attackerLosses, result.attackersLeft);
    assert.equal(defenders - (result.rounds.length - attackerLosses), result.defendersLeft);
  }
});

test('combat: simulated fights agree with the exact probability', () => {
  const rng = Prng.create(7);
  const fights = 40000;
  for (const [attackers, defenders, capital] of [[5, 3, false], [3, 3, false], [11, 5, true], [8, 2, true]]) {
    let wins = 0;
    for (let i = 0; i < fights; i++) {
      if (Combat.resolve(rng, attackers, defenders, capital).attackersLeft > 0) wins++;
    }
    const exact = Combat.winProbability(attackers, defenders, capital);
    assert.ok(Math.abs(wins / fights - exact) < 0.01, `${attackers}v${defenders}: ${wins / fights} vs ${exact}`);
  }
});

/* ── reinforcements ──────────────────────────────────────────────────── */

test('reinforcements: income is 2 + floor(tiles / 3)', () => {
  const expected = { 1: 2, 2: 2, 3: 3, 5: 3, 6: 4, 9: 5, 30: 12, 77: 27 };
  for (const [tiles, income] of Object.entries(expected)) {
    assert.equal(Rules.incomeFor(Number(tiles)), income);
  }

  // A turn that starts with 7 tiles receives 4 units.
  const base = newGame('INCOME');
  const land = [...base.owner.keys()].filter((i) => base.owner[i] === NEUTRAL).slice(0, 6);
  const grown = withBoard(base, Object.fromEntries(land.map((i) => [i, [1, 1]])), {
    phase: 'action', reinforcements: 0,
  });
  const next = apply(grown, { type: 'endTurn' });
  assert.equal(next.current, 1);
  assert.equal(Rules.tileCount(next, 1), 7);
  assert.equal(next.reinforcements, 4);
  assert.equal(Rules.income(next, 1), 4);
});

test('reinforcements: only on own tiles, never above 12, actions wait until all are placed', () => {
  const state = newGame('PLACE');
  const capital = state.map.capitals[0];
  const neutral = state.map.adj[capital][0];

  illegal(state, { type: 'reinforce', tile: neutral, count: 1 }, /own tile/);
  illegal(state, { type: 'reinforce', tile: state.map.capitals[1], count: 1 }, /own tile/);
  illegal(state, { type: 'reinforce', tile: capital, count: 3 }, /not enough/);
  illegal(state, { type: 'reinforce', tile: capital, count: 0 }, /bad count/);
  illegal(state, { type: 'reinforce', tile: capital, count: 1.5 }, /bad count/);
  illegal(state, { type: 'endTurn' }, /placed first/);
  illegal(state, { type: 'move', from: capital, to: neutral, count: 1 }, /action phase/);

  const one = apply(state, { type: 'reinforce', tile: capital, count: 1 });
  assert.equal(one.units[capital], 6);
  assert.equal(one.reinforcements, 1);
  assert.equal(one.phase, 'reinforce');
  const two = apply(one, { type: 'reinforce', tile: capital, count: 1 });
  assert.equal(two.phase, 'action');
  illegal(two, { type: 'reinforce', tile: capital, count: 1 }, /reinforcement phase/);

  const nearlyFull = withBoard(state, { [capital]: [0, 11] });
  illegal(nearlyFull, { type: 'reinforce', tile: capital, count: 2 }, /full/);
});

test('reinforcements: units that fit nowhere are lost instead of blocking the turn', () => {
  const base = newGame('FULL', 1);
  const capital = base.map.capitals[0];
  const waiting = withBoard(base, { [capital]: [0, 11] }, { phase: 'action', reinforcements: 0 });
  const next = apply(waiting, { type: 'endTurn' });
  assert.equal(next.current, 0);
  assert.equal(next.reinforcements, 1);

  const full = withBoard(base, { [capital]: [0, 12] }, { phase: 'action', reinforcements: 0 });
  const skipped = apply(full, { type: 'endTurn' });
  assert.equal(skipped.reinforcements, 0);
  assert.equal(skipped.phase, 'action');
});

/* ── movement ────────────────────────────────────────────────────────── */

test('movement: a tile needs 2 units, must leave 1 behind and reaches only adjacent land', () => {
  const { state, capital, friend, target } = actionSetup();
  const far = state.map.capitals[1];
  const water = state.map.water.indexOf(1);

  illegal(state, { type: 'move', from: capital, to: target, count: 8 }, /stay behind/);
  illegal(state, { type: 'move', from: capital, to: target, count: 0 }, /bad count/);
  illegal(state, { type: 'move', from: capital, to: far, count: 1 }, /adjacent/);
  illegal(state, { type: 'move', from: capital, to: water, count: 1 }, /adjacent/);
  illegal(state, { type: 'move', from: target, to: capital, count: 1 }, /own tile/);

  const single = withBoard(state, { [friend]: [0, 1] });
  illegal(single, { type: 'move', from: friend, to: capital, count: 1 }, /2 or more/);
  assert.equal(Rules.canAct(single, friend), false);
  assert.equal(Rules.canAct(state, friend), true);
  assert.equal(Rules.maxSend(state, capital, target), 7);
});

test('movement: no tile is adjacent to water or to a tile two steps away', () => {
  const { state } = actionSetup('ADJ');
  for (let from = 0; from < state.map.count; from++) {
    for (const to of state.map.adj[from]) {
      const distance = (Math.abs(state.map.q[from] - state.map.q[to])
        + Math.abs(state.map.r[from] - state.map.r[to])
        + Math.abs(state.map.q[from] + state.map.r[from] - state.map.q[to] - state.map.r[to])) / 2;
      assert.equal(distance, 1);
      assert.equal(state.map.water[to], 0);
    }
  }
});

test('movement: merging adds units up to 12 and locks the receiving tile for the turn', () => {
  const { state, capital, friend, target } = actionSetup();
  const merged = apply(state, { type: 'move', from: capital, to: friend, count: 5 });
  assert.equal(merged.units[capital], 3);
  assert.equal(merged.units[friend], 8);
  assert.equal(merged.locked[friend], 1);
  assert.equal(Rules.canAct(merged, friend), false);
  illegal(merged, { type: 'move', from: friend, to: target, count: 1 }, /already received/);
  assert.deepEqual(Rules.targets(merged, friend), []);

  // The sender is free to act again, and the lock is gone on the owner's next turn.
  assert.equal(Rules.canAct(merged, capital), true);
  let later = apply(merged, { type: 'endTurn' });
  while (later.current !== 0 || later.phase !== 'action') {
    later = apply(later, AI.chooseAction(later, 'easy'));
  }
  assert.equal(later.locked[friend], 0);

  const crowded = withBoard(state, { [friend]: [0, 10] });
  assert.equal(Rules.maxSend(crowded, capital, friend), 2);
  illegal(crowded, { type: 'move', from: capital, to: friend, count: 3 }, /full/);
  const full = withBoard(state, { [friend]: [0, 12] });
  assert.ok(!Rules.targets(full, capital).some((t) => t.tile === friend), 'a full tile is not a target');
});

test('movement: targets list attacks and merges with the right limits', () => {
  const { state, capital, friend, target } = actionSetup();
  const targets = Rules.targets(state, capital);
  assert.equal(targets.length, state.map.adj[capital].length);
  assert.deepEqual(targets.find((t) => t.tile === friend), { tile: friend, kind: 'merge', max: 7 });
  assert.deepEqual(targets.find((t) => t.tile === target), { tile: target, kind: 'attack', max: 7 });
  assert.equal(Rules.winOdds(state, capital, target, 7), Combat.winProbability(7, 2, false));
});

test('attack: a won fight moves the survivors in and locks the tile', () => {
  const { state, capital, target } = actionSetup();
  const action = { type: 'move', from: capital, to: target, count: 6 };
  const { state: after, events } = Rules.applyAction(withDiceFor(state, action, true), action);
  const combat = events.find((e) => e.type === 'combat');
  const attackerLosses = combat.rounds.filter((round) => round.attackerHit).length;

  assert.equal(after.owner[target], 0);
  assert.equal(after.units[target], 6 - attackerLosses);
  assert.equal(combat.survivors, after.units[target]);
  assert.equal(after.units[capital], 2);
  assert.equal(after.locked[target], 1);
  assert.equal(Rules.canAct(after, target), false);
  assert.equal(after.stats[0].attacks, 1);
  assert.equal(after.stats[0].conquests, 1);
  assert.equal(after.stats[0].unitsLost, attackerLosses);
  assert.equal(after.stats[0].unitsDestroyed, 2);
  assert.equal(after.result, null);
});

test('attack: a lost fight costs every unit sent and leaves the tile with its defenders', () => {
  const { state, capital, target } = actionSetup();
  const action = { type: 'move', from: capital, to: target, count: 2 };
  const { state: after, events } = Rules.applyAction(withDiceFor(state, action, false), action);
  const combat = events.find((e) => e.type === 'combat');

  assert.equal(after.owner[target], NEUTRAL);
  assert.ok(after.units[target] >= 1 && after.units[target] <= 2);
  assert.equal(combat.survivors, after.units[target]);
  assert.equal(after.units[capital], 6);
  assert.equal(after.locked[target], 0);
  assert.equal(after.stats[0].conquests, 0);
  assert.equal(after.stats[0].unitsLost, 2);
});

test('attack: a capital defends with +1, any other tile of its owner does not', () => {
  const base = newGame('BONUS');
  const enemyCapital = base.map.capitals[1];
  const [attackerTile] = base.map.adj[enemyCapital];
  const plainTile = base.map.adj[attackerTile].find((n) => n !== enemyCapital);
  const state = withBoard(base, { [attackerTile]: [0, 9], [plainTile]: [1, 3] }, { phase: 'action', reinforcements: 0 });

  const onCapital = Rules.applyAction(state, { type: 'move', from: attackerTile, to: enemyCapital, count: 8 });
  assert.ok(onCapital.events[0].capital);
  assert.ok(onCapital.events[0].rounds.every((round) => round.bonus === 1));
  const onPlain = Rules.applyAction(state, { type: 'move', from: attackerTile, to: plainTile, count: 8 });
  assert.ok(!onPlain.events[0].capital);
  assert.ok(onPlain.events[0].rounds.every((round) => round.bonus === 0));
  assert.equal(Rules.winOdds(state, attackerTile, enemyCapital, 8), Combat.winProbability(8, 5, true));
});

test('rules: applying an action never changes the state it was given', () => {
  const { state, capital, target } = actionSetup();
  const snapshot = JSON.stringify([state.owner, state.units, state.locked, state.stats, state.rng, state.step]);
  Rules.applyAction(state, { type: 'move', from: capital, to: target, count: 7 });
  Rules.applyAction(state, { type: 'endTurn' });
  AI.LEVELS.forEach((level) => AI.chooseAction(state, level));
  assert.equal(JSON.stringify([state.owner, state.units, state.locked, state.stats, state.rng, state.step]), snapshot);
});

/* ── victory ─────────────────────────────────────────────────────────── */

test('victory: taking the enemy capital wins at once', () => {
  const base = newGame('CROWN');
  const enemyCapital = base.map.capitals[1];
  const [attackerTile] = base.map.adj[enemyCapital];
  const state = withBoard(base, { [attackerTile]: [0, 12], [enemyCapital]: [1, 1] }, { phase: 'action', reinforcements: 0 });
  const action = { type: 'move', from: attackerTile, to: enemyCapital, count: 11 };
  const { state: after, events } = Rules.applyAction(withDiceFor(state, action, true), action);

  assert.deepEqual(after.result, { winner: 0, reason: 'capital' });
  assert.equal(after.phase, 'over');
  assert.deepEqual(events.at(-1), { type: 'over', winner: 0, reason: 'capital' });
  assert.deepEqual(after.history, [[1, 1], [3, 0]], 'the final position closes the territory history');
  illegal(after, { type: 'endTurn' }, /over/);
  assert.throws(() => AI.chooseAction(after, 'hard'));
});

test('victory: destroying the last enemy tile wins', () => {
  const base = newGame('LAST');
  const enemyCapital = base.map.capitals[1];
  const [lastTile] = base.map.adj[enemyCapital];
  const attackerTile = base.map.adj[lastTile].find((n) => n !== enemyCapital);
  // Artificial position: the enemy holds a single ordinary tile and no capital.
  const state = withBoard(base, {
    [enemyCapital]: [NEUTRAL, 3], [lastTile]: [1, 1], [attackerTile]: [0, 12],
  }, { phase: 'action', reinforcements: 0 });
  const action = { type: 'move', from: attackerTile, to: lastTile, count: 11 };
  const after = apply(withDiceFor(state, action, true), action);
  assert.deepEqual(after.result, { winner: 0, reason: 'elimination' });
});

test('victory: after 40 full rounds the side with more tiles wins, then more units, else a draw', () => {
  const base = newGame('LIMIT');
  const [spare] = base.map.adj[base.map.capitals[0]];
  const lastTurn = { phase: 'action', reinforcements: 0, round: R.maxRounds, current: 1 };

  const moreTiles = apply(withBoard(base, { [spare]: [1, 1] }, lastTurn), { type: 'endTurn' });
  assert.deepEqual(moreTiles.result, { winner: 1, reason: 'rounds' });
  assert.equal(moreTiles.round, R.maxRounds);
  assert.equal(moreTiles.history.length, 2);

  const moreUnits = apply(withBoard(base, { [base.map.capitals[0]]: [0, 6] }, lastTurn), { type: 'endTurn' });
  assert.deepEqual(moreUnits.result, { winner: 0, reason: 'rounds' });

  const level = apply(withBoard(base, {}, lastTurn), { type: 'endTurn' });
  assert.deepEqual(level.result, { winner: null, reason: 'rounds' });

  // The limit only applies once both sides have moved in round 40.
  const midRound = apply(withBoard(base, {}, { ...lastTurn, current: 0 }), { type: 'endTurn' });
  assert.equal(midRound.result, null);
  assert.equal(midRound.round, R.maxRounds);
  const earlier = apply(withBoard(base, {}, { ...lastTurn, round: R.maxRounds - 1 }), { type: 'endTurn' });
  assert.equal(earlier.result, null);
  assert.equal(earlier.round, R.maxRounds);
});

test('turns: the round counter advances after both sides have moved, whoever starts', () => {
  for (const firstPlayer of [0, 1]) {
    let state = newGame('ROUNDS', firstPlayer);
    assert.equal(state.current, firstPlayer);
    const endTurn = () => {
      while (state.phase === 'reinforce') state = apply(state, AI.chooseAction(state, 'easy'));
      state = apply(state, { type: 'endTurn' });
    };
    endTurn();
    assert.equal(state.round, 1);
    assert.equal(state.current, 1 - firstPlayer);
    endTurn();
    assert.equal(state.round, 2);
    assert.equal(state.current, firstPlayer);
  }
});

/* ── computer opponents ──────────────────────────────────────────────── */

test('ai: every level only ever chooses legal actions and finishes its games', () => {
  for (const levels of [['easy', 'normal'], ['normal', 'hard'], ['hard', 'easy']]) {
    for (let game = 0; game < 6; game++) {
      const { winner, reason, rounds, state } = playGame(core, { seed: `LEGAL${game}`, levels, firstPlayer: game % 2 });
      assert.ok(rounds <= R.maxRounds);
      assert.ok(['capital', 'elimination', 'rounds'].includes(reason));
      assert.ok(winner === 0 || winner === 1 || (winner === null && reason === 'rounds'));
      for (let i = 0; i < state.map.count; i++) {
        if (state.map.water[i]) continue;
        assert.ok(state.units[i] >= 1 && state.units[i] <= R.maxUnits, 'every land tile holds 1 to 12 units');
      }
    }
  }
});

test('ai: a game replays exactly from its seed', () => {
  const play = () => playGame(core, { seed: 'REPLAY', levels: ['hard', 'normal'], firstPlayer: 1 });
  const first = play();
  const second = play();
  assert.equal(first.actions, second.actions);
  assert.deepEqual(first.state.owner, second.state.owner);
  assert.deepEqual(first.state.units, second.state.units);
  assert.deepEqual(first.state.history, second.state.history);
  assert.equal(first.state.rng, second.state.rng);

  const other = playGame(core, { seed: 'REPLAY2', levels: ['hard', 'normal'], firstPlayer: 1 });
  assert.notDeepEqual(first.state.history, other.state.history);
});

test('ai: hard takes a capital that is there for the taking and guards its own', () => {
  const base = newGame('SNIPE');
  const [mine, theirs] = base.map.capitals;
  const [stack] = base.map.adj[theirs];
  const open = withBoard(base, { [stack]: [0, 12], [theirs]: [1, 1] }, { phase: 'action', reinforcements: 0 });
  assert.deepEqual(AI.chooseAction(open, 'hard'), { type: 'move', from: stack, to: theirs, count: 11 });

  const [besieger] = base.map.adj[mine];
  const threatened = withBoard(base, { [besieger]: [1, 12], [mine]: [0, 2] }, { reinforcements: 4 });
  assert.equal(AI.chooseAction(threatened, 'hard').tile, mine);
});

/* ── wording ─────────────────────────────────────────────────────────── */

test('language: nouns agree with their number', () => {
  const units = { 0: '0 jedinica', 1: '1 jedinica', 2: '2 jedinice', 4: '4 jedinice', 5: '5 jedinica',
    11: '11 jedinica', 12: '12 jedinica', 14: '14 jedinica', 21: '21 jedinica', 22: '22 jedinice',
    25: '25 jedinica', 101: '101 jedinica', 112: '112 jedinica' };
  for (const [n, text] of Object.entries(units)) assert.equal(Lang.units(Number(n)), text);
  assert.deepEqual([1, 3, 7, 21, 22].map((n) => Lang.noun('tile', n)), ['polje', 'polja', 'polja', 'polje', 'polja']);
  const rounds = ['krug', 'kruga', 'krugova'];
  assert.deepEqual([1, 2, 5, 21, 40].map((n) => Lang.plural(n, rounds)), ['krug', 'kruga', 'krugova', 'krug', 'krugova']);
});

test('language: percentages use a decimal comma and never claim false certainty', () => {
  assert.equal(Lang.percent(0.7843), '78,4 %');
  assert.equal(Lang.percent(15 / 36), '41,7 %');
  assert.equal(Lang.percent(0.99999), '99,9 %');
  assert.equal(Lang.percent(0.00001), '0,1 %');
  assert.equal(Lang.percent(1), '100 %');
  assert.equal(Lang.percent(0), '0 %');
});
