// Publishing: the lexicon (scripts/publish-lexicons.mjs) and the tile (scripts/publish-tile.mjs), against a stand-in
// account server; and the lexicon against the records the game actually makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPublish, newTid, rakuLink, readManifestFields, ACCOUNT, COLLECTION, FILES, ICONS, ENGINE_CID } from '../scripts/publish-tile.mjs';
import { runPublish as runLexicons, readLexicons, TXT, FAMILY } from '../scripts/publish-lexicons.mjs';
import { rawCid } from '../scripts/lib/cid.js';
import { dagCborCid } from '../scripts/lib/dagcbor.js';
import { loadEngine } from '../engine/engine.js';
import { recordFromGame, COLLECTION as GAME_COLLECTION } from '../tile/prism-record.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url));
const PDS = 'https://fibercap.us-west.host.bsky.network';
const PASSWORD = 'abcd-efgh-ijkl-mnop';
const quiet = () => {};
const yes = async () => 'y';
const KEY = '3n2xprismtest';

function server({ password = PASSWORD, swapFails = false, sessionDid = ACCOUNT.did } = {}) {
  const records = new Map();           // collection/rkey -> { cid, value }
  const blobs = new Map();
  const calls = [];
  let n = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.pathname.split('/').pop().split('.').pop());
    if (u.host === 'plc.directory') return json({ id: ACCOUNT.did, alsoKnownAs: [`at://${ACCOUNT.handle}`], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    if (u.pathname.endsWith('createSession')) return JSON.parse(init.body).password === password ? json({ did: sessionDid, accessJwt: 'jwt' }) : json({ error: 'AuthenticationRequired', message: 'Invalid identifier or password' }, 401);
    if (u.pathname.endsWith('getRecord')) {
      const k = `${u.searchParams.get('collection')}/${u.searchParams.get('rkey')}`;
      const r = records.get(k);
      if (!r) return json({ error: 'RecordNotFound', message: 'Could not locate record' }, 400);
      // A real server hands records back in its own key order.
      return json({ uri: `at://${ACCOUNT.did}/${k}`, cid: r.cid, value: Object.fromEntries(Object.entries(r.value).reverse()) });
    }
    if (u.pathname.endsWith('uploadBlob')) {
      const bytes = new Uint8Array(init.body);
      const cid = await rawCid(bytes);
      blobs.set(cid, { bytes, type: init.headers['Content-Type'] });
      return json({ blob: { $type: 'blob', ref: { $link: cid }, mimeType: init.headers['Content-Type'], size: bytes.length } });
    }
    if (u.pathname.endsWith('createRecord') || u.pathname.endsWith('putRecord')) {
      const b = JSON.parse(init.body);
      const k = `${b.collection}/${b.rkey}`;
      const had = records.get(k);
      if (u.pathname.endsWith('createRecord') && had) return json({ error: 'InvalidRequest', message: 'Record already exists' }, 400);
      if (u.pathname.endsWith('putRecord') && b.collection === COLLECTION && (swapFails || !had || b.swapRecord !== had.cid)) return json({ error: 'InvalidSwap', message: 'Record was at bafy…' }, 400);
      const cid = `bafyreiprism${++n}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
      records.set(k, { cid, value: b.record });
      return json({ uri: `at://${ACCOUNT.did}/${k}`, cid });
    }
    return json({ error: 'NotFound' }, 404);
  };
  return { fetchImpl, calls, blobs, records };
}
function store(initial = null) {
  let pub = initial;
  return { readPublished: () => pub, writePublished: (o) => { pub = structuredClone(o); }, get published() { return pub; } };
}
const base = (s, st, over = {}) => ({ fetchImpl: s.fetchImpl, ask: yes, askHidden: async () => PASSWORD, log: quiet, env: {}, saveBackup: () => {},
  readPublished: st.readPublished, writePublished: st.writePublished, tid: () => KEY, now: () => new Date('2026-11-22T20:00:00Z'), ...over });

// ---- the tile ----

test('the files Prism publishes, and the approved engine', async () => {
  assert.deepEqual(FILES.map((f) => f.path), ['/', '/engine.wasm', '/engine.js', '/prism-record.js', '/game-client.js', '/icon.png', '/silkscreen.woff', '/Silkscreen-OFL.txt']);
  // The Retro CRT look's pixel font travels with its licence (SIL Open Font License), and the page loads it from beside itself.
  assert.match(read('tile/Silkscreen-OFL.txt').toString(), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(read('tile/index.html').toString(), /url\("\.\/silkscreen\.woff"\)/);
  assert.equal(read('tile/silkscreen.woff').subarray(0, 4).toString(), 'wOFF');
  assert.equal(FILES.find((f) => f.path === '/engine.wasm').type, 'application/wasm');
  for (const f of FILES) assert.ok(read(f.file.replaceAll('\\', '/')).length > 0, f.file);
  assert.equal(await rawCid(new Uint8Array(read('engine/engine.wasm'))), ENGINE_CID);
  assert.equal(ACCOUNT.handle, 'thunderbird.cafe');
  const html = read('tile/index.html').toString();
  for (const f of FILES.filter((x) => x.path.endsWith('.js'))) assert.match(html, new RegExp(`from "\\.${f.path.replace('.', '\\.')}"`), `index.html imports ${f.path} from beside itself`);
  assert.match(html, /fetch\("\.\/engine\.wasm"\)/);
  assert.doesNotMatch(html, /\.\.\//, 'nothing from outside the tile');
  assert.doesNotMatch(read('tile/manifest.json').toString() + html, /\bmu\b/i);
  const m = readManifestFields(read('tile/manifest.json').toString());
  assert.equal(m.name, 'Prism');
  assert.deepEqual(m.sizing, { width: 380, height: 460 });
});

test('a dry run, the first time: says it makes a new record, writes nothing', async () => {
  const s = server(); const st = store();
  const lines = [];
  const r = await runPublish(base(s, st, { dryRun: true, log: (l) => lines.push(l) }));
  assert.equal(r.changed, false);
  assert.deepEqual(r.due, FILES.map((f) => f.path));
  assert.match(lines.join('\n'), /makes a new record/);
  assert.match(lines.join('\n'), new RegExp(`Engine: ${ENGINE_CID} \\(the approved one\\)`));
  assert.deepEqual(s.calls, [ACCOUNT.did]);   // plc.directory only
  assert.equal(st.published, null);
});

test('the first publish: a new record from thunderbird.cafe, its manifest address right, published.json\'s tile part written', async () => {
  const s = server(); const st = store({ account: { handle: 'thunderbird.cafe', did: ACCOUNT.did }, lexicons: { 'cafe.thunderbird.prism.game': { uri: 'at://x', cid: 'bafy', text: '{}' } } });
  const r = await runPublish(base(s, st));
  assert.equal(r.changed, true);
  assert.equal(r.uri, `at://${ACCOUNT.did}/${COLLECTION}/${KEY}`);
  assert.ok(s.calls.includes('createRecord') && !s.calls.includes('putRecord'));
  const rec = s.records.get(`${COLLECTION}/${KEY}`).value;
  assert.equal(rec.$type, COLLECTION);
  assert.equal(rec.cid, await dagCborCid(rec.tile));
  assert.deepEqual(Object.keys(rec.tile.resources).sort(), FILES.map((f) => f.path).sort());
  assert.equal(rec.tile.resources['/engine.wasm']['content-type'], 'application/wasm');
  assert.equal(rec.tile.resources['/engine.wasm'].src.ref.$link, ENGINE_CID);
  assert.deepEqual(rec.tile.icons, ICONS);
  assert.equal(rec.tile.name, 'Prism');
  for (const f of FILES) assert.equal(rec.tile.resources[f.path].src.ref.$link, await rawCid(new Uint8Array(read(f.file.replaceAll('\\', '/')))));
  assert.equal(st.published.tile.uri, r.uri);
  assert.equal(st.published.tile.engine, ENGINE_CID);
  assert.equal(st.published.tile.raku, rakuLink(r.uri));
  assert.deepEqual(st.published.tile.earlier, []);
  assert.ok(st.published.lexicons['cafe.thunderbird.prism.game'], 'the lexicon part of published.json is kept');
});

test('run again with nothing changed: nothing to do; a changed page: only it uploaded, same address, swapRecord, the engine unchanged', async () => {
  const s = server(); const st = store();
  await runPublish(base(s, st));
  const first = st.published.tile;
  s.calls.length = 0;
  const same = await runPublish(base(s, st));
  assert.equal(same.changed, false);
  assert.ok(!s.calls.includes('createSession'));
  const html = new TextEncoder().encode('<!doctype html><title>changed</title>');
  const readFile = (f) => (f.endsWith('index.html') ? html : new Uint8Array(read(f.replaceAll('\\', '/'))));
  s.calls.length = 0;
  const r = await runPublish(base(s, st, { readFile }));
  assert.equal(r.uri, first.uri);
  assert.equal(s.calls.filter((c) => c === 'uploadBlob').length, 1);
  assert.ok(s.calls.includes('putRecord') && !s.calls.includes('createRecord'));
  assert.equal(st.published.tile.earlier.length, 1);
  assert.equal(st.published.tile.earlier[0].cid, first.cid);
  assert.equal(st.published.tile.files['/'], await rawCid(html));
  assert.equal(st.published.tile.files['/engine.wasm'], ENGINE_CID, 'a page change leaves the engine (and Raku\'s approval) as it was');
});

test('only the approved engine is published', async () => {
  const other = new Uint8Array(read('engine/engine.wasm')); other[other.length - 1] ^= 1;
  // The tile's copy differs from engine\engine.wasm.
  const s1 = server();
  await assert.rejects(runPublish(base(s1, store(), { readFile: (f) => (f === 'tile\\engine.wasm' || f === 'tile/engine.wasm' ? other : new Uint8Array(read(f.replaceAll('\\', '/')))) })), /isn't engine\\engine\.wasm/);
  // Both changed alike: a new engine, not the approved CID.
  const s2 = server();
  await assert.rejects(runPublish(base(s2, store(), { readFile: (f) => (f.endsWith('engine.wasm') ? other : new Uint8Array(read(f.replaceAll('\\', '/')))) })), /not the approved/);
  assert.equal(s1.records.size + s2.records.size, 0);
  assert.ok(!s1.calls.includes('plc.directory') || s1.calls.length <= 1);
});

test('refusals: another account\'s password, a record changed meanwhile, no password, "no" at the question, another account\'s record', async () => {
  await assert.rejects(runPublish(base(server({ sessionDid: 'did:plc:someoneelse' }), store())), /different account/);
  const s3 = server({ swapFails: true }); const st3 = store();
  await runPublish(base(s3, st3));
  const readFile = (f) => (f.endsWith('index.html') ? new TextEncoder().encode('<p>x</p>') : new Uint8Array(read(f.replaceAll('\\', '/'))));
  await assert.rejects(runPublish(base(s3, st3, { readFile })), /changed after it was read/);
  await assert.rejects(runPublish(base(server(), store(), { askHidden: async () => '' })), /No app password/);
  const s4 = server();
  const r = await runPublish(base(s4, store(), { ask: async () => 'n' }));
  assert.equal(r.changed, false);
  assert.equal(s4.records.size, 0);
  await assert.rejects(runPublish(base(server(), store({ tile: { uri: 'at://did:plc:other/ing.dasl.masl/3abc' } }))), /another account/);
  assert.match(newTid(Date.parse('2026-11-22T20:00:00Z'), 5), /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
});

// ---- the lexicon ----

test('the lexicon: one record type under cafe.thunderbird.prism., named by its file, matching the game\'s collection', () => {
  const lexicons = readLexicons();
  assert.deepEqual(lexicons.map((l) => l.id), ['cafe.thunderbird.prism.game']);
  assert.equal(lexicons[0].id, GAME_COLLECTION);
  assert.equal(TXT, '_lexicon.prism');
  assert.equal(FAMILY, 'cafe.thunderbird.prism.');
  const main = lexicons[0].defs.main;
  assert.equal(main.type, 'record');
  assert.equal(main.key, 'tid');
});

/** A small check of a record against the lexicon's object (the parts this lexicon uses). */
function fitsLexicon(def, rec) {
  const problems = [];
  for (const k of def.required) if (!(k in rec)) problems.push(`missing ${k}`);
  for (const [k, v] of Object.entries(rec)) {
    if (k === '$type') continue;
    const p = def.properties[k];
    if (!p) { problems.push(`unknown ${k}`); continue; }
    if (p.type === 'integer' && !(Number.isInteger(v) && (p.minimum ?? -Infinity) <= v && v <= (p.maximum ?? Infinity))) problems.push(`${k} out of range`);
    if (p.type === 'string' && !(typeof v === 'string' && v.length >= (p.minLength ?? 0) && v.length <= (p.maxLength ?? Infinity))) problems.push(`${k} not a fitting string`);
    if (p.type === 'array') {
      if (!Array.isArray(v) || v.length < (p.minLength ?? 0) || v.length > (p.maxLength ?? Infinity)) problems.push(`${k} wrong length`);
      else for (const item of v) {
        if (p.items.type === 'integer' && !(Number.isInteger(item) && item >= p.items.minimum && item <= p.items.maximum)) problems.push(`${k} item ${item}`);
        if (p.items.type === 'string' && !(typeof item === 'string' && item.length <= p.items.maxLength)) problems.push(`${k} item ${item}`);
      }
    }
    if (p.type === 'ref' && !(v && typeof v.uri === 'string' && typeof v.cid === 'string')) problems.push(`${k} not a strongRef`);
    if (p.knownValues && !p.knownValues.includes(v)) problems.push(`${k} not one of ${p.knownValues}`);
  }
  return problems;
}

test('every record the game makes, with what the host adds, fits the lexicon', async () => {
  const def = readLexicons()[0].defs.main.record;
  const engine = await loadEngine(read('engine/engine.wasm'));
  let rand = 99;
  const next = () => { rand = (rand * 1103515245 + 12345) >>> 0; return rand / 4294967296; };
  for (let n = 0; n < 300; n++) {
    const game = n % 2 ? { mode: 'daily', day: '2026-11-22' } : { mode: 'free', seed: n === 0 ? 4294967295 : Math.floor(next() * 4294967296) };
    if (game.mode === 'daily') engine.startDaily(game.day); else engine.start(game.seed);
    let s = engine.state();
    while (!s.over) {
      const legal = [];
      s.pool.forEach((_, i) => engine.legalCells(i).forEach((c) => legal.push([i, c])));
      const [i, c] = legal[Math.floor(next() * legal.length)];
      engine.place(i, c);
      s = engine.state();
    }
    const rec = { $type: GAME_COLLECTION, ...recordFromGame(game, s), game: { uri: 'at://did:plc:x/ing.dasl.masl/3abc', cid: 'bafyreiabc' }, engine: ENGINE_CID, createdAt: '2026-11-22T20:00:00.000Z' };
    assert.deepEqual(fitsLexicon(def, rec), [], JSON.stringify(rec));
  }
  // And the check itself catches what doesn't fit.
  assert.ok(fitsLexicon(def, { mode: 'daily' }).length > 0);
  assert.ok(fitsLexicon(def, { $type: GAME_COLLECTION, game: { uri: 'a', cid: 'b' }, mode: 'daily', moves: [48], board: Array(12).fill('empty'), filled: 0, empty: 12, rainbowRows: 0, score: -12, createdAt: 'x' }).includes('moves item 48'));
});

test('the lexicon publisher: a dry run lists it as new and writes nothing; a publish writes it once, then has nothing to do', async () => {
  const s = server(); const st = store({});
  const r1 = await runLexicons(base(s, st, { dryRun: true }));
  assert.deepEqual(r1.due, ['cafe.thunderbird.prism.game']);
  assert.ok(!s.calls.includes('putRecord'));
  const r2 = await runLexicons(base(s, st));
  assert.equal(r2.changed, true);
  assert.ok(s.records.has('com.atproto.lexicon.schema/cafe.thunderbird.prism.game'));
  assert.equal(st.published.lexicons['cafe.thunderbird.prism.game'].text, JSON.stringify(readLexicons()[0]));
  const r3 = await runLexicons(base(s, st));
  assert.equal(r3.changed, false);
  await assert.rejects(runLexicons(base(server({ sessionDid: 'did:plc:someoneelse' }), store({}))), /different account/);
});

test('both publishers share published.json without losing each other\'s part', async () => {
  const s = server(); const st = store({});
  await runLexicons(base(s, st));
  await runPublish(base(s, st));
  assert.ok(st.published.lexicons['cafe.thunderbird.prism.game'] && st.published.tile.uri);
  await runLexicons(base(s, st, { lexicons: [{ ...readLexicons()[0], description: 'changed' }] }));
  assert.ok(st.published.tile.uri, 'publishing the lexicon again keeps the tile part');
});
