# Prism (web tile)

A dice puzzle web tile: House Dice's Prism on its original 3 × 4 board. Its rules run as a small
WebAssembly engine, `engine/engine.wasm`, which the tile's page plays through and which any host can
use to check a saved game by replaying its moves.

**Status:** stage 1 of 5, the engine. The tile's page, the lexicon, publishing and Raku's part come next.

## The engine

- `engine/prism.c`: the rules, in C (whole numbers only; no imports, so it asks its host for nothing).
- `engine/engine.wasm`: built from it with clang 18.1.3 (5,470 bytes,
  `bafkreierrxyrejorlhz5svmjoytchpk7cdcxifubhplz44lhj6u4l6uhra`).
- `engine/engine.js`: a small loader for the page, the tests and hosts (`loadEngine(bytes)`,
  `start(seed)` / `startDaily('2026-11-22')`, `state()`, `legalCells(die)`, `place(die, cell)`,
  `replay({ day } | { seed }, moves)`).
- `reference/prism-ref.mjs`: House Dice's own Prism functions, set to 3 rows and 24 draws, with seeded
  dice: the JavaScript reference the engine must match.

**The rules:** a pool of 4 dice (red, lemon, teal, violet; 1 to 6). Dice sharing an edge can't match colour
or number; cell 1 takes only teal, 3 only a 3, 4 only red, 9 only a 2, 10 only violet; the first die goes
on an edge; later dice touch a placed die (diagonals count). A pool with no legal die is recast, its dice
counted as drawn. The game ends on a full board or at 24 draws. Score: +1 per filled cell, −1 per empty,
+3 per full row with all four colours.

**The dice:** House Dice's generator (mulberry32, seeded by its string hash). The daily game's seed is the
hash of `prism:` + the America/Denver day (`seed_for_day` in the engine); free play uses any 32-bit seed.

**A move** is one number: which die in the pool (0 to 3, among the dice left, in the order cast) × 12 + the
cell (0 to 11). A game has at most 24.

## Commands (directly in `C:\thunderbird-cafe\prism-tile`)

- `npm test`: the engine against the reference over 100,000 random games (every pool, board, legal cell,
  draw count and score compared after every move), illegal moves, replays, daily seeds, no imports; with
  clang installed, also six copies of the engine with one rule broken, each caught. About 15 seconds.
  `$env:PRISM_GAMES = 2000` first for a quick run.
- `node scripts/simulate.mjs`: how two made-up players do.
- `node scripts/build-engine.mjs`: rebuild `engine.wasm` (needs clang with the wasm32 target). Only a rules
  change should need this: hosts approve engines by CID. `node scripts/build-engine.mjs --check` says whether
  a fresh build matches the committed file.

No packages: Node 22 is enough.
