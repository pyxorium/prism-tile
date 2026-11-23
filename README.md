# Prism (web tile)

A dice puzzle web tile: House Dice's Prism on its original 3 × 4 board. Its rules run as a small
WebAssembly engine, `engine/engine.wasm`, which the tile's page plays through and which any host can
use to check a saved game by replaying its moves.

**Status:** stages 1 to 3 of 5: the engine, the tile's page, the lexicon and publishing. Raku's part (checking each
game with the engine before saving it) comes next.

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

## The tile (`tile\`)

What gets published as the web tile:

- `index.html`: the game. It never decides anything itself: it asks the engine for the pool, the board, the lit cells
  and the score, and tells it where each die goes. House Dice's look (glowing pips, colour-tinted and pip-marked cells,
  the cast animation; the pool beneath the board), sized to whatever frame it's given.
- `engine.wasm`, `engine.js`: exact copies of `engine\` (a test checks).
- `prism-record.js`: the record a finished game sends to save (`recordFromGame`), and the check a host can run on one
  (`checkRecord`: it must replay to exactly its board and score).
- `game-client.js`: an exact copy of the Game Host Kit's game helper (a test checks, when the kit is next to this folder).
- `manifest.json` (name, description, 380 × 460), `icon.png`.

**Daily and free play:** the daily game's dice come from the America/Denver day, the same for everyone; free play
picks a random seed. **Saving** goes through the host (the Game Host Kit): Save shows only when the host offers to save
`cafe.thunderbird.prism.game`. The record holds `mode`, `day` (daily) or `seed` (free play), `moves`, `board` (12
strings such as `"teal-3"` or `"empty"`), `filled`, `empty`, `rainbowRows`, `score`; the host adds `$type`, `createdAt`
and which tile and version made it. **The character spot** (`#character`) is kept empty for now.

## Saved games: the record, and checking one

A saved game is a `cafe.thunderbird.prism.game` record in the player's own repo (lexicon in `lexicons\`, published
from thunderbird.cafe; the Wix TXT record `_lexicon.prism` points the name there). The game sends its own fields; the
host adds the rest:

| Field | From | What |
|---|---|---|
| `mode` | game | `daily` (the day's dice, the same for everyone) or `free` (free play) |
| `day` | game | daily only: the America/Denver day, `YYYY-MM-DD` (never a seed) |
| `seed` | game | free play only: 0 to 4294967295 (never a day) |
| `moves` | game | 1 to 24 numbers: die (0 to 3) × 12 + cell (0 to 11) |
| `board` | game | 12 strings, row by row: `"teal-3"` or `"empty"` |
| `filled`, `empty`, `rainbowRows`, `score` | game | the end screen's numbers |
| `game` | host | the tile it loaded: `{ uri, cid }` (a strongRef) |
| `engine` | host | the CID of the `engine.wasm` it checked the game with (optional) |
| `createdAt` | host | when it was saved |

**To check a saved game** (what any host can do, in any language that runs WebAssembly): fetch the tile's
`/engine.wasm` (it asks for no imports), work out the seed (`seed_for_day(year, month, day)` for a daily game, the
record's `seed` for free play), write the moves into `replay_moves()`, call `replay(seed, count)`, and compare the
board and score parts with the record's. In JavaScript that's `checkRecord(await loadEngine(bytes), record)` from
`tile\prism-record.js`. By hand: `Get-Content record.json | node test\browser\replay-record.mjs`.

**What a check shows:** these moves, under this engine, on these dice, give this board and score. Not that a person
played them, nor that it was their first try: a host that cares (Raku does) saves one daily game per player per day.

## Publishing (thunderbird.cafe)

- `node scripts\publish-lexicons.mjs --dry-run`, then without `--dry-run`: the lexicon, as a
  `com.atproto.lexicon.schema` record (only when new or changed).
- `node scripts\publish-tile.mjs --dry-run`, then without: the tile (`tile\`), the first time as a new record, later
  updating the same record in place (only changed files uploaded; `swapRecord`; read back). **It publishes only the
  approved engine** (`ENGINE_CID` in the script): `tile\engine.wasm` must be `engine\engine.wasm` with that CID.
  Changing the page doesn't change the engine, so hosts that approve it by CID need nothing; a rules change is a new
  engine, so `ENGINE_CID` is changed on purpose and hosts told.
- Both take the app password from `$env:BSKY_APP_PASSWORD` (or ask, hidden) and keep what they published in
  `published.json` (commit it). A replaced tile record is backed up in `backups\` first (not committed).

## Commands (directly in `C:\thunderbird-cafe\prism-tile`)

- `npm test`: publishing against a stand-in server (and every record the game makes against the lexicon), the tile's
  copies and its records; the engine against the reference over 100,000 random games (every pool, board, legal cell,
  draw count and score compared after every move), illegal moves, replays, daily seeds, no imports; with
  clang installed, also six copies of the engine with one rule broken, each caught. About 15 seconds.
  `$env:PRISM_GAMES = 2000` first for a quick run.
- `python test\browser\check_tile.py`: the page in Chromium (needs Playwright), on its own and in a stand-in host
  built on the Game Host Kit (the kit's folder next to this one, or give its path): whole games played by clicking,
  saved, and each saved record replayed; screenshots at card and phone sizes into `test\browser\screenshots\`.
- `Get-Content record.json | node test\browser\replay-record.mjs`: check one saved game by hand.
- `node scripts/simulate.mjs`: how two made-up players do.
- `node scripts/build-engine.mjs`: rebuild `engine.wasm` (needs clang with the wasm32 target). Only a rules
  change should need this: hosts approve engines by CID. `node scripts/build-engine.mjs --check` says whether
  a fresh build matches the committed file.

No packages: Node 22 is enough.
