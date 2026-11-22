#!/usr/bin/env node
// Plays many games through the real engine with two made-up players and prints how they do.
//   node scripts/simulate.mjs [games]
// "random" picks any legal move; "smart" prefers restricted cells, keeps the board open and spreads
// colours along rows (it peeks at legality with the reference's rule function). Bots, not people.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEngine } from '../engine/engine.js';
import { mulberry32, prismIsLegalCell, PRISM_LAYOUT } from '../reference/prism-ref.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = await loadEngine(readFileSync(path.join(root, 'engine', 'engine.wasm')));
const GAMES = Number(process.argv[2] || 20000);
const COLORS = ['red', 'lemon', 'teal', 'violet'];

function smartPick(state, legal, rand) {
  let best = null, bestValue = -Infinity;
  for (const [i, c] of legal) {
    const die = state.pool[i];
    let v = PRISM_LAYOUT[c] ? 3 : 0;
    const grid = state.board.slice();
    grid[c] = die;
    let open = 0;
    for (let j = 0; j < 12; j++) {
      if (grid[j]) continue;
      for (const color of COLORS) {
        for (let n = 1; n <= 6; n++) if (prismIsLegalCell(grid, j, { color, number: n })) { open++; n = 7; }
      }
    }
    v += open * 0.5;
    const r = Math.floor(c / 4);
    if (!state.board.slice(r * 4, r * 4 + 4).some((x) => x && x.color === die.color)) v += 1;
    v += rand() * 0.1;
    if (v > bestValue) { bestValue = v; best = [i, c]; }
  }
  return best;
}

for (const player of ['random', 'smart']) {
  const rand = mulberry32(42);
  const games = player === 'smart' ? Math.min(GAMES, 5000) : GAMES;
  let filled = 0, full = 0, score = 0, rainbow = 0, draws = 0;
  for (let n = 0; n < games; n++) {
    engine.start(Math.floor(rand() * 4294967296));
    let s = engine.state();
    while (!s.over) {
      const legal = [];
      s.pool.forEach((_, i) => engine.legalCells(i).forEach((c) => legal.push([i, c])));
      const [i, c] = player === 'random' ? legal[Math.floor(rand() * legal.length)] : smartPick(s, legal, rand);
      engine.place(i, c);
      s = engine.state();
    }
    filled += s.filled; score += s.score; rainbow += s.rainbowRows; draws += s.draws;
    if (s.filled === 12) full++;
  }
  console.log(`${player.padEnd(6)} ${games} games: avg filled ${(filled / games).toFixed(1)}, full board ${((100 * full) / games).toFixed(0)}%, avg score ${(score / games).toFixed(1)}, rainbow rows ${(rainbow / games).toFixed(2)}, avg draws ${(draws / games).toFixed(1)}`);
}
