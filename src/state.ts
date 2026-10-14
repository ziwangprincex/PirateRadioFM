// Shared NowPlaying state. Persisted to disk so each CLI invocation sees the
// prior process's state (current genre, Spotify tokens). NOTE: player/watchdog
// PIDs deliberately do NOT live here anymore — they're in registry.ts under a
// cross-process lock, because two CLIs writing this file concurrently used to
// lost-update each other's PID and orphan the player.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { dataDir, sessionId, readAnchor } from "./session.js";
import { checkCancelled, operationSignal } from "./http.js";
export { writeAnchor, clearAnchor, readAnchor, anchorAlive, type Anchor } from "./session.js";
import { livePlayerCountUnlocked } from "./registry.js";
import { withCrossProcessLock, acquireAsyncCrossProcessLock } from "./lock.js";

export type PlayState = "stopped" | "playing" | "paused";
export type Source = "radio" | "spotify" | "podcast" | "applemusic" | "hoer";

export interface NowPlaying {
  revision: number;
  state: PlayState;
  source: Source | null;
  genre: string | null;
  stationName: string | null;
  stationIndex: number;
  title: string | null;
  volume: number;
  spotifyVerifier: string | null; // PKCE verifier held between /spotify-login and /spotify-complete
  podcastFeed: string | null;     // RSS feed URL of the current podcast
  podcastName: string | null;     // podcast (channel) display name
  episodeIndex: number;           // 0 = newest episode in the feed
}

const stateDir = dataDir();
const stateFilePath = join(stateDir, "state.json");
const stateLockPath = join(stateDir, "state.lock");
const defaults: NowPlaying = {
  revision: 0,
  state: "stopped",
  source: null,
  genre: null,
  stationName: null,
  stationIndex: 0,
  title: null,
  volume: 80,
  spotifyVerifier: null,
  podcastFeed: null,
  podcastName: null,
  episodeIndex: 0,
};

interface Transaction { draft: NowPlaying; base: NowPlaying; revision?: number; session: string; release?: () => void; }
const transactions = new AsyncLocalStorage<Transaction | undefined>();
const fallback = { ...defaults };
export const now: NowPlaying = new Proxy(fallback, {
  get: (target, key) => Reflect.get(transactions.getStore()?.draft ?? target, key),
  set: (target, key, value) => Reflect.set(transactions.getStore()?.draft ?? target, key, value),
  ownKeys: () => Reflect.ownKeys(defaults),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});
export function loadState(): void {
  withCrossProcessLock(stateLockPath, () => loadStateUnlocked());
}
function snapshot(): NowPlaying {
  return transactions.run(undefined, () => {
    loadStateUnlocked();
    return { ...fallback };
  });
}
function ensureCurrent(tx: Transaction, current: NowPlaying): void {
  const anchor = readAnchor();
  if ((!tx.release && tx.revision !== undefined && current.revision !== tx.revision) ||
      (tx.session !== "legacy" && anchor?.sessionId !== tx.session) ||
      (anchor?.sessionId && anchor.sessionId !== tx.session)) {
    throw new Error("Playback request superseded by a newer command or session");
  }
}
export async function withState<T>(fn: () => Promise<T> | T, mutation = false): Promise<T> {
  const base = withCrossProcessLock(stateLockPath, () => {
    const state = snapshot();
    if (mutation) {
      state.revision++;
      writeSnapshot(state);
    }
    return state;
  });
  const tx: Transaction = { base, draft: { ...base }, revision: mutation ? base.revision : undefined, session: sessionId() };
  return transactions.run(tx, async () => {
    try {
      const out = await fn();
      if (!tx.release) checkCancelled();
      withCrossProcessLock(stateLockPath, () => {
        const latest = snapshot();
        ensureCurrent(tx, latest);
        for (const key of Object.keys(defaults) as (keyof NowPlaying)[]) {
          if (key === "revision" || tx.draft[key] === tx.base[key]) continue;
          if (latest[key] !== tx.base[key]) throw new Error(`Concurrent state update: ${key}`);
          (latest as unknown as Record<string, unknown>)[key] = tx.draft[key];
        }
        writeSnapshot(latest);
      });
      return out;
    } finally { tx.release?.(); }
  });
}
// External effects are serialized separately from state reads/writes. Requests
// resolve media first, then revalidate the intent immediately before acting.
export async function playbackEffect<T>(fn: () => Promise<T> | T): Promise<T> {
  checkCancelled();
  const tx = transactions.getStore();
  if (tx?.release) return await fn();
  const releaseSession = await acquireAsyncCrossProcessLock(join(stateDir, "session.lock"), operationSignal());
  let releasePlayback: (() => void) | undefined;
  const release = () => { releasePlayback?.(); releaseSession(); };
  try { releasePlayback = await acquireAsyncCrossProcessLock(join(stateDir, "playback.lock"), operationSignal()); }
  catch (e) { releaseSession(); throw e; }
  try {
    checkCancelled();
    if (tx) withCrossProcessLock(stateLockPath, () => {
      const current = snapshot();
      ensureCurrent(tx, current);
      const draft = { ...current };
      for (const key of Object.keys(defaults) as (keyof NowPlaying)[]) {
        if (key !== "revision" && tx.draft[key] !== tx.base[key])
          (draft as unknown as Record<string, unknown>)[key] = tx.draft[key];
      }
      tx.base = current;
      tx.draft = draft;
      tx.release = release;
    });
    return await fn();
  } finally { if (!tx?.release) release(); }
}

// Internal read that the lock helper wraps. Also used by saveState so the
// read-modify-write sequence for a single caller runs under one lock acquisition.
// Per-field expected primitive type. Written by hand because `typeof defaults[k]`
// gives "object" for nullable string fields (e.g. source starts as null), which
// would then reject a valid string value like "radio". If you add a NowPlaying
// field, add its type here too.
const fieldType: Record<keyof NowPlaying, "string" | "number"> = {
  revision: "number",
  state: "string",
  source: "string",
  genre: "string",
  stationName: "string",
  stationIndex: "number",
  title: "string",
  volume: "number",
  spotifyVerifier: "string",
  podcastFeed: "string",
  podcastName: "string",
  episodeIndex: "number",
};

function loadStateUnlocked(): void {
  if (!existsSync(stateFilePath)) {
    Object.assign(now, defaults);
    return;
  }
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(stateFilePath, "utf8")) as Record<string, unknown>;
  } catch {
    // Whole-file parse failure — reset to defaults and move on. This is rare
    // (atomic write should prevent truncation) but if it happens the alternative
    // is crashing every subsequent tool call.
    process.stderr.write("radiohead: state.json unreadable, resetting to defaults\n");
    Object.assign(now, defaults);
    return;
  }
  // Per-field: accept a value of the expected primitive type, or null only for
  // fields whose default is null (source, genre, …). Non-nullable fields like
  // volume/state must never load as null — a null volume would end up on mpv's
  // command line. Anything else falls back to that field's default, salvaging
  // good fields even when one is corrupt.
  const target = now as unknown as Record<string, unknown>;
  for (const key of Object.keys(defaults) as (keyof NowPlaying)[]) {
    const got = raw?.[key];
    if ((got === null && defaults[key] === null) || typeof got === fieldType[key]) target[key] = got;
    else target[key] = defaults[key];
  }
  if (!Number.isSafeInteger(now.revision) || now.revision < 0) now.revision = 0;
}

function saveStateUnlocked(): void { writeSnapshot({ ...now }); }
function writeSnapshot(value: NowPlaying): void {
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${stateFilePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, stateFilePath);
}

// Atomic write (temp + rename) so a hard-killed process can't leave a truncated
// state.json that loadState would then discard as corrupt. Held under a cross-
// process lock so concurrent CLI + MCP writers can't lost-update each other's
// fields (before this, e.g. a volume change would silently overwrite a genre
// change from a parallel CLI).
export function saveState(): void {
  withCrossProcessLock(stateLockPath, () => saveStateUnlocked());
}

export function describe(): string {
  if (now.state === "stopped" || !now.source) return "Stopped.";
  // Reconcile with reality for the local-player paths (radio, podcast): if the
  // mpv/ffplay we recorded is dead (crashed, OOM, user-kill), the on-disk state
  // still says "playing" until the next explicit stop/play. Show that honestly.
  // We don't do this for Spotify/Apple Music — their players are remote apps
  // and we'd need an API/osascript call.
  const localSource = now.source === "radio" || now.source === "podcast" || now.source === "hoer";
  if (localSource && now.state === "playing" && livePlayerCountUnlocked() === 0) {
    return "Stopped (player exited unexpectedly).";
  }
  const what =
    now.source === "radio"
      ? `${now.genre} radio — ${now.stationName}`
      : now.source === "podcast"
        ? `Podcast ${now.podcastName ?? "(unknown)"} — ${now.title ?? "(unknown)"}`
        : now.source === "hoer"
          ? `HÖR Berlin — ${now.title ?? "(unknown)"}`
          : now.source === "applemusic"
            ? `Apple Music — ${now.title ?? "(unknown)"}`
            : `Spotify — ${now.title ?? "(unknown)"}`;
  return `${now.state === "paused" ? "Paused" : "Playing"}: ${what} (vol ${now.volume})`;
}
