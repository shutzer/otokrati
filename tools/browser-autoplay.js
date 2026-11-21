/*
 * Browser check: plays a whole game through the real interface.
 *
 * Open index.html, choose a level and a seed on the start screen, then run this
 * file in the page (paste it into the DevTools console as `await (<file>)()`,
 * or evaluate it from a browser automation tool). Animations are sped up.
 *
 * A second, DOM-less copy of the game logic shadows the game, which works
 * because a game is fully determined by its seed and the actions taken. The
 * shadow picks the human's moves with the hard AI, enters them as taps and
 * button clicks, and compares what the interface shows with what it expects.
 * Resolves to { done, actions, round, errors, result, title, detail }.
 */
async () => {
  const source = document.scripts[0].textContent;
  const box = { exports: {} };
  new Function('module', 'document', source)(box, undefined);
  const { Rules, AI, Hex } = box.exports;
  const realRaf = window.__realRaf || (window.__realRaf = window.requestAnimationFrame.bind(window));
  window.requestAnimationFrame = (cb) => realRaf((t) => cb(t * window.__timeScale));
  window.__timeScale = 12;

  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const level = document.querySelector('input[name="level"]:checked').value;
  const canvas = $('board');
  const status = (window.__auto = { done: false, actions: 0, errors: [], round: 0 });

  const tapTile = (map, tile) => {
    const rect = canvas.getBoundingClientRect();
    const size = Math.min(rect.width / (Math.sqrt(3) * 11 + 0.5), rect.height / (1.5 * 11 + 1.4));
    const p = Hex.toPoint(map.q[tile], map.r[tile]);
    const x = rect.left + rect.width / 2 + p.x * size, y = rect.top + rect.height / 2 + p.y * size;
    for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, pointerType: 'touch', bubbles: true }));
  };
  const idle = async () => { for (let i = 0; i < 2000; i++) { if ($('end').open || $('panel').dataset.mode !== 'wait') return; await wait(25); } throw new Error('interface never became idle'); };

  let state = Rules.createGame({ seed: $('seed').value, firstPlayer: 0 }).state;
  $('setup').requestSubmit();
  try {
    while (!state.result) {
      await idle();
      if (state.current === 1) { // mirror the computer's whole turn; the interface plays it on its own
        while (!state.result && state.current === 1) state = Rules.applyAction(state, AI.chooseAction(state, level)).state;
        await wait(60); await idle();
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
        tapTile(state.map, action.from); await wait(20);
        tapTile(state.map, action.to); await wait(20);
        if ($('panel').dataset.mode !== 'order') throw new Error('order panel did not open for ' + JSON.stringify(action));
        while (Number($('orderCount').textContent) > action.count) $('orderLess').click();
        if (state.owner[action.to] !== 0) {
          const shown = $('orderOdds').textContent;
          const expected = (Rules.winOdds(state, action.from, action.to, action.count) * 100).toFixed(1).replace('.', ',');
          if (!shown.startsWith(expected.slice(0, 3)) && !['100 %', '99,9 %', '0,1 %'].includes(shown)) status.errors.push(`odds ${shown} vs ${expected}`);
        }
        $('goBtn').click();
      } else {
        $('endTurnBtn').click();
      }
      state = Rules.applyAction(state, action).state;
      status.actions++; status.round = state.round;
      await wait(30);
      // The interface must agree with the shadow game.
      await idle();
      const shownTiles = [Number($('tiles0').textContent), Number($('tiles1').textContent)];
      const tiles = [Rules.tileCount(state, 0), Rules.tileCount(state, 1)];
      if (state.current === 0 && !state.result && String(shownTiles) !== String(tiles)) status.errors.push(`round ${state.round}: shows ${shownTiles}, expected ${tiles}`);
    }
    await idle();
    for (let i = 0; i < 200 && !$('end').open; i++) await wait(25);
    status.result = state.result; status.endOpen = $('end').open; status.title = $('endTitle').textContent; status.detail = $('endDetail').textContent;
  } catch (error) { status.errors.push(String(error)); }
  status.done = true;
  window.__timeScale = 1;
  return status;
}
