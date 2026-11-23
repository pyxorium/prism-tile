// What a finished Prism game sends its host to save: only the game's own fields (the host adds $type, createdAt,
// and which tile and version this is). Shared by the page, the tests, and hosts that check a saved game.
//
// The board is 12 strings, row by row from the top left: "red-5", "teal-3", ..., or "empty".
// A daily game carries its day (the America/Denver day), never a seed; a free-play game carries its seed.

export const COLLECTION = 'cafe.thunderbird.prism.game';

export function cellText(cell) {
  return cell ? `${cell.color}-${cell.number}` : 'empty';
}

/** game: { mode: 'daily', day } or { mode: 'free', seed }; state: the engine's state() at the end of the game. */
export function recordFromGame(game, state) {
  const record = { mode: game.mode };
  if (game.mode === 'daily') record.day = game.day;
  else record.seed = game.seed;
  record.moves = [...state.moves];
  record.board = state.board.map(cellText);
  record.filled = state.filled;
  record.empty = state.empty;
  record.rainbowRows = state.rainbowRows;
  record.score = state.score;
  return record;
}

/**
 * Checks a saved game against an engine (from engine.js): it must replay to exactly its board and score.
 * → { ok: true, state } or { ok: false, problem }.
 */
export function checkRecord(engine, record) {
  if (!record || typeof record !== 'object') return { ok: false, problem: 'not a record' };
  let game;
  if (record.mode === 'daily' && typeof record.day === 'string' && !('seed' in record)) game = { day: record.day };
  else if (record.mode === 'free' && Number.isInteger(record.seed) && !('day' in record)) game = { seed: record.seed };
  else return { ok: false, problem: 'mode' };
  const state = engine.replay(game, record.moves);
  if (!state) return { ok: false, problem: "the moves don't replay" };
  const same =
    Array.isArray(record.board) && record.board.length === state.board.length &&
    record.board.every((c, i) => c === cellText(state.board[i])) &&
    record.filled === state.filled && record.empty === state.empty &&
    record.rainbowRows === state.rainbowRows && record.score === state.score;
  return same ? { ok: true, state } : { ok: false, problem: "the board or score doesn't match the moves" };
}
