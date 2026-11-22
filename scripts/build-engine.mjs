#!/usr/bin/env node
// Builds engine/engine.wasm from engine/prism.c with clang, then prints its size and CID.
//
//   node scripts/build-engine.mjs            build engine/engine.wasm
//   node scripts/build-engine.mjs --check    build to a temporary file and say whether it matches engine/engine.wasm
//
// Needs clang with the wasm32 target (LLVM). The committed engine.wasm was built with clang 18.1.3; another
// clang version may produce different bytes, and so a different CID: only a rules change should ever need a
// rebuild, and Raku approves engines by CID.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rawCid } from './lib/cid.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'engine', 'prism.c');
const target = path.join(root, 'engine', 'engine.wasm');

export const CLANG_ARGS = [
  '--target=wasm32', '-O2', '-nostdlib', '-ffreestanding', '-fno-builtin',
  '-Wall', '-Werror',
  '-Wl,--no-entry', '-Wl,--strip-all', '-Wl,--export-memory=memory',
];

export function build(out, extra = []) {
  execFileSync(process.env.CLANG || 'clang', [...CLANG_ARGS, ...extra, '-o', out, source], { stdio: 'inherit' });
  return readFileSync(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const tmp = path.join(tmpdir(), `prism-engine-check-${process.pid}.wasm`);
    const fresh = build(tmp);
    rmSync(tmp, { force: true });
    const committed = existsSync(target) ? readFileSync(target) : Buffer.alloc(0);
    const same = Buffer.compare(fresh, committed) === 0;
    console.log(`Fresh build: ${fresh.length} bytes, ${rawCid(fresh)}`);
    console.log(`engine.wasm: ${committed.length} bytes, ${rawCid(committed)}`);
    console.log(same ? 'They match.' : 'They DIFFER (a different clang, or prism.c changed).');
    process.exit(same ? 0 : 1);
  }
  const bytes = build(target);
  writeFileSync(target, bytes);
  console.log(`engine/engine.wasm: ${bytes.length} bytes, ${rawCid(bytes)}`);
}
