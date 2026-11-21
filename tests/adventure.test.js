'use strict';

/*
 * Run with: node --test
 * Covers what an adventure game adds to the classic rules: landmarks on the
 * map, pearls, tricks, and the career that carries over between games.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCore } = require('../tools/load-core');
const { playGame } = require('../tools/arena');

const core = loadCore();
const { CONFIG, NEUTRAL, FEATURE, MapGen, Combat, Rules, AI, Career } = core;
const R = CONFIG.rules;
const TRICKS = CONFIG.tricks;
const ALL_TRICKS = Object.keys(TRICKS);
const MAP_SEEDS = 1000;

/* ── helpers ─────────────────────────────────────────────────────────── */

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

/** An adventure game in player 0's action phase, with every trick and plenty of pearls. */
function adventure(seed = 'PUSTOLOVINA', fields = {}) {
  const { state } = Rules.createGame({ seed, landmarks: true, tricks: [ALL_TRICKS, ALL_TRICKS] });
  return { ...state, phase: 'action', reinforcements: 0, pearls: [20, 20], ...fields };
}

const tilesWith = (map, kind) => [...map.feature.keys()].filter((i) => map.feature[i] === kind);
const plainNeighbor = (state, tile) => state.map.adj[tile].find((n) => state.map.feature[n] === FEATURE.none
  && !state.map.capitals.includes(n));

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

/* ── map ─────────────────────────────────────────────────────────────── */

test(`landmarks: ${MAP_SEEDS} adventure maps are fair, complete and keep the classic land`, () => {
  const L = CONFIG.map.landmarks;
  let withLanes = 0;
  for (let n = 0; n < MAP_SEEDS; n++) {
    const map = MapGen.generate(`SEED${n}`, { landmarks: true });
    const classic = MapGen.generate(`SEED${n}`);
    assert.deepEqual(map.water, classic.water, 'same land as the classic map of that seed');
    assert.deepEqual(map.capitals, classic.capitals);

    assert.equal(tilesWith(map, FEATURE.tower).length, 2 * L.towerPairs);
    assert.equal(tilesWith(map, FEATURE.lighthouse).length, 2 * L.lighthousePairs);
    assert.equal(tilesWith(map, FEATURE.chest).length, 2 * L.chestPairs);

    for (let i = 0; i < map.count; i++) {
      assert.equal(map.feature[i], map.feature[map.mirror[i]], 'landmarks are symmetric');
      if (!map.feature[i]) continue;
      assert.ok(!map.water[i] && !map.capitals.includes(i));
      for (const capital of map.capitals) {
        assert.ok(!map.neighbors[capital].includes(i), 'no landmark right next to a capital');
      }
      if (map.feature[i] === FEATURE.tower || map.feature[i] === FEATURE.lighthouse) {
        assert.equal(map.garrison[i], L.guardedUnits);
      }
    }

    // Harbours come in lanes: one lane and its mirror image, or none where the coast has no room.
    const harbors = tilesWith(map, FEATURE.harbor);
    assert.deepEqual([...map.lanes.flat()].sort((a, b) => a - b), harbors);
    assert.ok(map.lanes.length === 0 || map.lanes.length === 2);
    for (const [a, b] of map.lanes) {
      const apart = (Math.abs(map.q[a] - map.q[b]) + Math.abs(map.r[a] - map.r[b])
        + Math.abs(map.q[a] + map.r[a] - map.q[b] - map.r[b])) / 2;
      assert.ok(apart >= L.laneLength[0] && apart <= L.laneLength[1], `lane of length ${apart}`);
      for (const harbor of [a, b]) {
        const ring = (Math.abs(map.q[harbor]) + Math.abs(map.r[harbor]) + Math.abs(map.q[harbor] + map.r[harbor])) / 2;
        assert.equal(ring, map.radius, 'harbours sit on the rim');
      }
      assert.ok(map.adj[a].includes(b) && map.adj[b].includes(a), 'a lane makes its harbours neighbours');
      assert.ok(map.lanes.some(([c, d]) => c === map.mirror[a] && d === map.mirror[b]), 'lanes are symmetric');
    }
    if (map.lanes.length) withLanes++;

    for (let i = 0; i < map.count; i++) {
      assert.ok(map.adj[i].every((t) => !map.water[t] && map.adj[t].includes(i)), 'adjacency is mutual');
    }
  }
  assert.ok(withLanes > MAP_SEEDS * 0.95, `only ${withLanes} of ${MAP_SEEDS} maps have sea lanes`);
});

/* ── landmarks in play ───────────────────────────────────────────────── */

test('lighthouse: every lighthouse held adds 1 to the income', () => {
  const state = adventure();
  const [beacon, other] = tilesWith(state.map, FEATURE.lighthouse);
  assert.equal(Rules.income(state, 0), 2);
  const one = withBoard(state, { [beacon]: [0, 3] });
  assert.equal(Rules.income(one, 0), 2 + R.lighthouseIncome);
  const both = withBoard(one, { [other]: [0, 3] });
  assert.equal(Rules.tileCount(both, 0), 3);
  assert.equal(Rules.income(both, 0), 3 + 2 * R.lighthouseIncome);
  assert.equal(Rules.income(both, 1), 2);

  // The extra units arrive with the next turn.
  const mine = withBoard(state, { [beacon]: [1, 3] });
  const next = apply(mine, { type: 'endTurn' });
  assert.equal(next.current, 1);
  assert.equal(next.reinforcements, 2 + R.lighthouseIncome);
});

test('tower: defends with +1 whoever holds it, even nobody', () => {
  const state = adventure();
  const [tower] = tilesWith(state.map, FEATURE.tower);
  const base = plainNeighbor(state, tower);
  for (const holder of [NEUTRAL, 1]) {
    const setup = withBoard(state, { [base]: [0, 9], [tower]: [holder, 3] });
    assert.equal(Rules.isFortified(setup, tower), true);
    assert.equal(Rules.winOdds(setup, tower, 8), Combat.winProbability(8, 3, 1));
    const { events } = Rules.applyAction(setup, { type: 'move', from: base, to: tower, count: 8 });
    assert.equal(events[0].defenseBonus, R.fortifiedBonus);
    assert.equal(events[0].capital, false);
    for (const round of events[0].rounds) assert.equal(round.attackerHit, round.attack <= round.defense + 1);
  }
  assert.equal(Rules.isFortified(state, base), false);
});

test('pearls: a conquest pays 1, a chest pays 3 more, and only once', () => {
  const state = adventure('BISERI', { pearls: [0, 0] });
  const [chest] = tilesWith(state.map, FEATURE.chest);
  const base = plainNeighbor(state, chest);
  const setup = withBoard(state, { [base]: [0, 12], [chest]: [NEUTRAL, 1] });
  assert.equal(setup.loot[chest], 1);

  const attack = { type: 'move', from: base, to: chest, count: 11 };
  const { state: after, events } = Rules.applyAction(withDiceFor(setup, attack, true), attack);
  assert.equal(events[0].chest, true);
  assert.equal(events[0].pearls, R.pearlsPerConquest + R.chestPearls);
  assert.deepEqual(after.pearls, [R.pearlsPerConquest + R.chestPearls, 0]);
  assert.equal(after.loot[chest], 0);
  assert.equal(after.stats[0].pearls, 4);

  // Taken back by the other side, the opened chest pays the plain pearl only.
  const retake = withBoard(after, { [base]: [1, 12], [chest]: [0, 1] }, { current: 1 });
  const back = { type: 'move', from: base, to: chest, count: 11 };
  const again = Rules.applyAction(withDiceFor(retake, back, true), back);
  assert.equal(again.events[0].chest, false);
  assert.equal(again.state.pearls[1], R.pearlsPerConquest);

  // A repelled attack pays nothing.
  const failed = Rules.applyAction(withDiceFor(setup, { ...attack, count: 1 }, false), { ...attack, count: 1 });
  assert.equal(failed.events[0].pearls, 0);
  assert.deepEqual(failed.state.pearls, [0, 0]);
  assert.equal(failed.state.loot[chest], 1);
});

test('sea lane: units sail between its two harbours as between neighbours', () => {
  const state = adventure();
  const [[port, far]] = state.map.lanes;
  const setup = withBoard(state, { [port]: [0, 6], [far]: [NEUTRAL, 1] });
  assert.ok(Rules.targets(setup, port).some((t) => t.tile === far && t.kind === 'attack' && t.max === 5));
  const attack = { type: 'move', from: port, to: far, count: 5 };
  const after = apply(withDiceFor(setup, attack, true), attack);
  assert.equal(after.owner[far], 0);

  const friendly = withBoard(state, { [port]: [0, 6], [far]: [0, 2] });
  const merged = apply(friendly, { type: 'move', from: port, to: far, count: 3 });
  assert.equal(merged.units[far], 5);
  assert.equal(merged.locked[far], 1);
});

/* ── tricks ──────────────────────────────────────────────────────────── */

test('tricks: need the action phase, the trick in hand, the pearls, and one per turn', () => {
  const state = adventure();
  const capital = state.map.capitals[0];
  const recruit = { type: 'trick', trick: 'recruit', tile: capital };

  illegal({ ...state, phase: 'reinforce', reinforcements: 2 }, recruit, /action phase/);
  illegal({ ...state, tricks: [['shield'], ALL_TRICKS] }, recruit, /not in hand/);
  illegal({ ...state, pearls: [TRICKS.recruit.cost - 1, 20] }, recruit, /not enough pearls/);
  illegal(state, { type: 'trick', trick: 'teleport', tile: capital }, /unknown trick/);
  illegal(state, { type: 'trick', trick: 'recruit', tile: state.map.capitals[1] }, /cannot be played on that tile/);

  const after = apply(state, recruit);
  assert.equal(after.pearls[0], 20 - TRICKS.recruit.cost);
  assert.equal(after.stats[0].tricks, 1);
  illegal(after, { type: 'trick', trick: 'lucky' }, /already played/);
  assert.equal(Rules.canPlay(after, 'lucky'), false);

  // The limit is per turn: the next turn of the same player allows a trick again.
  let later = apply(after, { type: 'endTurn' });
  while (later.current !== 0 || later.phase !== 'action') later = apply(later, AI.chooseAction(later, 'easy'));
  assert.equal(later.tricksPlayed, 0);
  assert.equal(Rules.canPlay(later, 'lucky'), true);

  const classic = Rules.createGame({ seed: 'KLASIKA' }).state;
  illegal({ ...classic, phase: 'action', reinforcements: 0, pearls: [20, 20] }, recruit, /not in hand/);
});

test('trick recruit: 3 units appear on an own tile, never beyond 12', () => {
  const state = adventure();
  const capital = state.map.capitals[0];
  const { state: after, events } = Rules.applyAction(state, { type: 'trick', trick: 'recruit', tile: capital });
  assert.equal(after.units[capital], R.capitalUnits + TRICKS.recruit.units);
  assert.deepEqual(events, [{ type: 'trick', player: 0, trick: 'recruit', tile: capital, amount: 3 }]);

  const crowded = withBoard(state, { [capital]: [0, 11] });
  assert.equal(apply(crowded, { type: 'trick', trick: 'recruit', tile: capital }).units[capital], 12);
  const full = withBoard(state, { [capital]: [0, 12] });
  illegal(full, { type: 'trick', trick: 'recruit', tile: capital }, /no tile to play it on/);
});

test('trick shield: the tile defends with +1 until its owner moves again', () => {
  const state = adventure();
  const capital = state.map.capitals[0];
  const outpost = plainNeighbor(state, capital);
  const setup = withBoard(state, { [outpost]: [0, 2] });
  illegal(setup, { type: 'trick', trick: 'shield', tile: capital }, /cannot be played on that tile/);

  const shielded = apply(setup, { type: 'trick', trick: 'shield', tile: outpost });
  assert.equal(shielded.shield[outpost], 1);
  assert.equal(Rules.isFortified(shielded, outpost), true);
  assert.ok(!Rules.trickTargets(shielded, 'shield').includes(outpost), 'no shield on a shield');

  // It holds through the opponent's turn ...
  const theirs = apply(shielded, { type: 'endTurn' });
  assert.equal(theirs.current, 1);
  assert.equal(theirs.shield[outpost], 1);
  const attacker = theirs.map.adj[outpost].find((n) => n !== capital);
  const siege = withBoard(theirs, { [attacker]: [1, 9] }, { phase: 'action', reinforcements: 0 });
  assert.equal(Rules.winOdds(siege, outpost, 8), Combat.winProbability(8, 2, 1));
  assert.ok(!Rules.trickTargets(siege, 'cannon').includes(outpost), 'a cannon cannot breach a shield');

  // ... and is gone when its owner's next turn begins.
  const mineAgain = apply(siege, { type: 'endTurn' });
  assert.equal(mineAgain.current, 0);
  assert.equal(mineAgain.shield[outpost], 0);

  // A conquered tile loses its shield at once.
  const storm = { type: 'move', from: attacker, to: outpost, count: 8 };
  const fallen = apply(withDiceFor(siege, storm, true), storm);
  assert.equal(fallen.shield[outpost], 0);
});

test('trick cannon: an unfortified tile next to ours loses 2 units, one always stays', () => {
  const state = adventure();
  const capital = state.map.capitals[0];
  const [near, other] = state.map.adj[capital].filter((n) => state.map.feature[n] === FEATURE.none);
  const setup = withBoard(state, { [near]: [NEUTRAL, 3], [other]: [NEUTRAL, 2] });
  const [tower] = tilesWith(state.map, FEATURE.tower);
  const outOfReach = state.map.capitals[1];

  const targets = Rules.trickTargets(setup, 'cannon');
  assert.ok(targets.includes(near) && targets.includes(other));
  assert.ok(targets.every((t) => setup.owner[t] !== 0 && setup.units[t] >= 2 && !Rules.isFortified(setup, t)));
  assert.ok(targets.every((t) => setup.map.adj[t].some((n) => setup.owner[n] === 0)), 'only tiles next to ours');
  illegal(setup, { type: 'trick', trick: 'cannon', tile: outOfReach }, /cannot be played on that tile/);
  illegal(setup, { type: 'trick', trick: 'cannon', tile: tower }, /cannot be played on that tile/);

  const { state: hit, events } = Rules.applyAction(setup, { type: 'trick', trick: 'cannon', tile: near });
  assert.equal(hit.units[near], 1);
  assert.equal(events[0].amount, 2);
  assert.equal(events[0].from, capital);
  assert.equal(hit.owner[near], NEUTRAL, 'a cannon never conquers');
  assert.equal(hit.stats[0].unitsDestroyed, 2);

  const light = Rules.applyAction(setup, { type: 'trick', trick: 'cannon', tile: other });
  assert.equal(light.state.units[other], 1);
  assert.equal(light.events[0].amount, 1);
  const single = withBoard(setup, { [near]: [NEUTRAL, 1] });
  assert.ok(!Rules.trickTargets(single, 'cannon').includes(near));
});

test('trick lucky die: the next attack of the turn rolls with +1, and only that one', () => {
  const state = adventure();
  const capital = state.map.capitals[0];
  const [first, second] = state.map.adj[capital].filter((n) => state.map.feature[n] === FEATURE.none);
  const setup = withBoard(state, { [capital]: [0, 12], [first]: [NEUTRAL, 3], [second]: [NEUTRAL, 3] });
  assert.equal(Combat.roundOdds(-1), 21 / 36);

  const lucky = apply(setup, { type: 'trick', trick: 'lucky' });
  assert.equal(lucky.lucky, true);
  assert.equal(Rules.winOdds(lucky, first, 4), Combat.winProbability(4, 3, -1));
  assert.ok(Rules.winOdds(lucky, first, 4) > Rules.winOdds(setup, first, 4));

  const fight = Rules.applyAction(lucky, { type: 'move', from: capital, to: first, count: 4 });
  assert.equal(fight.events[0].attackBonus, TRICKS.lucky.bonus);
  assert.equal(fight.events[0].odds, Combat.winProbability(4, 3, -1));
  for (const round of fight.events[0].rounds) assert.equal(round.attackerHit, round.attack + 1 <= round.defense);
  assert.equal(fight.state.lucky, false);
  assert.equal(Rules.winOdds(fight.state, second, 4), Combat.winProbability(4, 3, 0));

  // Unused luck does not carry over to the next turn.
  let later = apply(lucky, { type: 'endTurn' });
  assert.equal(later.lucky, false);
  while (later.current !== 0 || later.phase !== 'action') later = apply(later, AI.chooseAction(later, 'easy'));
  assert.equal(later.lucky, false);

  // Against a fortified tile luck and walls cancel out.
  const enemyCapital = state.map.capitals[1];
  assert.equal(Rules.winOdds(lucky, enemyCapital, 5), Combat.winProbability(5, 5, 0));
});

test('trick second wind: a resting tile may act again this turn', () => {
  const state = adventure();
  const capital = state.map.capitals[0];
  const friend = plainNeighbor(state, capital);
  const setup = withBoard(state, { [capital]: [0, 9], [friend]: [0, 1] });
  assert.deepEqual(Rules.trickTargets(setup, 'wind'), []);
  illegal(setup, { type: 'trick', trick: 'wind', tile: friend }, /no tile to play it on/);

  const merged = apply(setup, { type: 'move', from: capital, to: friend, count: 4 });
  assert.equal(Rules.canAct(merged, friend), false);
  assert.deepEqual(Rules.trickTargets(merged, 'wind'), [friend]);
  const fresh = apply(merged, { type: 'trick', trick: 'wind', tile: friend });
  assert.equal(fresh.locked[friend], 0);
  assert.equal(Rules.canAct(fresh, friend), true);
  assert.ok(Rules.targets(fresh, friend).length > 0);
});

/* ── computer opponents ──────────────────────────────────────────────── */

test('ai: adventure games finish legally, with tricks played by those who have them', () => {
  const played = { easy: 0, normal: 0, hard: 0 };
  for (const levels of [['easy', 'normal'], ['normal', 'hard'], ['hard', 'easy'], ['hard', 'hard']]) {
    for (let game = 0; game < 5; game++) {
      const { winner, reason, rounds, state } = playGame(core, {
        seed: `PUT${game}`, levels, firstPlayer: game % 2, adventure: true,
      });
      assert.ok(rounds <= R.maxRounds);
      assert.ok(winner === 0 || winner === 1 || (winner === null && reason === 'rounds'));
      levels.forEach((level, player) => {
        played[level] += state.stats[player].tricks;
        assert.ok(state.pearls[player] >= 0);
      });
      for (let i = 0; i < state.map.count; i++) {
        if (!state.map.water[i]) assert.ok(state.units[i] >= 1 && state.units[i] <= R.maxUnits);
      }
    }
  }
  for (const level of AI.LEVELS) assert.ok(played[level] > 0, `${level} never played a trick`);
  assert.deepEqual(AI.tricksOf('easy'), ['recruit']);
  assert.deepEqual([...AI.tricksOf('hard')].sort(), [...ALL_TRICKS].sort());
});

test('ai: an adventure game replays exactly from its seed', () => {
  const play = () => playGame(core, { seed: 'REPRIZA', levels: ['hard', 'normal'], firstPlayer: 1, adventure: true });
  const first = play();
  const second = play();
  assert.equal(first.actions, second.actions);
  assert.deepEqual(first.state.owner, second.state.owner);
  assert.deepEqual(first.state.units, second.state.units);
  assert.deepEqual(first.state.pearls, second.state.pearls);
  assert.equal(first.state.rng, second.state.rng);
});

test('ai: hard fires the cannon where it opens an attack, and shields what it cannot hold', () => {
  const state = adventure('TOP');
  const capital = state.map.capitals[0];
  const [target] = state.map.adj[capital].filter((n) => state.map.feature[n] === FEATURE.none);
  const open = withBoard(state, { [capital]: [0, 6], [target]: [1, 6] }, { tricks: [['cannon'], []], pearls: [4, 0] });
  assert.deepEqual(AI.chooseAction(open, 'hard'), { type: 'trick', trick: 'cannon', tile: target });

  // No pearls, no trick: the same position is played without it.
  assert.notEqual(AI.chooseAction({ ...open, pearls: [0, 0] }, 'hard').type, 'trick');
});

/* ── career ──────────────────────────────────────────────────────────── */

test('career: levels are reached by experience and unlock the tricks in order', () => {
  const { levels } = CONFIG.career;
  assert.deepEqual(Career.levelOf(0), { level: 1, floor: 0, ceiling: levels[1].xp });
  assert.equal(Career.levelOf(levels[1].xp - 1).level, 1);
  assert.equal(Career.levelOf(levels[1].xp).level, 2);
  assert.deepEqual(Career.levelOf(999999), { level: levels.length, floor: levels.at(-1).xp, ceiling: null });

  assert.deepEqual(Career.tricksAt(1), ['recruit']);
  assert.deepEqual(Career.tricksAt(3), ['recruit', 'shield', 'cannon']);
  assert.deepEqual([...Career.tricksAt(levels.length)].sort(), [...ALL_TRICKS].sort(), 'every trick can be unlocked');
  assert.equal(Career.levelFor('recruit'), 1);
  assert.equal(Career.levelFor('wind'), 5);
  assert.equal(Career.pearlsAt(1), 0);
  assert.equal(Career.pearlsAt(levels.length), levels.at(-1).pearls);
});

test('career: facts are gathered from the events of a game', () => {
  const combat = (fields) => ({ type: 'combat', player: 0, defender: NEUTRAL, conquered: true, odds: 0.8, chest: false, ...fields });
  const events = [
    { type: 'turn', player: 0 },
    combat(), combat({ chest: true }), combat({ odds: 0.2 }),
    combat({ conquered: false }), combat(),
    { type: 'trick', player: 0, trick: 'shield' },
    { type: 'trick', player: 1, trick: 'cannon' },
    { type: 'turn', player: 1 },
    combat({ player: 1, defender: 0, conquered: false }),
    combat({ player: 1, defender: 0, conquered: true }),
    combat({ player: 1, defender: NEUTRAL, conquered: false }),
  ];
  const facts = events.reduce((sum, event) => Career.observe(sum, event, 0), Career.newFacts());
  assert.deepEqual(facts, { streak: 0, bestStreak: 3, upsets: 1, chests: 1, repelled: 1, tricks: 1 });
});

test('career: stars, badges and experience of a game', () => {
  const profile = Career.fresh();
  const facts = { ...Career.newFacts(), upsets: 1, bestStreak: 5 };
  const finished = (result, round, conquests = 12) => {
    const state = adventure('KARIJERA');
    const stats = state.stats.map((s, player) => (player === 0 ? { ...s, conquests } : s));
    return { ...state, result, round, stats };
  };

  const swift = Career.judge({ state: finished({ winner: 0, reason: 'capital' }, 18), facts, human: 0, level: 'normal', profile });
  assert.equal(swift.stars, 3);
  assert.deepEqual(swift.goals, [true, true, true]);
  assert.deepEqual(swift.badges, ['firstGame', 'beatNormal', 'lightning', 'luckyHand', 'streak']);
  assert.equal(swift.xp, 10 + 12 + 60 + 3 * 15 + 5 * 20);

  const slow = Career.judge({ state: finished({ winner: 0, reason: 'capital' }, 30), facts: Career.newFacts(), human: 0, level: 'easy', profile });
  assert.equal(slow.stars, 2);
  const onPoints = Career.judge({ state: finished({ winner: 0, reason: 'rounds' }, 40), facts: Career.newFacts(), human: 0, level: 'hard', profile });
  assert.equal(onPoints.stars, 1);
  assert.ok(onPoints.badges.includes('beatHard'));

  const lost = Career.judge({ state: finished({ winner: 1, reason: 'capital' }, 12, 60), facts: Career.newFacts(), human: 0, level: 'hard', profile });
  assert.equal(lost.stars, 0);
  assert.deepEqual(lost.badges, ['firstGame']);
  assert.equal(lost.xp, 10 + CONFIG.career.xp.conquestCap + 20, 'a lost game still earns experience');

  // A badge is awarded once.
  const again = Career.judge({ state: finished({ winner: 0, reason: 'capital' }, 18), facts, human: 0, level: 'normal', profile: { ...profile, badges: swift.badges } });
  assert.deepEqual(again.badges, []);
});

test('career: a game moves the profile forward and reports what it unlocked', () => {
  const start = { ...Career.fresh(), xp: 70 };
  const verdict = { won: true, stars: 2, badges: ['firstGame', 'beatEasy'], xp: 150 };
  const step = Career.advance(start, verdict, 'easy');
  assert.deepEqual(step.profile, { xp: 220, games: 1, wins: 1, duels: 0, stars: { easy: 2, normal: 0, hard: 0 }, badges: ['firstGame', 'beatEasy'] });
  assert.equal(step.levelBefore, 1);
  assert.equal(step.levelAfter, 3);
  assert.deepEqual(step.unlocked, ['shield', 'cannon']);
  assert.deepEqual(start.badges, [], 'the old profile is left alone');

  // Best stars never go down, and a loss counts as a game.
  const worse = Career.advance(step.profile, { won: false, stars: 0, badges: [], xp: 12 }, 'easy');
  assert.equal(worse.profile.stars.easy, 2);
  assert.deepEqual([worse.profile.games, worse.profile.wins], [2, 1]);
  assert.deepEqual(worse.unlocked, []);
});

test('career: a stored profile is repaired before use', () => {
  assert.deepEqual(Career.restore(null), Career.fresh());
  assert.deepEqual(Career.restore('nonsense'), Career.fresh());
  const repaired = Career.restore({ xp: 123.9, games: -4, wins: '2', duels: 3.5, stars: { easy: 9, hard: 2 }, badges: ['beatEasy', 'cheat', 'firstGame'] });
  assert.deepEqual(repaired, { xp: 123, games: 0, wins: 0, duels: 3, stars: { easy: 3, normal: 0, hard: 2 }, badges: ['firstGame', 'beatEasy'] });
});

test('duel: a game between two players earns experience, but no stars, wins or badges', () => {
  const start = { ...Career.fresh(), xp: 70, games: 4, wins: 2, stars: { easy: 2, normal: 1, hard: 0 }, badges: ['firstGame'] };
  const verdict = Career.judgeDuel();
  assert.equal(verdict.xp, CONFIG.career.xp.duel);
  assert.equal(verdict.stars, 0);
  assert.deepEqual(verdict.badges, []);

  const step = Career.advance(start, verdict, null);
  assert.deepEqual(step.profile, { ...start, xp: 70 + CONFIG.career.xp.duel, duels: 1 });
  assert.deepEqual([step.levelBefore, step.levelAfter], [1, 2], 'duels can raise the level');
  assert.deepEqual(step.unlocked, ['shield']);
});

test('duel: both fleets start level, either may move first, and the game plays out by the rules', () => {
  const hand = Career.tricksAt(3);
  for (const firstPlayer of [0, 1]) {
    let { state, events } = Rules.createGame({ seed: 'DVOBOJ', firstPlayer, landmarks: true, tricks: [hand, hand], pearls: [2, 2] });
    assert.deepEqual(events.at(-1).type, 'turn');
    assert.equal(state.current, firstPlayer);
    assert.deepEqual(state.tricks.map((own) => [...own]), [hand, hand]);
    assert.deepEqual(state.pearls, [2, 2]);
    assert.equal(Rules.unitCount(state, 0), Rules.unitCount(state, 1));
    assert.equal(Rules.incomeFor(state, 0), Rules.incomeFor(state, 1));

    // Two equal players (the hard AI on both sides) reach a result within the round limit.
    let seen = 0;
    while (!state.result) {
      const action = AI.chooseAction(state, 'hard');
      assert.equal(Rules.validate(state, action), null, `legal: ${JSON.stringify(action)}`);
      state = Rules.applyAction(state, action).state;
      assert.ok(++seen < 20000, 'the game ends');
    }
    assert.ok(state.round <= CONFIG.rules.maxRounds);
    assert.equal(state.firstPlayer, firstPlayer);
  }
});
