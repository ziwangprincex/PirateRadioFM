// Lock-guarded registry of the player + watchdog processes this tool has spawned.
//
// WHY THIS EXISTS: the MCP server and each slash-command CLI are *separate*
// processes that formerly tracked the mpv/ffplay PID inside the shared
// state.json. Two of them writing state.json concurrently lost-updated each
// other — one process's `play()` would record a PID that another process's
// `pause()` immediately overwrote with null, orphaning the player (nothing left
// pointing at it, so no stop/pause could ever find it). That was the root cause
// of "music keeps playing after the terminal closes".
//
// Fix: player PIDs live in their OWN file, and every mutation happens under an
// atomic lockfile so read-modify-write is serialized across processes. Entries
// carry a start-time token so a reused PID is never mistaken for a live player.
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sameProcess, procStartToken } from "./proc.js";
import { withCrossProcessLock } from "./lock.js";

export interface ProcEntry {
  pid: number;
  token: string | null; // start-time fingerprint captured at spawn (PID-reuse guard)
  host?: string;         // stream host, for diagnostics
}
interface Registry {
  players: ProcEntry[];
  watchdogs: ProcEntry[];
}

const dir = join(homedir(), ".pirate-radio");
const registryPath = join(dir, "players.json");
const lockPath = join(dir, "players.lock");

function readRaw(): Registry {
  if (!existsSync(registryPath)) return { players: [], watchdogs: [] };
  try {
    const r = JSON.parse(readFileSync(registryPath, "utf8")) as Partial<Registry>;
    return { players: r.players ?? [], watchdogs: r.watchdogs ?? [] };
  } catch {
    return { players: [], watchdogs: [] };
  }
}

function writeRaw(r: Registry): void {
  mkdirSync(dir, { recursive: true });
  // Atomic write: a full write to a temp file then rename. rename is atomic on
  // win32/macOS/Linux, so a process killed mid-write (the whole point of this
  // tool — terminals get hard-killed) can never leave a truncated registry that
  // readRaw would parse as "no players" and orphan the stream.
  const tmp = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r, null, 2));
  renameSync(tmp, registryPath);
}

// --- cross-process lock ----------------------------------------------------
// Implemented in lock.ts. We pass our OWN lockPath so registry ops don't block
// state.json ops (which use a separate lock domain).
export function withLock<T>(fn: (r: Registry) => T): T {
  return withCrossProcessLock(lockPath, () => {
    const reg = readRaw();
    const result = fn(reg);
    writeRaw(reg);
    return result;
  });
}

// --- public API (all lock-guarded) -----------------------------------------

// Record a freshly spawned player. Captures its start token for reuse-safety.
export function addPlayer(pid: number, host?: string): void {
  const token = procStartToken(pid);
  withLock((r) => {
    r.players = prune(r.players);
    r.players.push({ pid, token, host });
  });
}

export function addWatchdog(pid: number): void {
  const token = procStartToken(pid);
  withLock((r) => {
    r.watchdogs = prune(r.watchdogs);
    r.watchdogs.push({ pid, token });
  });
}

// Snapshot of currently-live players (reuse-verified).
export function livePlayers(): ProcEntry[] {
  return withLock((r) => {
    r.players = prune(r.players);
    return [...r.players];
  });
}

// Non-blocking count of registered players. Skips the cross-process lock: OK for
// UI display (describe()), NOT OK for anything that mutates. May briefly read a
// registry mid-write; on JSON parse failure we return 0 rather than throw. The
// prune() call still filters dead / recycled pids using the start-token check.
export function livePlayerCountUnlocked(): number {
  try {
    return prune(readRaw().players).length;
  } catch {
    return 0;
  }
}

// Drop a specific pid from the registry without killing it. Used when a spawned
// player/watchdog dies asynchronously (spawn error, immediate exit) — leaving
// the dead pid registered would poison later prune() checks on token-less systems.
export function removePlayer(pid: number): void {
  withLock((r) => { r.players = r.players.filter((e) => e.pid !== pid); });
}
export function removeWatchdog(pid: number): void {
  withLock((r) => { r.watchdogs = r.watchdogs.filter((e) => e.pid !== pid); });
}

// Remove entries and hand them back so the caller can kill them under no lock.
export function drainPlayers(): ProcEntry[] {
  return withLock((r) => {
    const live = prune(r.players);
    r.players = [];
    return live;
  });
}

export function drainWatchdogs(): ProcEntry[] {
  return withLock((r) => {
    const live = prune(r.watchdogs);
    r.watchdogs = [];
    return live;
  });
}

export function drainAll(): { players: ProcEntry[]; watchdogs: ProcEntry[] } {
  return withLock((r) => {
    const players = prune(r.players);
    const watchdogs = prune(r.watchdogs);
    r.players = [];
    r.watchdogs = [];
    return { players, watchdogs };
  });
}

// Drop dead/recycled entries. A null token means we couldn't fingerprint at
// spawn, so fall back to bare liveness (sameProcess handles this).
function prune(list: ProcEntry[]): ProcEntry[] {
  return list.filter((e) => sameProcess(e.pid, e.token));
}
