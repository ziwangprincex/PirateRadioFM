#!/usr/bin/env node
import { clearAnchor, readAnchor, withSessionLock, bindSession, playerMarker, type Anchor } from "./session.js";
import { pidAlive, sameProcess, killSameProcess, killPid, findOrphanPlayers, procStartToken } from "./proc.js";
import { lifecycleTestMode } from "./lifecycle-mode.js";
import { drainAll, livePlayers } from "./registry.js";
import { startWatchdogLoop } from "./watchdog-loop.js";

const anchorPid = Number(process.argv[2]);
const anchorToken = process.argv[3] || null;
const playerPid = Number(process.argv[4]);
const kind = process.argv[5] === "pid" ? "pid" : "file";
const id = process.argv[6] || "legacy";
const playerToken = process.argv[7] || procStartToken(playerPid);
if (!Number.isInteger(anchorPid) || anchorPid <= 0 || !Number.isInteger(playerPid) || playerPid <= 0) process.exit(1);
bindSession(id);
const anchor: Anchor = { pid: anchorPid, token: anchorToken, sessionId: id === "legacy" ? undefined : id };
function stillOurAnchor(): boolean {
  const cur = readAnchor();
  return !!cur && cur.pid === anchor.pid && cur.token === anchor.token && cur.sessionId === anchor.sessionId;
}
function stopOwned(): void {
  const { players, watchdogs } = drainAll(id);
  for (const p of players) killSameProcess(p.pid, p.token);
  for (const w of watchdogs) if (w.pid !== process.pid) killSameProcess(w.pid, w.token);
  for (const pid of findOrphanPlayers(playerMarker(id))) killPid(pid);
}
const POLL_MS = lifecycleTestMode ? 50 : 3000;
let tick = 0;
startWatchdogLoop(POLL_MS, () => {
  tick++;
  if (kind === "file" && !stillOurAnchor()) return true;
  if (!pidAlive(playerPid) && livePlayers(id).length === 0) return true;
  const dead = !pidAlive(anchorPid) || (tick % 10 === 0 && !sameProcess(anchorPid, anchorToken));
  if (!dead) return false;
  if (kind === "pid") {
    killSameProcess(playerPid, playerToken);
    return true;
  }
  return withSessionLock(() => {
    if (!stillOurAnchor()) return true;
    stopOwned();
    clearAnchor(anchor);
    return true;
  });
}, () => process.exit(0));
