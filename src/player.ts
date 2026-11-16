import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readAnchor, anchorAlive, sessionId, playerMarker, hostProcess, sessionEnvironment } from "./session.js";
import { killPid, killPidAsync, killSameProcess, killSameProcessAsync, sameProcess, findOrphanPlayers, procStartToken } from "./proc.js";
import { addPlayer, addWatchdog, drainAll, removePlayer, removeWatchdog, livePlayers } from "./registry.js";
import { mpvCommand } from "./ipc.js";
import { checkCancelled, wait } from "./http.js";

type Player = "mpv" | "ffplay";

// Cache the detection result — this used to run on every play(), spawning
// `where` / `command -v` synchronously each time. The detected binary doesn't
// change during a session; installing mpv takes effect on the next process.
let detected: Player | null | undefined; // undefined = not-yet-detected
function detect(): Player | null {
  if (detected !== undefined) return detected;
  for (const p of ["mpv", "ffplay"] as Player[]) {
    try {
      // argv array, no MSYS flag mangling. `command` is a shell builtin, so on
      // unix we invoke it through sh; p comes from a fixed list, so no injection.
      if (process.platform === "win32") {
        execFileSync("where", [p], { stdio: "ignore", windowsHide: true });
      } else {
        execFileSync("sh", ["-c", `command -v ${p}`], { stdio: "ignore" });
      }
      detected = p;
      return p;
    } catch {
      /* not found, try next */
    }
  }
  detected = null;
  return null;
}

export function playerAvailable(): Player | null {
  return detect();
}

export function installHint(): string {
  return "No audio player found. Install mpv (recommended) or ffmpeg:\n" +
    "  macOS:   brew install mpv\n" +
    "  Windows: winget install mpv   (or scoop install mpv)\n" +
    "  Linux:   sudo apt install mpv  (or your package manager)";
}


// Kills wait on the event loop, and in parallel: in the MCP server the player
// and watchdog are this process's own children, and they only stop reading as
// alive once libuv reaps them (see killPidAsync).
export async function stop(id = sessionId()): Promise<void> {
  const { players, watchdogs } = drainAll(id);
  await Promise.all([
    ...players.map(async (p) => { await killSameProcessAsync(p.pid, p.token); removeIpc(p.ipc); }),
    ...watchdogs.filter((w) => w.pid !== process.pid).map((w) => killSameProcessAsync(w.pid, w.token)),
  ]);
  await Promise.all(findOrphanPlayers(playerMarker(id)).map((pid) => killPidAsync(pid)));
}

// Blocking variant for the server's startup sweep, which runs inside a sync
// session lock. A previous session's players are never this process's children.
export function stopSync(id: string): void {
  const { players, watchdogs } = drainAll(id);
  for (const p of players) { killSameProcess(p.pid, p.token); removeIpc(p.ipc); }
  for (const w of watchdogs) if (w.pid !== process.pid) killSameProcess(w.pid, w.token);
  for (const pid of findOrphanPlayers(playerMarker(id))) killPid(pid);
}

const here = dirname(fileURLToPath(import.meta.url));
// A fresh private directory per player (mkdtemp creates it 0700, atomically).
// A fixed shared name like /tmp/pr-<uid> could be pre-created by another user
// on a multi-user /tmp, who could then swap the socket. It also keeps the path
// well under the ~104-byte Unix socket limit; mpv can't bind a longer one and
// plays on with no control channel, which the startup handshake rejects.
function ipcPath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\pirate-radio-${randomUUID()}`;
  return join(mkdtempSync(join(tmpdir(), "pr-")), "mpv.sock");
}
function removeIpc(ipc: string | undefined): void {
  if (!ipc || process.platform === "win32") return;
  try { rmSync(ipc, { force: true }); } catch {}
  // Never recursive: older entries share one directory between players.
  if (basename(dirname(ipc)).startsWith("pr-")) { try { rmdirSync(dirname(ipc)); } catch {} }
}
export async function play(url: string, volume: number): Promise<void> {
  checkCancelled();
  const player = detect();
  if (!player) throw new Error(installHint());
  await stop();
  const marker = playerMarker();
  const ipc = player === "mpv" ? ipcPath() : undefined;
  const args = player === "mpv"
    ? ["--no-config", "--no-video", "--really-quiet", `--title=${marker}`, `--input-ipc-server=${ipc}`, `--volume=${volume}`, "--", url]
    : ["-nodisp", "-autoexit", "-loglevel", "quiet", "-window_title", marker, "-volume", String(volume), "-i", url];
  const child = spawn(player, args, { stdio: "ignore", detached: true, windowsHide: true });
  const pid = child.pid;
  let error: Error | undefined;
  child.on("error", (e) => { error = e; });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    if (!pid) throw new Error("Audio player did not start");
    let host: string | undefined;
    try { host = new URL(url).host; } catch {}
    addPlayer(pid, host, { ipc, player });
    child.on("exit", () => { try { removePlayer(pid); } catch {} });
    if (ipc) {
      // mpv opens its socket within tens of ms; a coarse retry interval would
      // dominate the time to start playing.
      const deadline = Date.now() + 4000;
      for (;;) {
        checkCancelled();
        if (error || child.exitCode !== null) throw error ?? new Error("mpv exited during startup");
        try { await mpvCommand(ipc, ["get_property", "pid"], 500); break; }
        catch (e) { if (Date.now() >= deadline) throw e; await wait(10); }
      }
    }
    spawnWatchdog(pid);
    child.unref();
  } catch (e) {
    if (pid) { await killPidAsync(pid); removePlayer(pid); }
    removeIpc(ipc);
    throw e;
  }
}

export async function setPaused(paused: boolean): Promise<boolean> {
  const players = livePlayers();
  if (!players.length) return false;
  // ffplay has no control channel, so it can't be paused — but for the same
  // reason a live ffplay is never paused, and resuming it is a no-op.
  if (paused && players.some((p) => !p.ipc)) throw new Error("Pausing without restarting requires mpv. Use radio_stop or install mpv.");
  for (const p of players) {
    if (!sameProcess(p.pid, p.token)) throw new Error("Player exited");
    if (p.ipc) await mpvCommand(p.ipc, ["set_property", "pause", paused]);
  }
  return true;
}
// false = a live player has no IPC channel (ffplay): the caller keeps the level
// for the next play instead. mpv IPC failures still throw.
export async function setVolume(volume: number): Promise<boolean> {
  const players = livePlayers();
  if (players.some((p) => !p.ipc)) return false;
  for (const p of players) {
    if (!sameProcess(p.pid, p.token)) throw new Error("Player exited");
    await mpvCommand(p.ipc!, ["set_property", "volume", volume]);
  }
  return true;
}
function spawnWatchdog(playerPid: number): void {
  const anchor = readAnchor();
  if (anchor && anchorAlive(anchor)) { spawnWatchdogProc("file", anchor.pid, anchor.token, playerPid); return; }
  const host = hostProcess();
  if (host) spawnWatchdogProc("pid", host.pid, host.token, playerPid);
}
function spawnWatchdogProc(kind: "file" | "pid", anchorPid: number, token: string | null, playerPid: number): void {
  const wd = spawn(process.execPath, [join(here, "watchdog.js"), String(anchorPid), token ?? "", String(playerPid), kind, sessionId(), procStartToken(playerPid) ?? ""],
    { stdio: "ignore", detached: true, windowsHide: true, env: sessionEnvironment() });
  wd.on("error", () => { if (wd.pid) { try { removeWatchdog(wd.pid); } catch {} } });
  if (wd.pid) {
    addWatchdog(wd.pid);
    wd.on("exit", () => { try { removeWatchdog(wd.pid!); } catch {} });
  }
  wd.unref();
}
