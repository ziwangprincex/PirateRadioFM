// Plays a stream URL via a local player (mpv preferred, ffplay fallback).
// The child is DETACHED and tracked in the lock-guarded registry (registry.ts),
// so a later CLI invocation (e.g. `pause`) — a different process entirely — can
// find and kill it. stop() also runs an orphan sweep: any mpv/ffplay pointed at
// one of our stream hosts gets killed even if it somehow escaped the registry
// (crashed session, killed watchdog, lost-update race). That sweep is what
// guarantees "no music survives a stop".
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { now, readAnchor, anchorAlive } from "./state.js";
import { sweepHosts } from "./dynhosts.js";
import { killPid, findOrphanPlayers, findPiProcess } from "./proc.js";
import {
  addPlayer,
  addWatchdog,
  drainPlayers,
  drainWatchdogs,
  removePlayer,
  removeWatchdog,
} from "./registry.js";

type Player = "mpv" | "ffplay";

// Cache the detection result — this used to run on every play(), spawning
// `where` / `command -v` synchronously each time. The detected binary doesn't
// change during a session; if the user installs mpv mid-session they can call
// resetDetectCache() (currently unused).
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

// Kill every player/watchdog this or a prior CLI spawned, THEN sweep for any
// orphaned mpv/ffplay still pointed at our hosts. Best-effort throughout: a PID
// that's already gone is fine.
export function stop(): void {
  for (const p of drainPlayers()) killPid(p.pid);
  for (const w of drainWatchdogs()) killPid(w.pid);
  sweepOrphans();
}

// The safety net. Find any mpv/ffplay whose command line references one of our
// stream hosts and kill it — this is what catches players that the registry
// lost track of (the original "music keeps playing after terminal close" bug).
// sweepHosts() owns the match set (bundled station hosts + podcast/HÖR CDNs) and
// is shared with the watchdog's session-death sweep.
function sweepOrphans(): void {
  for (const pid of findOrphanPlayers(sweepHosts())) killPid(pid);
}

const here = dirname(fileURLToPath(import.meta.url));

// volume is 0-100. Both players take 0..100: mpv as --volume, ffplay as
// -volume. ffplay used to be 0..256 (SDL_MIX_MAXVOLUME) but has been 0..100
// since FFmpeg 4; scaling to 256 made it clamp everything >=40 to full blast,
// so /volume was a silent no-op above 39 on ffplay-only machines.
export function play(url: string, volume: number): void {
  const player = detect();
  if (!player) throw new Error(installHint());
  stop(); // kill previous stream + watchdog + any orphans first
  const args =
    player === "mpv"
      ? ["--no-video", "--really-quiet", `--volume=${volume}`, url]
      : ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(volume), url];
  // detached + unref lets the child outlive this short-lived CLI process.
  const child = spawn(player, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.unref();
  // Handle three async terminations without leaving a dead pid in the registry:
  //   - 'error' fires when the executable can't be launched (missing, permission)
  //     even after spawn already returned a pid.
  //   - 'exit' fires on normal termination too — after stop() has already killed
  //     the pid, or when the stream ends. In both cases removePlayer is a no-op
  //     because drainPlayers() cleared the entry first, but it's the right thing
  //     to call for the "unexpected crash" case (bad URL, codec issue).
  const pid = child.pid;
  if (pid) {
    let host: string | undefined;
    try { host = new URL(url).host; } catch { /* leave undefined */ }
    addPlayer(pid, host);
    child.on("error", () => removePlayer(pid));
    child.on("exit", () => removePlayer(pid));
    spawnWatchdog(pid);
  }
}

// Launch the detached watchdog that stops the player when the session dies.
//
// Two anchor kinds, same watchdog script, different guarding semantics:
//   - "file": an MCP server is running and wrote anchor.json (Claude Code,
//     Codex, …). The watchdog polls that file's pid and on death drains the
//     whole registry, sweeps orphans, and clears the anchor.
//   - "pid": no MCP server (the pi skill path — pi runs no MCP server, so
//     anchor.json never exists here). The watchdog polls the pi process that
//     ran this CLI instead: when pi exits (agent quit, terminal closed) the
//     music stops. It kills only the one player it was spawned for.
// No anchor at all → skip; there's no session to bind to.
function spawnWatchdog(playerPid: number): void {
  const anchor = readAnchor();
  // Skip a dead anchor: if the anchor belongs to a dead session (MCP crashed
  // but anchor.json wasn't cleaned up), the watchdog would poll a dead pid,
  // immediately conclude "session dead", and kill the music we just started —
  // self-suicide within seconds.
  if (anchor && anchorAlive(anchor)) {
    spawnWatchdogProc("file", anchor.pid, anchor.token, playerPid);
    return;
  }
  const host = findPiProcess();
  if (host) spawnWatchdogProc("pid", host.pid, host.token, playerPid);
}

function spawnWatchdogProc(kind: "file" | "pid", anchorPid: number, anchorToken: string | null, playerPid: number): void {
  const wd = spawn(
    process.execPath,
    [
      join(here, "watchdog.js"),
      String(anchorPid),
      anchorToken ?? "",
      String(playerPid),
      kind,
    ],
    { stdio: "ignore", detached: true, windowsHide: true }
  );
  wd.unref();
  const pid = wd.pid;
  if (pid) {
    addWatchdog(pid);
    // If the watchdog script is missing / node itself fails / it exits early,
    // don't leave a dead pid in the registry — otherwise stop() thinks a
    // watchdog is guarding us when in fact nothing is, and orphan sweep is our
    // only remaining safety net.
    wd.on("error", () => removeWatchdog(pid));
    wd.on("exit", () => removeWatchdog(pid));
  }
}
