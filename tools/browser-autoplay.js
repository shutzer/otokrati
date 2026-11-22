/*
 * Browser check: plays a whole game through the real interface.
 *
 * Open index.html, choose a rival, the kind of game and a map code on the
 * start screen, then run this file in the page (paste it into the DevTools
 * console as `await (<file>)()`, or evaluate it from a browser automation
 * tool). Animations are sped up while it runs.
 *
 * A second, DOM-less copy of the game logic shadows the game, which works
 * because a game is fully determined by its seed and the actions taken. The
 * shadow picks the human's moves with the hard AI, enters them as taps and
 * button clicks, and compares what the interface shows with what it expects.
 * In a game for two players it plays both fleets that way. To look at a game
 * in progress, set window.autoplayUntilRound first: it then stops at that round.
 * Resolves to { done, actions, tricks, round, errors, result, title, detail }.
 */
async () => {
  const LANE_MARGIN = 1.8; // must match createPainter in index.html
  const TIME_SCALE = 12;

  const source = [...document.scripts].find((script) => !script.type).textContent; // the game, not its language packs
  const box = { exports: {} };
  new Function('module', 'document', source)(box, undefined);
  const { CONFIG, Career, Hex, Custom, createCore } = box.exports;

  const nativeFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => nativeFrame((time) => callback(time * TIME_SCALE));

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const canvas = $('board');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const status = { done: false, actions: 0, tricks: 0, round: 0, errors: [] };

  const tapTile = (map, tile) => {
    const rect = canvas.getBoundingClientRect();
    const span = 2 * map.radius + 1;
    const searoom = map.lanes.length ? LANE_MARGIN : 0;
    const size = Math.min(rect.width / (Math.sqrt(3) * span + 0.5 + searoom), rect.height / (1.5 * span + 1.4 + searoom));
    const p = Hex.toPoint(map.q[tile], map.r[tile]);
    const at = { clientX: rect.left + rect.width / 2 + p.x * size, clientY: rect.top + rect.height / 2 + p.y * size };
    for (const type of ['pointerdown', 'pointerup']) {
      canvas.dispatchEvent(new PointerEvent(type, { ...at, pointerId: 7, pointerType: 'touch', bubbles: true }));
    }
  };

  /** Resolves once the interface accepts input again, or the result is shown. */
  const idle = async () => {
    for (let i = 0; i < 2400; i++) {
      if ($('end').open || $('panel').dataset.mode !== 'wait') return;
      await wait(25);
    }
    throw new Error('the interface never became idle');
  };

  try {
    if ($('end').open) $('end').close(); // the result of an earlier game would look like the end of this one
    $('setup').requestSubmit();
    await wait(50);

    // The shadow game is set up the way the app sets up its own, by the rules in its map code.
    const { Rules, AI } = createCore(Custom.configFor(Custom.decode(app.dataset.rules)));
    const rival = app.dataset.rival;
    const duel = rival === 'friend';
    const adventure = app.dataset.mode === 'adventure';
    const stored = JSON.parse(window.localStorage.getItem(CONFIG.ui.storageKey) ?? 'null');
    const level = Career.levelOf(Career.restore(stored?.profile).xp).level;
    const hand = adventure ? Career.tricksAt(level) : [];
    if (hand.join(',') !== app.dataset.hand) status.errors.push(`hand: page has "${app.dataset.hand}", expected "${hand}"`);
    const purse = adventure ? Career.pearlsAt(level) : 0;
    let { state } = Rules.createGame({
      seed: app.dataset.seed,
      firstPlayer: Number(app.dataset.first),
      landmarks: adventure,
      tricks: [hand, duel ? hand : adventure ? AI.tricksOf(rival) : []],
      pearls: [purse, duel ? purse : 0],
      perks: adventure,
    });
    status.first = state.firstPlayer;

    const lastRound = window.autoplayUntilRound ?? Infinity;
    while (!state.result && state.round < lastRound) {
      await idle();
      // The guide of a first game holds the board until its notes are read: read on, as a child would.
      while (!$('coach').hidden && !$('coachNext').hidden) {
        $('coachNext').click();
        await wait(60);
      }
      if (state.current === 1 && !duel) { // mirror the rival's whole turn; the interface plays it on its own
        while (!state.result && state.current === 1) state = Rules.applyAction(state, AI.chooseAction(state, rival)).state;
        await wait(60);
        continue;
      }

      if (Rules.outOfMoves(state)) { // a turn that starts with nothing to do also ends by itself
        state = Rules.applyAction(state, { type: 'endTurn' }).state;
        await wait(60);
        continue;
      }

      let action = AI.chooseAction(state, 'hard');
      if (action.type === 'reinforce') {
        // One tap places one unit, and every placement is its own action in the
        // real game, so the shadow game must apply them one by one as well.
        document.querySelector('.chip[data-step="1"]').click();
        for (let i = 1; i < action.count; i++) {
          tapTile(state.map, action.tile);
          state = Rules.applyAction(state, { ...action, count: 1 }).state;
        }
        tapTile(state.map, action.tile);
        action = { ...action, count: 1 };
      } else if (action.type === 'move') {
        tapTile(state.map, action.from);
        await wait(20);
        tapTile(state.map, action.to);
        await wait(20);
        if ($('panel').dataset.mode !== 'order') throw new Error(`no order panel for ${JSON.stringify(action)}`);
        while (Number($('orderCount').textContent) > action.count) $('orderLess').click();
        if (state.owner[action.to] !== state.current) {
          // The page writes the odds in its language ("78.4%", "78,4 %"): compare the number only.
          const expected = Rules.winOdds(state, action.to, action.count) * 100;
          const shown = $('orderOdds').textContent;
          const value = Number(shown.replace(/[^\d.,]/g, '').replace(',', '.'));
          const edge = [0, 0.1, 99.9, 100].includes(value);
          if (!(Math.abs(value - expected) <= 0.051) && !edge) {
            status.errors.push(`odds: page shows ${shown}, expected ${expected.toFixed(1)}`);
          }
        }
        $('goBtn').click();
      } else if (action.type === 'perk') { // one of the three cards on offer
        for (let i = 0; i < 200 && !$('pick').open; i++) await wait(25);
        const shown = [...document.querySelectorAll('.pick-card')].map((card) => card.dataset.perk);
        if (String(shown) !== String(state.pending.options)) status.errors.push(`powers: page offers ${shown}, expected ${state.pending.options}`);
        document.querySelector(`.pick-card[data-perk="${action.perk}"]`).click();
        status.perks = (status.perks ?? 0) + 1;
      } else if (action.type === 'trick') {
        document.querySelector(`.trick[data-trick="${action.trick}"]`).click();
        await wait(20);
        if (action.tile !== undefined) tapTile(state.map, action.tile);
        status.tricks++;
      } else {
        $('endTurnBtn').click();
      }
      state = Rules.applyAction(state, action).state;
      // With nothing left to do, the interface ends the turn by itself; so does the shadow game.
      if (Rules.outOfMoves(state)) state = Rules.applyAction(state, { type: 'endTurn' }).state;
      status.actions++;
      status.round = state.round;
      await wait(30);
      await idle();

      // With a player at the controls, the interface must agree with the shadow game.
      if ((duel || state.current === 0) && !state.result) {
        const shown = [$('tiles0'), $('tiles1'), $('purse'), $('pearls0'), $('pearls1')].map((node) => Number(node.textContent));
        shown.push(Number(app.dataset.turn), $('perks0').children.length, $('perks1').children.length);
        const expected = [
          Rules.tileCount(state, 0), Rules.tileCount(state, 1),
          state.pearls[state.current], state.pearls[0], state.pearls[1], state.current,
          state.perks[0].length, state.perks[1].length,
        ];
        if (String(shown) !== String(expected)) {
          status.errors.push(`round ${state.round}: page shows ${shown}, expected ${expected} (tiles, tiles, purse, pearls, pearls, turn, powers, powers)`);
        }
      }
    }

    for (let i = 0; i < 400 && state.result && !$('end').open; i++) await wait(25);
    Object.assign(status, {
      result: state.result,
      endOpen: $('end').open,
      title: $('endTitle').getAttribute('aria-label'),
      detail: $('endDetail').textContent,
      gain: $('endXp').textContent,
      rewards: [...$('endRewards').children].map((item) => item.textContent),
    });
  } catch (error) {
    status.errors.push(String(error));
  }

  window.requestAnimationFrame = nativeFrame;
  status.done = true;
  return status;
}
