import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readAnchor, anchorAlive, sessionId, playerMarker, hostProcess, sessionEnvironment } from "./session.js";
import { killPid, killSameProcess, sameProcess, findOrphanPlayers, procStartToken } from "./proc.js";
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


export function stop(id = sessionId()): void {
  const { players, watchdogs } = drainAll(id);
  for (const p of players) {
    killSameProcess(p.pid, p.token);
    if (p.ipc && process.platform !== "win32") { try { rmSync(p.ipc, { force: true }); } catch {} }
  }
  for (const w of watchdogs) if (w.pid !== process.pid) killSameProcess(w.pid, w.token);
  for (const pid of findOrphanPlayers(playerMarker(id))) killPid(pid);
}

const here = dirname(fileURLToPath(import.meta.url));
function ipcPath(): string {
  const id = randomUUID();
  if (process.platform === "win32") return `\\\\.\\pipe\\pirate-radio-${id}`;
  const dir = join(tmpdir(), `pr-${process.getuid?.() ?? "user"}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${id}.sock`);
}
export async function play(url: string, volume: number): Promise<void> {
  checkCancelled();
  const player = detect();
  if (!player) throw new Error(installHint());
  stop();
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
      const deadline = Date.now() + 4000;
      for (;;) {
        checkCancelled();
        if (error || child.exitCode !== null) throw error ?? new Error("mpv exited during startup");
        try { await mpvCommand(ipc, ["get_property", "pid"], 500); break; }
        catch (e) { if (Date.now() >= deadline) throw e; await wait(50); }
      }
    }
    spawnWatchdog(pid);
    child.unref();
  } catch (e) {
    if (pid) { killPid(pid); removePlayer(pid); }
    if (ipc && process.platform !== "win32") { try { rmSync(ipc, { force: true }); } catch {} }
    throw e;
  }
}

export async function setPaused(paused: boolean): Promise<boolean> {
  const players = livePlayers();
  if (!players.length) return false;
  if (players.some((p) => !p.ipc)) throw new Error("Pause/resume without restarting requires mpv. Use radio_stop or install mpv.");
  for (const p of players) {
    if (!sameProcess(p.pid, p.token)) throw new Error("Player exited");
    await mpvCommand(p.ipc!, ["set_property", "pause", paused]);
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
