// The tile's own files: copies that must match their sources, the manifest, the page's policy, and the record a
// finished game sends its host (it must replay to exactly its board and score through the engine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEngine } from '../engine/engine.js';
import { recordFromGame, checkRecord, cellText, COLLECTION } from '../tile/prism-record.js';
import { mulberry32 } from '../reference/prism-ref.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(path.join(root, ...p));
// The Game Host Kit's folder: KIT_DIR, or next to this one (C:\thunderbird-cafe\game-host-kit).
const kitDir = process.env.KIT_DIR || path.join(root, '..', 'game-host-kit');

test("the tile's engine files are the engine's, byte for byte", () => {
  assert.ok(read('tile', 'engine.wasm').equals(read('engine', 'engine.wasm')), 'tile/engine.wasm differs from engine/engine.wasm');
  assert.ok(read('tile', 'engine.js').equals(read('engine', 'engine.js')), 'tile/engine.js differs from engine/engine.js');
});

test("the tile's game-client.js is the kit's, byte for byte", { skip: existsSync(path.join(kitDir, 'game', 'game-client.js')) ? false : `the kit isn't at ${kitDir}` }, () => {
  assert.ok(read('tile', 'game-client.js').equals(readFileSync(path.join(kitDir, 'game', 'game-client.js'))));
});

test('the manifest names the tile and its size', () => {
  const m = JSON.parse(read('tile', 'manifest.json'));
  assert.equal(m.name, 'Prism');
  assert.ok(m.description.length > 40 && m.description.length < 300);
  assert.ok(!/colour/i.test(m.description), 'American "color" on the card (the owner, Nov 22)');
  // the card's preview picture: a 1280 x 720 JPEG (its size from the JPEG's own frame header)
  const jpg = new Uint8Array(readFileSync(new URL('../tile/banner.jpg', import.meta.url)));
  assert.deepEqual([...jpg.slice(0, 3)], [0xff, 0xd8, 0xff]);
  let i = 2, size = null;
  while (i < jpg.length && !size) {
    const marker = jpg[i + 1], len = (jpg[i + 2] << 8) | jpg[i + 3];
    if (marker >= 0xc0 && marker <= 0xc2) size = [(jpg[i + 7] << 8) | jpg[i + 8], (jpg[i + 5] << 8) | jpg[i + 6]];
    i += 2 + len;
  }
  assert.deepEqual(size, [1280, 720]);
  assert.ok(jpg.length < 200 * 1024);
  assert.deepEqual(m.sizing, { width: 380, height: 460 });
});

test("the page's policy allows WebAssembly and nothing from the network", () => {
  const html = read('tile', 'index.html').toString();
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /script-src [^;]*'wasm-unsafe-eval'/);
  assert.match(csp, /default-src 'self' blob: data:;/);
  assert.doesNotMatch(csp, /https?:/);
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), /https?:\/\//, 'no outside addresses in the page');
});

const engine = await loadEngine(read('engine', 'engine.wasm'));

function playRandom(game, rand) {
  if (game.mode === 'daily') engine.startDaily(game.day); else engine.start(game.seed);
  let s = engine.state();
  while (!s.over) {
    const legal = [];
    s.pool.forEach((_, i) => engine.legalCells(i).forEach((c) => legal.push([i, c])));
    const [i, c] = legal[Math.floor(rand() * legal.length)];
    engine.place(i, c);
    s = engine.state();
  }
  return s;
}

test('a finished game becomes a record that replays to its own board and score', () => {
  const rand = mulberry32(11);
  for (let n = 0; n < 500; n++) {
    const game = n % 2 ? { mode: 'daily', day: `2026-12-${String(1 + (n % 28)).padStart(2, '0')}` } : { mode: 'free', seed: Math.floor(rand() * 4294967296) };
    const s = playRandom(game, rand);
    const record = recordFromGame(game, s);
    assert.equal(record.mode, game.mode);
    assert.equal('day' in record, game.mode === 'daily');
    assert.equal('seed' in record, game.mode === 'free');
    assert.equal(record.board.length, 12);
    assert.ok(record.board.every((c) => c === 'empty' || /^(red|lemon|teal|violet)-[1-6]$/.test(c)));
    assert.equal(record.board.filter((c) => c !== 'empty').length, record.filled);
    assert.deepEqual(checkRecord(engine, record).ok, true, JSON.stringify(record));
    // Nothing in it that atproto records can't hold (no floats, no nulls).
    assert.ok(JSON.stringify(record).indexOf('null') < 0);
    assert.ok(Object.values(record).flat().every((v) => typeof v === 'string' || Number.isInteger(v)));
  }
});

test('a record that was changed is refused', () => {
  const rand = mulberry32(12);
  const game = { mode: 'free', seed: 123456789 };
  const record = recordFromGame(game, playRandom(game, rand));
  const bad = (change) => { const r = structuredClone(record); change(r); return checkRecord(engine, r); };
  assert.equal(bad((r) => { r.score += 1; }).ok, false);
  assert.equal(bad((r) => { r.filled += 1; r.empty -= 1; }).ok, false);
  assert.equal(bad((r) => { r.rainbowRows += 1; }).ok, false);
  assert.equal(bad((r) => { const i = r.board.indexOf('empty') >= 0 ? r.board.indexOf('empty') : 0; r.board[i] = r.board[i] === 'empty' ? 'red-1' : 'empty'; }).ok, false);
  assert.equal(bad((r) => { r.board.pop(); }).ok, false);
  assert.equal(bad((r) => { r.seed += 1; }).ok, false);
  assert.equal(bad((r) => { r.moves.pop(); }).ok, false);
  assert.equal(bad((r) => { r.mode = 'daily'; }).ok, false, 'a free game called daily (no day)');
  assert.equal(bad((r) => { r.mode = 'daily'; r.day = '2026-11-22'; delete r.seed; }).ok, false, 'a free game claimed as a daily one');
  assert.equal(bad((r) => { r.day = '2026-11-22'; }).ok, false, 'both a day and a seed');
  assert.equal(checkRecord(engine, null).ok, false);
  assert.equal(cellText(null), 'empty');
  assert.equal(COLLECTION, 'cafe.thunderbird.prism.game');
});
