// Cross-process locks for the registry and shared state. A fully initialized,
// non-empty directory is published with rename: contenders can never observe
// a new lock before its unique owner file exists. Reclaim only the observed
// owner's file, then rmdir (never recursive removal of the shared lock path).
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, rmdirSync, statSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { procStartToken, sameProcess } from "./proc.js";

const LOCK_STALE_MS = 15_000;
// A live holder is NEVER stolen, even if it exceeds this wait budget.
const LOCK_WAIT_MS = 30_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reclaimDeadOwner(lockPath: string): void {
  try {
    const files = readdirSync(lockPath);
    if (files.length === 0) {
      // Compatibility with empty directories left by the old mkdir-first lock.
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) rmdirSync(lockPath);
      return;
    }
    if (files.length !== 1) return;
    const name = files[0];
    // "holder" is the old on-disk format; new owners always have a UUID name.
    if (name !== "holder" && !/^holder-[0-9a-f-]{36}$/.test(name)) return;
    const holder = join(lockPath, name);
    const [pidText, token] = readFileSync(holder, "utf8").trim().split("\n");
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) {
      if (Date.now() - statSync(holder).mtimeMs <= LOCK_STALE_MS) return;
    } else if (sameProcess(pid, token || null)) {
      return;
    }
    // If another reclaimer already published a new lock, its owner filename is
    // different: unlink fails, or rmdir fails because that directory is not empty.
    // A stale observation can therefore NEVER remove a fresh owner's lock.
    unlinkSync(holder);
    rmdirSync(lockPath);
  } catch {
    // Another contender raced us, or permissions prevent reclaiming. The caller
    // retries within a bounded deadline; do not recursively delete shared paths.
  }
}

function release(lockPath: string, owner: string): void {
  try { unlinkSync(join(lockPath, owner)); } catch { /* already gone */ }
  try { rmdirSync(lockPath); } catch { /* absent, or belongs to another owner */ }
}

function* acquireSteps(lockPath: string): Generator<void, string> {
  mkdirSync(dirname(lockPath), { recursive: true });
  const id = randomUUID();
  const owner = `holder-${id}`;
  const staged = `${lockPath}.claim.${process.pid}.${id}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  mkdirSync(staged);
  try {
    writeFileSync(join(staged, owner), `${process.pid}\n${procStartToken(process.pid) ?? ""}`);
    for (;;) {
      try {
        // Both directories are on the same filesystem. A non-empty destination
        // cannot be replaced, on Windows, macOS or Linux.
        renameSync(staged, lockPath);
        return owner;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        const occupied = code === "EEXIST" || code === "ENOTEMPTY";
        // Windows also reports an occupied destination as EPERM/EACCES. Its
        // owner may release it before we inspect the path, so existsSync here
        // would turn normal contention into a fatal TOCTOU race. Retry these
        // ambiguous errors only on Windows and within the same wait budget.
        const windowsOccupied = process.platform === "win32" && (code === "EPERM" || code === "EACCES");
        if (!occupied && !windowsOccupied) throw e;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for lock: ${lockPath}`, { cause: e });
        }
      }
      reclaimDeadOwner(lockPath);
      yield;
    }
  } finally {
    // This is a private staging directory, never the shared lock directory.
    rmSync(staged, { recursive: true, force: true });
  }
}

export function withCrossProcessLock<T>(lockPath: string, fn: () => T): T {
  const steps = acquireSteps(lockPath);
  let step = steps.next();
  while (!step.done) { sleep(50); step = steps.next(); }
  const owner = step.value;
  try {
    const result = fn();
    if (result && typeof (result as unknown as { then?: unknown }).then === "function") {
      return (async () => {
        try {
          return await (result as unknown as Promise<T>);
        } finally {
          release(lockPath, owner);
        }
      })() as T;
    }
    release(lockPath, owner);
    return result;
  } catch (e) {
    release(lockPath, owner);
    throw e;
  }
}

// Lock-free variants for exit/cleanup paths where blocking is not safe.
export function readRegistryUnsafe(registryPath: string): { players: Array<{ pid: number; token: string | null }>; watchdogs: Array<{ pid: number; token: string | null }> } {
  if (!existsSync(registryPath)) return { players: [], watchdogs: [] };
  try {
    const r = JSON.parse(readFileSync(registryPath, "utf8"));
    return { players: r.players ?? [], watchdogs: r.watchdogs ?? [] };
  } catch {
    return { players: [], watchdogs: [] };
  }
}

// Async effect serialization must not block the event loop while another
// command awaits network/IPC. State and registry locks remain short and sync.
export async function acquireAsyncCrossProcessLock(path: string, signal?: AbortSignal): Promise<() => void> {
  const steps = acquireSteps(path);
  try {
    for (;;) {
      signal?.throwIfAborted();
      const step = steps.next();
      if (step.done) {
        const owner = step.value;
        return () => release(path, owner);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally { steps.return(""); }
}
export async function withAsyncCrossProcessLock<T>(path: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await acquireAsyncCrossProcessLock(path, signal);
  try { signal?.throwIfAborted(); return await fn(); } finally { release(); }
}
