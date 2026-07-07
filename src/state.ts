// Shared NowPlaying state. Persisted to disk so each CLI invocation sees the
// prior process's state (current genre, Spotify tokens). NOTE: player/watchdog
// PIDs deliberately do NOT live here anymore — they're in registry.ts under a
// cross-process lock, because two CLIs writing this file concurrently used to
// lost-update each other's PID and orphan the player.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { procStartToken, sameProcess } from "./proc.js";
import { livePlayerCountUnlocked } from "./registry.js";
import { withCrossProcessLock } from "./lock.js";

export type PlayState = "stopped" | "playing" | "paused";
export type Source = "radio" | "spotify";

export interface NowPlaying {
  state: PlayState;
  source: Source | null;
  genre: string | null;
  stationName: string | null;
  stationIndex: number;
  title: string | null;
  volume: number;
  spotifyVerifier: string | null; // PKCE verifier held between /spotify-login and /spotify-complete
}

const stateDir = join(homedir(), ".pirate-radio");
const statePath = join(stateDir, "state.json");
const stateLockPath = join(stateDir, "state.lock");
// The MCP server writes its own PID + start-token here on startup. It is a child
// of the Claude Code session, so when the session/terminal closes (even a hard
// kill) this process dies. The watchdog polls this to know when to stop music.
// The token defeats PID reuse: a recycled anchor PID won't match the token, so
// the watchdog correctly treats the session as dead instead of "still alive".
const anchorPath = join(stateDir, "anchor.json");

const defaults: NowPlaying = {
  state: "stopped",
  source: null,
  genre: null,
  stationName: null,
  stationIndex: 0,
  title: null,
  volume: 80,
  spotifyVerifier: null,
};

// Mutable proxy of the on-disk state. tools.ts writes to this via `now.x = y`,
// then cli.ts calls saveState() before exiting.
export const now: NowPlaying = { ...defaults };

export function loadState(): void {
  withCrossProcessLock(stateLockPath, () => loadStateUnlocked());
}

// Run a mutation with state.json fresh-loaded on entry and atomically persisted
// on exit, all under one lock acquisition. This is what tool handlers should use
// instead of loadState/mutate/saveState separately — that pattern lets a second
// writer sneak in between load and save and lost-update fields it didn't touch.
export async function withState<T>(fn: () => Promise<T> | T): Promise<T> {
  // Note the lock is held across the async fn — Spotify API calls can therefore
  // hold it for hundreds of ms. Alternatives (optimistic reload-on-save) are
  // more code for a tool where concurrent tool calls are rare. Keep it simple.
  return withCrossProcessLock<Promise<T>>(stateLockPath, async () => {
    loadStateUnlocked();
    const out = await fn();
    saveStateUnlocked();
    return out;
  });
}

// Internal read that the lock helper wraps. Also used by saveState so the
// read-modify-write sequence for a single caller runs under one lock acquisition.
// Per-field expected primitive type. Written by hand because `typeof defaults[k]`
// gives "object" for nullable string fields (e.g. source starts as null), which
// would then reject a valid string value like "radio". If you add a NowPlaying
// field, add its type here too.
const fieldType: Record<keyof NowPlaying, "string" | "number"> = {
  state: "string",
  source: "string",
  genre: "string",
  stationName: "string",
  stationIndex: "number",
  title: "string",
  volume: "number",
  spotifyVerifier: "string",
};

function loadStateUnlocked(): void {
  if (!existsSync(statePath)) return;
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
  } catch {
    // Whole-file parse failure — reset to defaults and move on. This is rare
    // (atomic write should prevent truncation) but if it happens the alternative
    // is crashing every subsequent tool call.
    process.stderr.write("pirate-radio: state.json unreadable, resetting to defaults\n");
    Object.assign(now, defaults);
    return;
  }
  // Per-field: accept null (all fields except stationIndex/volume are nullable
  // in effect) or a value of the expected primitive type; otherwise fall back
  // to that field's default. Salvages good fields even when one is corrupt.
  const target = now as unknown as Record<string, unknown>;
  for (const key of Object.keys(defaults) as (keyof NowPlaying)[]) {
    const got = raw[key];
    if (got === null || typeof got === fieldType[key]) target[key] = got;
    else target[key] = defaults[key];
  }
}

function saveStateUnlocked(): void {
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(now, null, 2));
  renameSync(tmp, statePath);
}

// Atomic write (temp + rename) so a hard-killed process can't leave a truncated
// state.json that loadState would then discard as corrupt. Held under a cross-
// process lock so concurrent CLI + MCP writers can't lost-update each other's
// fields (before this, e.g. a volume change would silently overwrite a genre
// change from a parallel CLI).
export function saveState(): void {
  withCrossProcessLock(stateLockPath, () => saveStateUnlocked());
}

// --- session anchor -------------------------------------------------------
// The MCP server calls writeAnchor(process.pid) on startup. The watchdog reads
// it via readAnchor() and polls anchorAlive() to detect session death.
export interface Anchor { pid: number; token: string | null; }

export function writeAnchor(pid: number): void {
  mkdirSync(stateDir, { recursive: true });
  const anchor: Anchor = { pid, token: procStartToken(pid) };
  const tmp = `${anchorPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(anchor));
  renameSync(tmp, anchorPath);
}

export function readAnchor(): Anchor | null {
  if (!existsSync(anchorPath)) return null;
  try {
    const a = JSON.parse(readFileSync(anchorPath, "utf8")) as Partial<Anchor>;
    if (typeof a.pid === "number" && a.pid > 0) {
      return { pid: a.pid, token: a.token ?? null };
    }
  } catch {
    /* corrupt anchor file */
  }
  return null;
}

// True iff the anchored session process is still the SAME live process. A reused
// PID (session died, OS handed the number to something else) fails the token
// check and returns false — which is what lets the watchdog stop the music.
export function anchorAlive(anchor: Anchor | null): boolean {
  if (!anchor) return false;
  return sameProcess(anchor.pid, anchor.token);
}

export function clearAnchor(): void {
  try { unlinkSync(anchorPath); } catch { /* already gone */ }
}

export function describe(): string {
  if (now.state === "stopped") return "Stopped.";
  // Reconcile with reality for the local radio path: if the mpv/ffplay we
  // recorded is dead (crashed, OOM, user-kill), the on-disk state still says
  // "playing" until the next explicit stop/play. Show that honestly. We don't
  // do this for Spotify — its "device" is remote and we'd need an API call.
  if (now.source === "radio" && now.state === "playing" && livePlayerCountUnlocked() === 0) {
    return "Stopped (player exited unexpectedly).";
  }
  const what =
    now.source === "radio"
      ? `${now.genre} radio — ${now.stationName}`
      : `Spotify — ${now.title ?? "(unknown)"}`;
  return `${now.state === "paused" ? "Paused" : "Playing"}: ${what} (vol ${now.volume})`;
}
