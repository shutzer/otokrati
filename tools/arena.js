'use strict';

/* Plays computer-versus-computer games without any interface. */

const MAX_ACTIONS_PER_TURN = 400; // far above anything legal play needs; trips on a stuck AI

/**
 * Plays one full game.
 * @param core       the object returned by loadCore()
 * @param levels     AI level of player 0 and player 1
 * @param adventure  landmarks on the map, each level's own tricks in hand and powers to earn;
 *                   false plays the classic rules
 * @returns {{ winner: 0|1|null, reason: string, rounds: number, actions: number, state: object }}
 */
function playGame(core, { seed, levels, firstPlayer = 0, adventure = false }) {
  const { Rules, AI, CONFIG } = core;
  const tricks = adventure ? levels.map(AI.tricksOf) : [[], []];
  let { state } = Rules.createGame({ seed, firstPlayer, landmarks: adventure, tricks, perks: adventure });
  let actions = 0;
  let actionsThisTurn = 0;

  while (!state.result) {
    const action = AI.chooseAction(state, levels[state.current]);
    actionsThisTurn = action.type === 'endTurn' ? 0 : actionsThisTurn + 1;
    if (actionsThisTurn > MAX_ACTIONS_PER_TURN) {
      throw new Error(`Stuck: ${levels[state.current]} exceeded ${MAX_ACTIONS_PER_TURN} actions in one turn (seed ${seed})`);
    }
    state = Rules.applyAction(state, action).state;
    actions++;
    if (state.round > CONFIG.rules.maxRounds) {
      throw new Error(`Round limit exceeded (seed ${seed})`);
    }
  }

  return { winner: state.result.winner, reason: state.result.reason, rounds: state.round, actions, state };
}

module.exports = { playGame };
