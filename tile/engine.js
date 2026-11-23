// Prism's engine loader, shared by the tile's page, the tests and hosts (Raku keeps a copy).
// No imports of its own and no network: hand it engine.wasm's bytes.
//
//   const engine = await loadEngine(bytes);   // refuses a module that asks for anything
//   engine.startDaily('2026-11-22');          // or engine.start(seed) for free play
//   engine.state();                           // pool, board, draws, over, score parts, moves
//   engine.legalCells(0);                     // cells pool die 0 may go on
//   engine.place(0, 5);                       // true, or false if refused (nothing changes)
//   engine.replay({ day } or { seed }, moves) // the finished game, or null if it doesn't replay
//
// Colours by name: red, lemon, teal, violet. Cells 0 to 11, row by row from the top left. A move is
// one number: which die in the pool (0 to 3, among the dice left, in the order cast) * 12 + the cell.

export const COLOR_NAMES = ['red', 'lemon', 'teal', 'violet'];
export const MAX_ENGINE_BYTES = 64 * 1024;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-22" → [2026, 11, 22], or null if it isn't a real calendar day. */
export function parseDay(day) {
  const m = typeof day === 'string' ? DAY.exec(day) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return [y, mo, d];
}

export async function loadEngine(bytes) {
  const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (!buf || buf.byteLength > MAX_ENGINE_BYTES) throw new Error('engine too big');
  const module = await WebAssembly.compile(buf);
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error('engine asks for imports');
  const instance = await WebAssembly.instantiate(module, {});
  return wrap(instance.exports);
}

function wrap(x) {
  const size = x.rows() * x.cols();

  const die = (i) => ({ color: COLOR_NAMES[x.pool_color(i)], number: x.pool_number(i) });
  const cell = (c) => (x.cell_number(c) === 0 ? null : { color: COLOR_NAMES[x.cell_color(c)], number: x.cell_number(c) });
  const cells = (mask) => {
    const out = [];
    for (let c = 0; c < size; c++) if (mask & (1 << c)) out.push(c);
    return out;
  };

  const api = {
    version: x.engine_version(),
    rows: x.rows(),
    cols: x.cols(),
    size,
    maxDrawn: x.max_drawn(),
    /** The restricted cells: [{ type: 'color', value: 'teal' } | { type: 'number', value: 3 } | null]. */
    layout: Array.from({ length: size }, (_, c) => {
      const kind = x.cell_rule_kind(c), value = x.cell_rule_value(c);
      if (kind === 1) return { type: 'color', value: COLOR_NAMES[value] };
      if (kind === 2) return { type: 'number', value };
      return null;
    }),
    seedForDay(day) {
      const p = parseDay(day);
      if (!p) throw new Error('not a day');
      return x.seed_for_day(p[0], p[1], p[2]) >>> 0;
    },
    start(seed) {
      x.start(seed >>> 0);
    },
    startDaily(day) {
      x.start(api.seedForDay(day));
    },
    legalMask(i) {
      return x.legal_mask(i);
    },
    legalCells(i) {
      return cells(x.legal_mask(i));
    },
    place(i, c) {
      return x.place(i, c) === 1;
    },
    state() {
      const pool = [];
      for (let i = 0; i < x.pool_count(); i++) pool.push(die(i));
      const board = [];
      for (let c = 0; c < size; c++) board.push(cell(c));
      const moves = [];
      for (let k = 0; k < x.move_total(); k++) moves.push(x.move_at(k));
      return {
        pool, board, moves,
        draws: x.draws(), over: x.is_over() === 1, casts: x.cast_count(),
        filled: x.filled(), empty: x.empty_cells(), rainbowRows: x.rainbow_rows(), score: x.score(),
      };
    },
    /** Replays a saved game: { day } (daily) or { seed } (free play), and its moves. → state() or null. */
    replay(game, moves) {
      let seed;
      if (game && typeof game.day === 'string') {
        if (!parseDay(game.day)) return null;
        seed = api.seedForDay(game.day);
      }
      else if (game && Number.isInteger(game.seed) && game.seed >= 0 && game.seed <= 0xffffffff) seed = game.seed;
      else return null;
      if (!Array.isArray(moves) || moves.length > 24) return null;
      if (!moves.every((m) => Number.isInteger(m) && m >= 0 && m < 4 * size)) return null;
      const buffer = new Uint8Array(x.memory.buffer, x.replay_moves(), 24);
      buffer.set(moves);
      if (x.replay(seed, moves.length) !== 1) return null;
      return api.state();
    },
  };
  return api;
}
