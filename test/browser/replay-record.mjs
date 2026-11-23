// Reads a saved Prism record (JSON) on stdin and prints "ok" if it replays through the engine to exactly its board
// and score, or the problem. Used by check_tile.py; also handy by hand:
//   Get-Content record.json | node test/browser/replay-record.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEngine } from '../../engine/engine.js';
import { checkRecord } from '../../tile/prism-record.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = await loadEngine(readFileSync(path.join(root, 'engine', 'engine.wasm')));
const input = readFileSync(0, 'utf8').replace(/^﻿/, '');
const record = JSON.parse(input);
const r = checkRecord(engine, record.value && typeof record.value === 'object' ? record.value : record);
console.log(r.ok ? 'ok' : r.problem);
process.exit(r.ok ? 0 : 1);
