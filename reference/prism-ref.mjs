// Prism's JavaScript reference: House Dice's own Prism rules (main.jsx), copied as they are and set to the
// original 3 x 4 board and 24 draws, with House Dice's seeded generator in place of Math.random(). The wasm
// engine (engine/prism.c) must agree with this exactly, move for move; test/engine.test.mjs checks it.
//
// Copied from House Dice: PRISM_LAYOUT (its first 12 cells, "v1's original 3-row layout"), prismRowCol,
// prismOrthNeighbors, prismAllNeighbors, prismIsEdgeOrCorner, prismIsLegalCell, prismLegalCells,
// findViablePrismPool, resolvePrismPoolState / placePrismDie, computePrismScore; seedFromString and mulberry32
// (House Dice's daily generator, also in Cosmic Junkyard's engine). Two changes, both deliberate:
// - the dice are seeded (each die draws its colour, then its number) instead of Math.random();
// - a pool still stuck after its 30 recasts ends the game (House Dice could leave it on screen).
// The page's cosmetic fields (tilt, offsets, cast timing) aren't part of the rules and aren't here.

export const PRISM_ROWS = 3;
export const PRISM_COLS = 4;
export const PRISM_SIZE = PRISM_ROWS * PRISM_COLS;
export const PRISM_MAX_DRAFTED = 24;
export const PRISM_COLORS = [
  { id: 'red', hex: '#FF5A54' },
  { id: 'lemon', hex: '#F7E733' },
  { id: 'teal', hex: '#2FE3A0' },
  { id: 'violet', hex: '#B48CFF' },
];
export const PRISM_LAYOUT = [
  null, { type: 'color', value: 'teal' }, null, { type: 'number', value: 3 },
  { type: 'color', value: 'red' }, null, null, null,
  null, { type: 'number', value: 2 }, { type: 'color', value: 'violet' }, null,
];

export function seedFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}
export function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A daily game's seed: "prism:" + the America/Denver day, e.g. "prism:2026-11-22". */
export function seedForDay(day) {
  return seedFromString(`prism:${day}`);
}

function prismRowCol(idx) {
  return [Math.floor(idx / PRISM_COLS), idx % PRISM_COLS];
}
function prismOrthNeighbors(idx) {
  const [r, c] = prismRowCol(idx);
  const out = [];
  if (r > 0) out.push((r - 1) * PRISM_COLS + c);
  if (r < PRISM_ROWS - 1) out.push((r + 1) * PRISM_COLS + c);
  if (c > 0) out.push(r * PRISM_COLS + (c - 1));
  if (c < PRISM_COLS - 1) out.push(r * PRISM_COLS + (c + 1));
  return out;
}
function prismAllNeighbors(idx) {
  const [r, c] = prismRowCol(idx);
  const out = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < PRISM_ROWS && nc >= 0 && nc < PRISM_COLS) out.push(nr * PRISM_COLS + nc);
    }
  }
  return out;
}
function prismIsEdgeOrCorner(idx) {
  const [r, c] = prismRowCol(idx);
  return r === 0 || r === PRISM_ROWS - 1 || c === 0 || c === PRISM_COLS - 1;
}
export function prismIsLegalCell(grid, idx, die) {
  if (grid[idx] != null) return false;
  const restriction = PRISM_LAYOUT[idx];
  if (restriction) {
    if (restriction.type === 'color' && die.color !== restriction.value) return false;
    if (restriction.type === 'number' && die.number !== restriction.value) return false;
  }
  const anyPlaced = grid.some((c) => c != null);
  if (!anyPlaced) return prismIsEdgeOrCorner(idx);
  const touchesExisting = prismAllNeighbors(idx).some((n) => grid[n] != null);
  if (!touchesExisting) return false;
  const orthConflict = prismOrthNeighbors(idx).some(
    (n) => grid[n] != null && (grid[n].color === die.color || grid[n].number === die.number)
  );
  return !orthConflict;
}
export function prismLegalCells(grid, die) {
  const out = [];
  for (let i = 0; i < PRISM_SIZE; i++) if (prismIsLegalCell(grid, i, die)) out.push(i);
  return out;
}
export function computePrismScore(grid) {
  const filled = grid.filter((c) => c != null).length;
  const empty = PRISM_SIZE - filled;
  let rainbowRows = 0;
  for (let r = 0; r < PRISM_ROWS; r++) {
    const row = [];
    for (let c = 0; c < PRISM_COLS; c++) row.push(grid[r * PRISM_COLS + c]);
    if (row.every((cell) => cell != null)) {
      if (new Set(row.map((cell) => cell.color)).size === PRISM_COLORS.length) rainbowRows += 1;
    }
  }
  const score = filled * 1 + rainbowRows * 3 - empty * 1;
  return { filled, empty, rainbowRows, score };
}

/** One game, House Dice's flow (startPrismGame, placePrismDie, resolvePrismPoolState) with seeded dice. */
export class PrismGame {
  constructor(seed) {
    this.rand = mulberry32(seed >>> 0);
    this.grid = Array(PRISM_SIZE).fill(null);
    this.pool = [];
    this.totalDrafted = 0;
    this.over = false;
    this.casts = 0;
    this.moves = [];
    const { pool, drafted } = this.findViablePrismPool(this.grid, 0);
    this.pool = pool;
    this.totalDrafted = drafted;
    if (drafted >= PRISM_MAX_DRAFTED) this.over = true;
  }

  prismRollPool(count) {
    const dice = [];
    for (let i = 0; i < count; i++) {
      const color = PRISM_COLORS[Math.floor(this.rand() * PRISM_COLORS.length)].id;
      const number = 1 + Math.floor(this.rand() * 6);
      dice.push({ color, number });
    }
    return dice;
  }

  findViablePrismPool(grid, totalDrafted) {
    let pool = this.prismRollPool(4);
    let drafted = totalDrafted;
    let attempts = 0;
    while (!pool.some((d) => prismLegalCells(grid, d).length > 0) && attempts < 30) {
      drafted += pool.length;
      pool = this.prismRollPool(4);
      attempts++;
    }
    this.casts += 1;
    // The one change from House Dice: a pool still stuck after its 30 recasts ends the game.
    if (!pool.some((d) => prismLegalCells(grid, d).length > 0)) this.over = true;
    return { pool, drafted };
  }

  legalMask(i) {
    if (this.over || i < 0 || i >= this.pool.length) return 0;
    let mask = 0;
    for (const cell of prismLegalCells(this.grid, this.pool[i])) mask |= 1 << cell;
    return mask;
  }

  place(i, cellIdx) {
    if (this.over || i < 0 || i >= this.pool.length) return false;
    const die = this.pool[i];
    if (!(cellIdx >= 0 && cellIdx < PRISM_SIZE) || !prismIsLegalCell(this.grid, cellIdx, die)) return false;
    const newGrid = [...this.grid];
    newGrid[cellIdx] = { color: die.color, number: die.number };
    const newPool = this.pool.filter((_, k) => k !== i);
    const newTotal = this.totalDrafted + 1;
    this.grid = newGrid;
    this.pool = newPool;
    this.totalDrafted = newTotal;
    this.moves.push(i * PRISM_SIZE + cellIdx);
    this.resolvePrismPoolState(newGrid, newPool, newTotal);
    return true;
  }

  resolvePrismPoolState(grid, pool, totalDrafted) {
    const filled = grid.filter((c) => c != null).length;
    if (filled >= PRISM_SIZE || totalDrafted >= PRISM_MAX_DRAFTED) {
      this.over = true;
      return;
    }
    if (pool.length === 0) {
      const { pool: freshPool, drafted } = this.findViablePrismPool(grid, totalDrafted);
      this.pool = freshPool;
      this.totalDrafted = drafted;
      if (drafted >= PRISM_MAX_DRAFTED) this.over = true;
      return;
    }
    const anyLegal = pool.some((d) => prismLegalCells(grid, d).length > 0);
    if (!anyLegal) {
      const newTotal = totalDrafted + pool.length;
      const { pool: freshPool, drafted } = this.findViablePrismPool(grid, newTotal);
      this.pool = freshPool;
      this.totalDrafted = drafted;
      if (drafted >= PRISM_MAX_DRAFTED) this.over = true;
    }
  }

  result() {
    return computePrismScore(this.grid);
  }
}
