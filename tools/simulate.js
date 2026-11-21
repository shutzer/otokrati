'use strict';

/*
 * Computer-versus-computer tournament, run headless across worker threads.
 *
 *   node tools/simulate.js                      100 games for every pair of levels
 *   node tools/simulate.js --games 300          more games per pair
 *   node tools/simulate.js --pairs hard:normal  only the listed pairs (comma separated)
 *   node tools/simulate.js --mode adventure     only one kind of game (classic | adventure)
 *
 * Every map is played twice, once with each side moving first. Classic games
 * use the bare rules; adventure games add landmarks and each level's tricks.
 */

const os = require('node:os');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { loadCore } = require('./load-core');
const { playGame } = require('./arena');

const ALL_PAIRS = ['normal:easy', 'hard:normal', 'hard:easy', 'easy:easy', 'normal:normal', 'hard:hard'];

function parseArgs(argv) {
  const options = {
    games: 100,
    pairs: ALL_PAIRS,
    modes: ['classic', 'adventure'],
    jobs: Math.max(1, os.availableParallelism() - 2),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (argv[i] === '--games') options.games = Number(value);
    else if (argv[i] === '--pairs') options.pairs = value.split(',');
    else if (argv[i] === '--mode') options.modes = [value];
    else if (argv[i] === '--jobs') options.jobs = Number(value);
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  return options;
}

/** One task per game: player 0 is always the first level of the pair. */
function buildTasks({ games, pairs, modes }) {
  const tasks = [];
  for (const mode of modes) {
    for (const pair of pairs) {
      for (let game = 0; game < games; game++) {
        tasks.push({ mode, pair, seed: `SIM${game >> 1}`, firstPlayer: game % 2 });
      }
    }
  }
  return tasks;
}

function runWorker() {
  const core = loadCore();
  const results = workerData.tasks.map((task) => {
    const started = process.hrtime.bigint();
    try {
      const { winner, reason, rounds, actions } = playGame(core, {
        ...task,
        levels: task.pair.split(':'),
        adventure: task.mode === 'adventure',
      });
      return { ...task, winner, reason, rounds, actions, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    } catch (error) {
      return { ...task, error: error.message };
    }
  });
  parentPort.postMessage(results);
}

function summarize(pair, results) {
  const played = results.filter((r) => !r.error);
  const count = (test) => played.filter(test).length;
  const share = (part, whole) => (whole ? `${(100 * part / whole).toFixed(1)}%` : '-');
  const wins = count((r) => r.winner === 0);
  const losses = count((r) => r.winner === 1);
  const movedFirst = played.filter((r) => r.firstPlayer === 0);
  return {
    pair,
    games: results.length,
    crashed: results.length - played.length,
    wins,
    losses,
    draws: played.length - wins - losses,
    'win rate': share(wins, played.length),
    'when first': share(movedFirst.filter((r) => r.winner === 0).length, movedFirst.length),
    'when second': share(count((r) => r.firstPlayer === 1 && r.winner === 0), played.length - movedFirst.length),
    'by capital': count((r) => r.reason === 'capital'),
    'by rounds': count((r) => r.reason === 'rounds'),
    'avg rounds': (played.reduce((sum, r) => sum + r.rounds, 0) / played.length).toFixed(1),
    'ms/game': (played.reduce((sum, r) => sum + r.ms, 0) / played.length).toFixed(0),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tasks = buildTasks(options);
  const jobs = Math.min(options.jobs, tasks.length);
  const batches = Array.from({ length: jobs }, (_, job) => tasks.filter((_, i) => i % jobs === job));

  const results = (await Promise.all(batches.map((batch) => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { tasks: batch } });
    worker.once('message', resolve);
    worker.once('error', reject);
  })))).flat();

  for (const mode of options.modes) {
    console.log(`\n${mode} games`);
    console.table(options.pairs.map((pair) => summarize(pair, results.filter((r) => r.mode === mode && r.pair === pair))));
  }
  console.log(`Total games: ${results.length}`);

  const failures = results.filter((r) => r.error);
  failures.slice(0, 10).forEach((r) => console.error(`FAILED ${r.mode} ${r.pair} seed ${r.seed}: ${r.error}`));
  process.exitCode = failures.length ? 1 : 0;
}

if (isMainThread) main();
else runWorker();
