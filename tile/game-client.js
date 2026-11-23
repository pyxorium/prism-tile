// Game Host Kit: the game's side (PROTOCOL.md, version 1). No packages; put this file in your tile next to your game.
//
//   import { connectToHost } from "./game-client.js";
//   const host = await connectToHost();
//   host.on("offers", (offers) => { saveButton.hidden = !host.canSave("com.example.game.run"); });
//   host.on("player", (player) => { ... player.did, player.handle, or null ... });
//   host.on("character", (c) => { ... c.image, c.frameWidth, c.frameHeight, c.entry ... });
//   const r = await host.save({ collection: "com.example.game.run", record: { score: 42 } });
//
// With no host at all (opened on its own, or in a gallery that doesn't answer), nothing is offered and the game just
// plays: show a feature only once the host offers it.
//
// MIT licence (LICENSE). https://tangled.org/colorado.atprotocol.space/game-host-kit

export const VERSION = 1;
export const SAVE_ERRORS = Object.freeze(["declined", "not-allowed", "invalid", "failed"]);
const CHARACTER_STATES = ["ready", "searching", "loading", "no-sprite", "error", "cancelled"];

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const whole = (n) => Number.isInteger(n) && n > 0 && n <= 16384;

/**
 * createGameClient({ send }) → the game's side, without any wiring (connectToHost does the wiring).
 *   send(payload): deliver a payload to the host, or null when there is no host.
 */
export function createGameClient({ send = null, timeoutMs = 0 } = {}) {
  const listeners = new Map();          // event → Set(fn)
  const offers = new Set();
  let collections = [];
  let player;                           // undefined: not told; null: no one; { did, handle }
  let character = null;
  let hostVersion = null;
  let saves = 0;
  const pending = new Map();            // id → { resolve, onStatus, timer }

  const emit = (event, value) => {
    for (const fn of listeners.get(event) || []) { try { fn(value); } catch (e) { setTimeout(() => { throw e; }); } }
  };
  const out = (payload) => { if (send) { try { send(payload); return true; } catch { return false; } } return false; };
  const offer = (...names) => {
    let changed = false;
    for (const n of names) if (!offers.has(n)) { offers.add(n); changed = true; }
    if (changed) emit("offers", new Set(offers));
  };

  function handle(m) {
    if (!isObj(m) || typeof m.kind !== "string") return;
    switch (m.kind) {
      case "host": {
        if (Number.isInteger(m.v)) hostVersion = m.v;
        const list = Array.isArray(m.offers) ? m.offers.filter((x) => typeof x === "string") : [];
        offer(...list);
        return;
      }
      case "player": {
        offer("player");
        player = typeof m.did === "string" && m.did.startsWith("did:")
          ? { did: m.did, handle: typeof m.handle === "string" ? m.handle.replace(/^@/, "") : null } : null;
        emit("player", player);
        return;
      }
      case "sprite-status": {
        offer("character");                                     // (a host from before this kit)
        if (CHARACTER_STATES.includes(m.state)) emit("character-status", m.state);
        return;
      }
      case "sprite": {
        offer("character");
        if (!m.image || !whole(m.frameWidth) || !whole(m.frameHeight) || !whole(m.sheetWidth) || !whole(m.sheetHeight)) return;
        character = {
          image: m.image, frameWidth: m.frameWidth, frameHeight: m.frameHeight, sheetWidth: m.sheetWidth, sheetHeight: m.sheetHeight,
          handle: typeof m.handle === "string" ? m.handle.replace(/^@/, "") : null,
          did: typeof m.did === "string" ? m.did : null,
          from: m.from === "compendium" || m.from === "record" ? m.from : null,
          entry: isObj(m.entry) ? m.entry : null,
        };
        emit("character", character);
        return;
      }
      case "can-save": {
        collections = Array.isArray(m.collections) ? m.collections.filter((c) => typeof c === "string") : [];
        if (collections.length) { offers.add("save"); offers.add("open-record"); }
        emit("offers", new Set(offers));                         // (once, even when only the collections changed)
        return;
      }
      case "write-record-status": {
        const p = pending.get(m.id);
        if (p && (m.state === "asking" || m.state === "saving") && p.onStatus) { try { p.onStatus(m.state); } catch { /* the game's own */ } }
        return;
      }
      case "write-record-result": {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok === true && typeof m.uri === "string" && m.uri.startsWith("at://")) {
          p.resolve({ ok: true, uri: m.uri, handle: typeof m.handle === "string" ? m.handle.replace(/^@/, "") : null });
        } else {
          p.resolve({ ok: false, error: SAVE_ERRORS.includes(m.error) ? m.error : "failed" });
        }
        return;
      }
      default:
    }
  }

  const canSave = (collection) => offers.has("save") && collections.includes(collection);

  return {
    handle,
    /** Say hello (connectToHost does this for you). */
    hello() { out({ kind: "hello", v: VERSION }); },
    /** on(event, fn): "offers" (a Set), "player" ({ did, handle } or null), "character", "character-status". Returns off(). */
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    offers: (name) => offers.has(name),
    canSave,
    get hasHost() { return !!send; },
    get hostVersion() { return hostVersion; },
    get player() { return player; },
    get character() { return character; },
    /** The player pressed your character button. Show it only once offers("character"). */
    requestCharacter() { return out({ kind: "sprite-request" }); },
    /**
     * save({ collection, record, onStatus }) → Promise<{ ok: true, uri, handle } | { ok: false, error }>
     * Send only your game's own fields; the host adds $type, createdAt and which game and version this is.
     * onStatus("asking" | "saving") while the host works on it. One save at a time.
     */
    save({ collection, record, onStatus = null } = {}) {
      if (!canSave(collection)) return Promise.resolve({ ok: false, error: "not-allowed" });
      if (pending.size) return Promise.resolve({ ok: false, error: "failed" });
      saves += 1;
      const id = `save-${saves}`;
      return new Promise((resolve) => {
        const p = { resolve, onStatus, timer: null };
        if (timeoutMs > 0) p.timer = setTimeout(() => { if (pending.get(id) === p) { pending.delete(id); resolve({ ok: false, error: "failed" }); } }, timeoutMs);
        pending.set(id, p);
        if (!out({ kind: "write-record", id, action: "create", collection, record })) { pending.delete(id); clearTimeout(p.timer); resolve({ ok: false, error: "failed" }); }
      });
    },
    /** Show a record the host saved for you (its uri from save()). false when the host doesn't offer it. */
    openRecord(uri) { return offers.has("open-record") && typeof uri === "string" ? out({ kind: "open-record", uri }) : false; },
    /** Show this person; the host decides where. false when the host doesn't offer it: use a plain link instead. */
    openProfile(did) { return offers.has("open-profile") && typeof did === "string" ? out({ kind: "open-profile", did }) : false; },
  };
}

/**
 * connectToHost(options) → a client, already said hello. Tries, in order:
 *   1. the tile loader's data channel (/.well-known/web-tiles/data.js), the normal case for a published tile;
 *   2. a plain iframe (window.parent.postMessage), for testing on a local page;
 *   3. no host: the client offers nothing and the game plays on its own.
 * options: { name } (a label sent along in a plain iframe, so a test page can tell games apart), timeoutMs (for save).
 */
export async function connectToHost({ name = "game", timeoutMs = 0, dataUrl = "/.well-known/web-tiles/data.js" } = {}) {
  let client = null;
  try {
    const data = await import(/* @vite-ignore */ dataUrl);
    client = createGameClient({ send: (payload) => data.sendData(payload), timeoutMs });
    data.addDataHandler((m) => client.handle(m));
    data.listen();
  } catch {
    if (typeof window !== "undefined" && window.parent && window.parent !== window) {
      const parent = window.parent;
      client = createGameClient({ send: (payload) => parent.postMessage({ source: name, ...payload }, "*"), timeoutMs });
      window.addEventListener("message", (e) => { if (e.source === parent) client.handle(e.data); });
    } else {
      client = createGameClient({ send: null, timeoutMs });
    }
  }
  client.hello();
  return client;
}
