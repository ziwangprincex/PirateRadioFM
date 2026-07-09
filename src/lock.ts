// Cross-process lock primitive. Used by both the registry (players.json) and
// shared state (state.json) so read-modify-write from CLI + MCP + watchdog can't
// lost-update each other. Each caller passes its OWN lock directory path — the
// two lock domains are independent so registry ops don't block state ops.
//
// mkdir is atomic on win32/macOS/Linux: exactly one caller wins the create.
// A holder-pid file inside lets us break a lock whose owner has died.
import { mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pidAlive } from "./proc.js";

const LOCK_STALE_MS = 15_000;
// How long we wait for a LIVE holder before giving up and stealing. Longer than
// the previous 5s because a legit critical section can hold the lock across a
// Spotify API round-trip. Deadlocks with a live holder shouldn't happen — if
// they do, stealing after 30s at least keeps the tool responsive.
const LOCK_WAIT_MS = 30_000;

function sleep(ms: number): void {
  // Synchronous spin-free wait using Atomics — no busy loop, works everywhere.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function statMtime(p: string): number {
  return statSync(p).mtimeMs;
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
      // Held. Break it only if the holder is dead, or if the creator died
      // before writing a holder file. Never age-steal a lock from a live
      // holder: legitimate sections can run longer than LOCK_STALE_MS (for
      // example yt-dlp resolving HÖR), and stealing then reintroduces the
      // lost-update race this lock exists to prevent.
      let broke = false;
      let holderKnownAlive = false;
      let missingHolder = false;
      try {
        const holderPid = Number(readFileSync(holderFile, "utf8").trim());
        if (pidAlive(holderPid)) holderKnownAlive = true;
        else broke = true;
      } catch {
        // No holder file yet (racing creator) — treat age as the signal.
        missingHolder = true;
      }
      if (!broke && missingHolder && !holderKnownAlive) {
        try {
          const age = Date.now() - statMtime(lockPath);
          if (age > LOCK_STALE_MS) broke = true;
        } catch {
          /* lock vanished between check and stat — retry */
        }
      }
      if (broke) {
        forceRelease(lockPath);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      sleep(50);
    }
  }
  try {
    writeFileSync(holderFile, String(process.pid));
    const result = fn();
    // If fn is async, keep the lock until its promise settles. Without this
    // await, `finally` would release the lock the instant fn yielded — the
    // whole point of `withState` (holding state.json's lock across a Spotify
    // API round-trip) would silently break.
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
function forceRelease(lockPath: string): void {
  try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* ignore */ }
}
