// The wasm engine against the JavaScript reference (House Dice's rules), move for move.
//
//   npm test                         (PRISM_GAMES=100000 by default; set it lower for a quick run)
//
// Also: illegal moves refused and changing nothing, replay agreeing with play, tampered and unfinished
// games refused, daily seeds, no imports, and copies of the engine with one rule broken caught (those
// need clang and are skipped without it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEngine, parseDay } from '../engine/engine.js';
import { PrismGame, seedForDay, mulberry32, PRISM_SIZE } from '../reference/prism-ref.mjs';
import { CLANG_ARGS } from '../scripts/build-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = path.join(root, 'engine', 'engine.wasm');
const sourcePath = path.join(root, 'engine', 'prism.c');
const GAMES = Number(process.env.PRISM_GAMES || 100000);

function refState(g) {
  return {
    pool: g.pool.map((d) => ({ color: d.color, number: d.number })),
    board: g.grid.map((c) => (c ? { color: c.color, number: c.number } : null)),
    moves: [...g.moves],
    draws: g.totalDrafted,
    over: g.over,
    casts: g.casts,
    ...g.result(),
  };
}

/** Plays `games` random games through both; returns the number of moves compared. Throws on any difference. */
function playSideBySide(engine, games, driverSeed) {
  const rand = mulberry32(driverSeed);
  let moves = 0;
  for (let n = 0; n < games; n++) {
    const seed = n % 10 === 0 ? seedForDay(`2026-${String(1 + (n % 12)).padStart(2, '0')}-${String(1 + (n % 28)).padStart(2, '0')}`) : Math.floor(rand() * 4294967296);
    const ref = new PrismGame(seed);
    engine.start(seed);
    assert.deepEqual(engine.state(), refState(ref), `game ${n} (seed ${seed}) at the start`);
    while (!ref.over) {
      const legal = [];
      for (let i = 0; i < ref.pool.length; i++) {
        const mask = ref.legalMask(i);
        assert.equal(engine.legalMask(i), mask, `game ${n} (seed ${seed}): legal cells for die ${i}`);
        for (let c = 0; c < PRISM_SIZE; c++) if (mask & (1 << c)) legal.push([i, c]);
      }
      // An illegal try: refused by both, nothing changes.
      if (rand() < 0.3) {
        const i = Math.floor(rand() * 5) - (rand() < 0.1 ? 1 : 0);
        const c = Math.floor(rand() * 13) - (rand() < 0.1 ? 1 : 0);
        if (!legal.some(([a, b]) => a === i && b === c)) {
          const before = engine.state();
          assert.equal(engine.place(i, c), false, `game ${n}: illegal move ${i},${c} accepted`);
          assert.equal(ref.place(i, c), false);
          assert.deepEqual(engine.state(), before, `game ${n}: an illegal move changed something`);
        }
      }
      assert.ok(legal.length > 0, `game ${n}: not over, but no legal move`);
      const [i, c] = legal[Math.floor(rand() * legal.length)];
      assert.equal(engine.place(i, c), true);
      assert.equal(ref.place(i, c), true);
      moves++;
      assert.deepEqual(engine.state(), refState(ref), `game ${n} (seed ${seed}) after move ${ref.moves.length}`);
    }
    assert.equal(engine.place(0, 0), false, 'a move after the end');
  }
  return moves;
}

const engine = await loadEngine(readFileSync(wasmPath));

test('the engine asks for nothing and is small', () => {
  const module = new WebAssembly.Module(readFileSync(wasmPath));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.ok(readFileSync(wasmPath).length < 16 * 1024);
  assert.equal(engine.version, 1);
  assert.equal(engine.size, 12);
  assert.equal(engine.maxDrawn, 24);
});

test('the board layout is House Dice\'s original 3 rows', () => {
  assert.deepEqual(engine.layout, [
    null, { type: 'color', value: 'teal' }, null, { type: 'number', value: 3 },
    { type: 'color', value: 'red' }, null, null, null,
    null, { type: 'number', value: 2 }, { type: 'color', value: 'violet' }, null,
  ]);
});

test('daily seeds match the reference for every day of 2026 to 2028', () => {
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2029, 0, 1); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    assert.equal(engine.seedForDay(day), seedForDay(day), day);
  }
  assert.equal(parseDay('2026-02-30'), null);
  assert.equal(parseDay('2026-1-5'), null);
  assert.throws(() => engine.seedForDay('yesterday'));
});

test(`${GAMES} random games: the engine and the reference agree after every move`, () => {
  const started = Date.now();
  const moves = playSideBySide(engine, GAMES, 20261122);
  console.log(`  ${GAMES} games, ${moves} moves compared in ${((Date.now() - started) / 1000).toFixed(1)} s`);
});

test('replay gives back the game that was played, and refuses what wasn\'t', () => {
  const rand = mulberry32(7);
  for (let n = 0; n < 2000; n++) {
    const daily = n % 2 === 0;
    const day = `2026-11-${String(1 + (n % 30)).padStart(2, '0')}`;
    const seed = daily ? seedForDay(day) : Math.floor(rand() * 4294967296);
    const ref = new PrismGame(seed);
    while (!ref.over) {
      const legal = [];
      for (let i = 0; i < ref.pool.length; i++) for (let c = 0; c < 12; c++) if (ref.legalMask(i) & (1 << c)) legal.push([i, c]);
      const [i, c] = legal[Math.floor(rand() * legal.length)];
      ref.place(i, c);
    }
    const game = daily ? { day } : { seed };
    const replayed = engine.replay(game, ref.moves);
    assert.ok(replayed, `game ${n} doesn't replay`);
    assert.deepEqual(replayed, refState(ref));
    // Unfinished: one move short.
    assert.equal(engine.replay(game, ref.moves.slice(0, -1)), null, `game ${n}: unfinished game accepted`);
    // A move after the end.
    if (ref.moves.length < 24) assert.equal(engine.replay(game, [...ref.moves, 0]), null);
    // A free-play game claimed as another day's daily game (different dice) almost never replays,
    // and when it does it ends differently.
    const other = engine.replay({ day: '2025-01-01' }, ref.moves);
    if (other) assert.notDeepEqual(other.board, refState(ref).board);
  }
  assert.equal(engine.replay({ day: '2026-13-01' }, []), null);
  assert.equal(engine.replay({ seed: -1 }, []), null);
  assert.equal(engine.replay({ seed: 1.5 }, []), null);
  assert.equal(engine.replay({}, []), null);
  assert.equal(engine.replay({ seed: 1 }, [48]), null);
  assert.equal(engine.replay({ seed: 1 }, new Array(25).fill(0)), null);
});

function hasClang() {
  try {
    execFileSync(process.env.CLANG || 'clang', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const BREAKS = [
  ['the rainbow-row bonus', '+ rainbow_rows() * 3', '+ rainbow_rows() * 2'],
  ['the number clash between neighbours', '|| board_number[n] == number', ''],
  ['diagonals counting as touching', 'if (dr == 0 && dc == 0) continue;', 'if (dr == 0 && dc == 0) continue; if (dr != 0 && dc != 0) continue;'],
  ['the draw limit', '#define MAX_DRAWN 24', '#define MAX_DRAWN 25'],
  ['counting a stuck pool\'s dice', 'drawn += pool_len;', ''],
  ['the order of colour and number', 'pool_color_[i] = (unsigned char)next_below(COLORS);\n    pool_number_[i] = (unsigned char)(1 + next_below(6));', 'pool_number_[i] = (unsigned char)(1 + next_below(6));\n    pool_color_[i] = (unsigned char)next_below(COLORS);'],
];

test('a copy of the engine with one rule broken is caught', { skip: hasClang() ? false : 'clang not found' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'prism-break-'));
  try {
    const source = readFileSync(sourcePath, 'utf8');
    for (const [name, from, to] of BREAKS) {
      assert.ok(source.includes(from), `can't find ${name} in prism.c`);
      const src = path.join(dir, 'broken.c');
      const out = path.join(dir, 'broken.wasm');
      writeFileSync(src, source.replace(from, to));
      execFileSync(process.env.CLANG || 'clang', [...CLANG_ARGS, '-o', out, src], { stdio: 'ignore' });
      const broken = await loadEngine(readFileSync(out));
      assert.throws(() => playSideBySide(broken, 2000, 99), `breaking ${name} wasn't caught`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
