// Cross-process lock primitive. Used by both the registry (players.json) and
// shared state (state.json) so read-modify-write from CLI + MCP + watchdog can't
// lost-update each other. Each caller passes its OWN lock directory path — the
// two lock domains are independent so registry ops don't block state ops.
//
// mkdir is atomic on win32/macOS/Linux: exactly one caller wins the create.
// A holder file inside records pid + start-token so we can break a lock whose
// owner has died WITHOUT being fooled by PID reuse.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, rmdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pidAlive, procStartToken, sameProcess } from "./proc.js";

const LOCK_STALE_MS = 15_000;
// How long we wait for a LIVE holder before giving up and stealing. Longer than
// the previous 5s because a legit critical section can hold the lock across a
// Spotify API round-trip. Deadlocks with a live holder shouldn't happen — if
// they do, stealing after 30s at least keeps the tool responsive.
const LOCK_WAIT_MS = 30_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withCrossProcessLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const holderFile = join(lockPath, "holder");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath); // atomic: throws EEXIST if held
      break;
    } catch {
      // Held. Break it only if the holder is dead (or PID was recycled).
      let broke = false;
      try {
        const raw = readFileSync(holderFile, "utf8").trim();
        const parts = raw.split("\n");
        const holderPid = Number(parts[0]);
        const holderToken = parts[1] || null;
        // sameProcess checks pidAlive AND token match — a recycled PID with a
        // different start-token is correctly treated as "holder dead". This was
        // bare pidAlive before, which let a recycled PID wedge the lock forever.
        if (!sameProcess(holderPid, holderToken)) broke = true;
      } catch {
        // No holder file yet (racing creator) or unreadable — use age as signal.
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) broke = true;
        } catch {
          /* lock vanished between check and stat — retry */
        }
      }
      if (broke) {
        // Atomic steal: rename the stale lock to a pid-unique temp name. Only
        // ONE process can successfully rename the source (the loser gets ENOENT).
        // This eliminates the old race where two processes both rm -rf'd and
        // both mkdir'd, putting two holders in the critical section.
        const dead = `${lockPath}.dead.${process.pid}`;
        try {
          renameSync(lockPath, dead);
          rmSync(dead, { recursive: true, force: true });
        } catch {
          // rename failed (ENOENT) — another process already stole it. Fine.
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      sleep(50);
    }
  }
  try {
    // Write pid AND start-token so the steal logic can detect PID reuse.
    const token = procStartToken(process.pid) ?? "";
    writeFileSync(holderFile, `${process.pid}\n${token}`);
    const result = fn();
    if (result && typeof (result as unknown as { then?: unknown }).then === "function") {
      return (async () => {
        try {
          return await (result as unknown as Promise<T>);
        } finally {
          release(lockPath);
        }
      })() as T;
    }
    release(lockPath);
    return result;
  } catch (e) {
    release(lockPath);
    throw e;
  }
}

function release(lockPath: string): void {
  try { rmSync(join(lockPath, "holder"), { force: true }); } catch { /* ignore */ }
  try { rmdirSync(lockPath); } catch { /* already gone */ }
}

// Lock-free variants for use in exit/cleanup paths where blocking is not safe.
// These bypass mutual exclusion — only use when the process is about to die and
// no in-process concurrency exists.

export function readRegistryUnsafe(registryPath: string): { players: Array<{ pid: number; token: string | null }>; watchdogs: Array<{ pid: number; token: string | null }> } {
  if (!existsSync(registryPath)) return { players: [], watchdogs: [] };
  try {
    const r = JSON.parse(readFileSync(registryPath, "utf8"));
    return { players: r.players ?? [], watchdogs: r.watchdogs ?? [] };
  } catch {
    return { players: [], watchdogs: [] };
  }
}

export function saveStateUnsafe(statePath: string, data: unknown): void {
  try {
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, statePath);
  } catch { /* best effort */ }
}
