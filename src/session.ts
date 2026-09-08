import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { findPiProcess, procStartToken, sameProcess } from "./proc.js";
import { withCrossProcessLock } from "./lock.js";

export interface Anchor { pid: number; token: string | null; sessionId?: string; }
const root = join(homedir(), ".pirate-radio");
let directory: string | undefined;
let scopeKey = "";
let boundSession: string | undefined;
let pi: ReturnType<typeof findPiProcess> | undefined;
export function hostProcess(): ReturnType<typeof findPiProcess> {
  if (pi === undefined) pi = findPiProcess();
  return pi;
}
export function dataDir(): string {
  if (directory) return directory;
  const explicit = process.env.PIRATE_RADIO_SESSION?.trim();
  const host = explicit ? null : hostProcess();
  const key = explicit || (host ? `pi:${host.pid}:${host.token ?? ""}` : "");
  scopeKey = key;
  directory = key ? join(root, "sessions", createHash("sha256").update(key).digest("hex").slice(0, 24)) : root;
  return directory;
}
export function readAnchor(): Anchor | null {
  try {
    const a = JSON.parse(readFileSync(join(dataDir(), "anchor.json"), "utf8"));
    if (Number.isInteger(a?.pid) && a.pid > 0 && (a.token == null || typeof a.token === "string")) {
      return { pid: a.pid, token: a.token ?? null, sessionId: typeof a.sessionId === "string" ? a.sessionId : undefined };
    }
  } catch { /* absent or corrupt */ }
  return null;
}
export function anchorAlive(anchor: Anchor | null): boolean {
  return !!anchor && sameProcess(anchor.pid, anchor.token);
}
export function sessionId(): string {
  return boundSession ??= readAnchor()?.sessionId ?? "legacy";
}
export function writeAnchor(pid: number, id = randomUUID()): Anchor {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const anchor: Anchor = { pid, token: procStartToken(pid), sessionId: id };
  const path = join(dataDir(), "anchor.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(anchor), { mode: 0o600 });
  renameSync(tmp, path);
  boundSession = id;
  return anchor;
}
export function clearAnchor(expected?: Anchor): void {
  const cur = readAnchor();
  if (expected && (!cur || cur.pid !== expected.pid || cur.token !== expected.token || cur.sessionId !== expected.sessionId)) return;
  try { unlinkSync(join(dataDir(), "anchor.json")); } catch { /* already gone */ }
}
export function withSessionLock<T>(fn: () => T): T {
  return withCrossProcessLock(join(dataDir(), "session.lock"), fn);
}
// Checking liveness, retiring old resources, and publishing the new anchor are
// one atomic takeover. A second simultaneous startup cannot pass the check.
export function claimAnchor(retire: (old: Anchor | null) => void): Anchor {
  return withSessionLock(() => {
    const old = readAnchor();
    if (anchorAlive(old)) throw new Error(`another server is already running (pid ${old!.pid})`);
    retire(old);
    return writeAnchor(process.pid);
  });
}
// Stable marker scoped to the state directory AND owning session, not a host URL.
export function playerMarker(id = sessionId()): string {
  return `pirate-radio-${createHash("sha256").update(`${dataDir()}:${id}`).digest("hex").slice(0, 24)}`;
}

export function sessionEnvironment(): NodeJS.ProcessEnv {
  dataDir();
  return { ...process.env, PIRATE_RADIO_SESSION: scopeKey };
}
export function bindSession(id: string): void { boundSession = id; }
