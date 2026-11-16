// Cross-platform process primitives shared by the player, watchdog and MCP
// server. Three jobs, all of which must behave the same on win32/macOS/Linux:
//
//   1. pidAlive(pid)        — cheap "is this PID running right now?" probe.
//   2. procStartToken(pid)  — a stable per-process fingerprint (start time) used
//                             to defeat PID *reuse*: a recycled PID gets a new
//                             token, so a stale token means "not the same process".
//   3. killPid / enumeratePlayers — stop a process tree, or find leftover
//                             mpv/ffplay players from a crashed session.
//
// Everything here uses execFileSync with an argv array (never a shell string),
// so MSYS/Git-Bash path mangling of flags like `/F` never happens.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lifecycleTestMode } from "./lifecycle-mode.js";

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

// --- liveness --------------------------------------------------------------
// signal 0 doesn't deliver a signal, it just probes. ESRCH = gone; EPERM =
// alive but owned by another user (still alive → true).
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// --- start-time token (PID-reuse guard) ------------------------------------
// Returns a short string that is stable for the life of a given process but
// (practically) unique per process launch, so if the OS recycles the PID the
// token changes. Best-effort: returns null when it can't be determined, and
// callers must degrade gracefully (fall back to bare pidAlive) in that case.
//
// Our own token is constant for this process's lifetime, so it is computed
// once: every lock acquisition stamps it into the owner file, and on Windows
// each lookup is a PowerShell launch (a single /play takes several locks).
let selfToken: string | null | undefined;
export function procStartToken(pid: number): string | null {
  if (lifecycleTestMode) return null;
  if (pid === process.pid) {
    if (selfToken === undefined) selfToken = readStartToken(pid);
    return selfToken;
  }
  return readStartToken(pid);
}

function readStartToken(pid: number): string | null {
  if (!pidAlive(pid)) return null;
  try {
    if (process.platform === "linux") {
      // /proc/<pid>/stat field 22 is starttime (clock ticks since boot).
      // comm (field 2) may contain spaces/parens, so slice after the last ')'.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const starttime = rest[19]; // field 22 == index 19 after state(=field3)
      return starttime ? `l:${starttime}` : null;
    }
    if (isMac) {
      // No /proc on macOS. lstart is an absolute wall-clock start time.
      // LC_ALL=C pins the format: lstart is rendered through LC_TIME, so a GUI-
      // launched process (system region, e.g. zh_CN) and a shell-launched one
      // (LANG=en_US) would render the SAME process's start time differently.
      // The anchor token is written by one process and compared by another, so
      // a locale mismatch reads as "different process" — the watchdog would then
      // declare a live session dead and kill the music mid-song.
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        env: { ...process.env, LC_ALL: "C" },
      }).trim();
      return out ? `d:${out}` : null;
    }
    if (isWin) {
      // CreationDate is a WMI datetime; unique enough per launch.
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CreationDate`,
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true }
      ).trim();
      return out ? `w:${out}` : null;
    }
  } catch {
    /* ps/powershell/proc unavailable — degrade to null */
  }
  return null;
}

// True if `pid` is alive AND (when a token was captured at spawn) still the same
// process. A null captured token means we never had reuse protection, so fall
// back to bare liveness. A null *current* token on a live pid also falls back
// (can't prove reuse → assume same process).
export function sameProcess(pid: number, token: string | null): boolean {
  if (!pidAlive(pid)) return false;
  if (!token) return true;
  const cur = procStartToken(pid);
  return cur === null ? true : cur === token;
}

// Verify a registered identity immediately before signalling it.
export function killSameProcess(pid: number, token: string | null): void {
  if (sameProcess(pid, token)) killPid(pid);
}

// --- killing ---------------------------------------------------------------
// Terminate a process (and its children on Windows). Best-effort: a PID that is
// already gone is a success, not an error.
//
// Best-effort graceful shutdown first: mpv/ffplay respond to SIGTERM quickly.
// Escalate to SIGKILL after a short grace period if they don't — otherwise a
// network-stuck player could survive the "stop" indefinitely and defeat the
// whole point of this call. Poll finely: players normally exit within a few ms.
const KILL_GRACE_MS = 250;
const KILL_POLL_MS = 5;

// Sends the graceful signal; false when there is nothing left to wait for.
function terminate(pid: number | null | undefined): pid is number {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (isWin) {
      // process.kill on win32 can't reliably take down the whole tree; taskkill
      // /F /T does. Spawned with an argv array + no shell, so no flag mangling.
      execFileSync("taskkill", ["/F", "/PID", String(pid), "/T"], {
        stdio: "ignore",
        timeout: 8000,
        windowsHide: true,
      });
      return false;
    }
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false; // already dead, or not ours — fine
  }
}

function forceKill(pid: number): void {
  if (pidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* raced with exit — fine */ }
  }
}

// Blocking variant for exit/startup/watchdog paths that cannot await.
export function killPid(pid: number | null | undefined): void {
  if (!terminate(pid)) return;
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && pidAlive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, KILL_POLL_MS);
  }
  forceKill(pid);
}

// Waits on the event loop instead. When the target is this process's own child
// (players and watchdogs spawned by the MCP server), it stays a zombie — and
// pidAlive stays true — until libuv reaps it, which a blocking wait prevents:
// every stop would sit out the full grace period and then SIGKILL a player
// that had already exited.
export async function killPidAsync(pid: number | null | undefined): Promise<void> {
  if (!terminate(pid)) return;
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
  }
  forceKill(pid);
}

export async function killSameProcessAsync(pid: number, token: string | null): Promise<void> {
  if (sameProcess(pid, token)) await killPidAsync(pid);
}

// --- orphan discovery ------------------------------------------------------
// Only exact player process names carrying our session marker are eligible.
// A shared stream hostname is NOT evidence that a process belongs to us.
export function findOrphanPlayers(marker: string): number[] {
  if (!/^pirate-radio-[a-f0-9]{24}$/.test(marker)) return [];
  const matches = (cmd: string): boolean => cmd.split(/[\s\"]+/).some((arg) =>
    arg === `--title=${marker}` || arg === marker);
  try {
    if (isWin) {
      // One PowerShell call: emit "PID<TAB>CommandLine" for mpv/ffplay.
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='mpv.exe' OR Name='ffplay.exe'\" " +
            "-ErrorAction SilentlyContinue | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
        ],
        { encoding: "utf8", timeout: 8000, windowsHide: true }
      );
      return parsePidLines(out, "\t", matches);
    }
    // Use the OS executable name, NOT arbitrary occurrences in argv. macOS
    // ucomm is the basename; Linux comm provides the equivalent column. List
    // names first: argv is the expensive column (~2x the cost of the whole
    // listing on macOS), and it is only needed for actual players — usually none.
    const comm = isMac ? "ucomm=" : "comm=";
    const players: number[] = [];
    for (const line of ps(["-eo", `pid=,${comm}`]).split("\n")) {
      const row = line.trim().match(/^(\d+)\s+(?:mpv|ffplay)$/);
      if (row) players.push(Number(row[1]));
    }
    if (players.length === 0) return [];
    return parseUnixPs(ps(["-o", `pid=,${comm},args=`, "-p", players.join(",")]), matches);
  } catch {
    return [];
  }
}

// ps exits non-zero when a -p list matched nothing (every candidate exited in
// the meantime); its stdout is still the right answer.
function ps(args: string[]): string {
  try {
    return execFileSync("ps", args, { encoding: "utf8", timeout: 8000 });
  } catch (e) {
    const stdout = (e as { stdout?: unknown }).stdout;
    if (typeof stdout === "string" && (e as { status?: unknown }).status === 1) return stdout;
    throw e;
  }
}

function parsePidLines(
  out: string,
  sep: string,
  matches: (cmd: string) => boolean
): number[] {
  const pids: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf(sep);
    if (i === -1) continue;
    const pid = Number(line.slice(0, i).trim());
    const cmd = line.slice(i + 1);
    if (Number.isInteger(pid) && pid > 0 && matches(cmd)) pids.push(pid);
  }
  return pids;
}

export function parseUnixPs(out: string, matches: (cmd: string) => boolean): number[] {
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const row = line.trim().match(/^(\d+)\s+(mpv|ffplay)\s+([\s\S]+)$/);
    if (!row) continue;
    const pid = Number(row[1]);
    if (Number.isInteger(pid) && pid > 0 && matches(row[3])) pids.push(pid);
  }
  return pids;
}

// --- host-process discovery (pi fallback anchor) ---------------------------
// When music is started by a raw CLI invocation with no MCP server running (the
// pi skill path), anchor.json never exists and player.spawnWatchdog() would
// skip the watchdog entirely — music would then survive a terminal close
// forever. Fall back to the invoking host instead: walk this process's ancestor
// chain and find the pi agent process. When pi dies (agent exited, terminal
// closed, hard kill) the watchdog sees the anchor die and stops the music.
export interface HostProcess { pid: number; token: string | null; }

interface ProcInfo { pid: number; ppid: number; name: string; args: string; }

function isPiProcess(name: string, args: string): boolean {
  // `name` is argv[0]'s basename (see ancestors), so the npm-bin case
  // — a compiled `pi` binary, however deep its install path — is an exact match
  // on either platform. A node-script install instead shows the interpreter as
  // argv[0] with the script as argv[1], so check that too.
  //
  // Deliberately narrow: an earlier version accepted a bare "pi" token ANYWHERE
  // in the command line, which any unrelated ancestor could satisfy (a shell
  // running a script that merely mentions pi — this fired on a plain `zsh -c`
  // wrapper in testing). A false positive is not benign: findPiProcess() hands
  // that pid to the watchdog as the session anchor, binding the music's
  // lifetime to the wrong process.
  if (name === "pi" || name === "pi.exe") return true;
  if (args.includes("pi-coding-agent")) return true;
  const argv1 = args.split(" ")[1] ?? "";
  const base = argv1.slice(argv1.lastIndexOf("/") + 1);
  return base === "pi" || base === "pi.js";
}

// This process's ancestors, nearest first (at most 32, stopping at init or a
// broken link). On unix the chain comes from a cheap pid/ppid listing and argv
// is read for just those few processes: argv is the expensive column, and
// listing it for every process roughly doubled the cost of each CLI call.
//
// On unix we deliberately do NOT ask ps for `comm=`. macOS renders comm as the
// truncated-to-16-chars FULL PATH ("/usr/libexec/dpr"), not a basename, and it
// can itself contain spaces ("Core Audio Drive") — so a naive whitespace split
// misaligns the comm column AND shifts a stray token into args. Instead take
// only pid/ppid (always numeric, always first) and treat the entire remainder
// as args, then derive `name` from argv[0]'s basename ourselves. This is
// intentionally separate from the executable-name check used for players.
function ancestors(): ProcInfo[] {
  if (isWin) return walk(enumerateWindowsProcesses());
  const parents = new Map<number, ProcInfo>();
  for (const line of ps(["-eo", "pid=,ppid="]).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) parents.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: "", args: "" });
  }
  const chain = walk(parents);
  if (chain.length === 0) return [];
  const procs = new Map<number, ProcInfo>();
  for (const line of ps(["-o", "pid=,ppid=,args=", "-p", chain.map((p) => p.pid).join(",")]).split("\n")) {
    // Split off exactly two leading numeric columns; everything after is argv,
    // preserved verbatim (no whitespace collapsing).
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\s\S]*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const args = m[3];
    // argv[0]'s basename. Kernel threads show as "[kthread]" and have no path.
    const argv0 = args.split(" ")[0] ?? "";
    procs.set(pid, { pid, ppid: Number(m[2]) || 0, name: argv0.slice(argv0.lastIndexOf("/") + 1), args });
  }
  // Re-walk with the second listing's own ppids: an ancestor that exited (or a
  // PID reused under another parent) between the two calls ends the chain
  // there, exactly as a gap in one snapshot would.
  return walk(procs);
}

function walk(procs: Map<number, ProcInfo>): ProcInfo[] {
  const chain: ProcInfo[] = [];
  const seen = new Set<number>();
  let pid = process.ppid;
  for (let depth = 0; depth < 32 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const p = procs.get(pid);
    if (!p) break; // chain broken (ps raced a process exit) — give up
    chain.push(p);
    pid = p.ppid;
  }
  return chain;
}

// One PowerShell call, JSON out (PowerShell startup dominates, so a narrower
// query would not help). CommandLine is null for kernel processes.
function enumerateWindowsProcesses(): Map<number, ProcInfo> {
  const map = new Map<number, ProcInfo>();
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | " +
        "Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", timeout: 8000, windowsHide: true }
  );
  const rows: Array<{ ProcessId?: number; ParentProcessId?: number; Name?: string; CommandLine?: string | null }> =
    JSON.parse(out.trim() || "[]");
  for (const r of Array.isArray(rows) ? rows : [rows]) {
    if (!r.ProcessId) continue;
    map.set(r.ProcessId, {
      pid: r.ProcessId,
      ppid: r.ParentProcessId ?? 0,
      name: r.Name ?? "",
      args: r.CommandLine ?? "",
    });
  }
  return map;
}

// Find the pi agent process that (indirectly) ran this CLI, or null when there
// is none in the ancestor chain (e.g. the CLI was run from a plain terminal —
// no session to bind to, music keeps playing until explicitly stopped).
export function findPiProcess(): HostProcess | null {
  try {
    for (const p of ancestors()) {
      if (isPiProcess(p.name, p.args)) return { pid: p.pid, token: procStartToken(p.pid) };
    }
  } catch {
    /* enumeration failed — no fallback anchor */
  }
  return null;
}
