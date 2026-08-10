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
export function procStartToken(pid: number): string | null {
  if (lifecycleTestMode) return null;
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
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
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
        { encoding: "utf8", timeout: 8000, windowsHide: true }
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

// --- killing ---------------------------------------------------------------
// Terminate a process (and its children on Windows). Best-effort: a PID that is
// already gone is a success, not an error.
export function killPid(pid: number | null | undefined): void {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  try {
    if (isWin) {
      // process.kill on win32 can't reliably take down the whole tree; taskkill
      // /F /T does. Spawned with an argv array + no shell, so no flag mangling.
      execFileSync("taskkill", ["/F", "/PID", String(pid), "/T"], {
        stdio: "ignore",
        timeout: 8000,
        windowsHide: true,
      });
    } else {
      // Best-effort graceful shutdown first: mpv/ffplay respond to SIGTERM
      // quickly. Fall through to SIGKILL after a short wait if they don't —
      // otherwise a network-stuck player could survive the "stop" indefinitely
      // and defeat the whole point of this call.
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 250;
      while (Date.now() < deadline && pidAlive(pid)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      if (pidAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* raced with exit — fine */ }
      }
    }
  } catch {
    /* already dead, or not ours — fine */
  }
}

// --- orphan discovery ------------------------------------------------------
// Enumerate running mpv/ffplay processes whose command line references one of
// `hosts` (our stream hosts). This is the safety net that catches players which
// escaped the registry (crashed session, lost-update race, killed watchdog).
// Returns their PIDs. Never throws — returns [] if enumeration fails.
export function findOrphanPlayers(hosts: string[]): number[] {
  if (hosts.length === 0) return [];
  const wanted = hosts.map((h) => h.toLowerCase());
  const matches = (cmd: string): boolean => {
    const c = cmd.toLowerCase();
    return wanted.some((h) => c.includes(h));
  };
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
    // Unix: pid + full argv, tab-free so split on first run of spaces.
    const out = execFileSync("ps", ["-eo", "pid=,args="], {
      encoding: "utf8",
      timeout: 8000,
    });
    return parseUnixPs(out, matches);
  } catch {
    return [];
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

function parseUnixPs(out: string, matches: (cmd: string) => boolean): number[] {
  const pids: number[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(" ");
    if (sp === -1) continue;
    const pid = Number(trimmed.slice(0, sp));
    const cmd = trimmed.slice(sp + 1);
    // Only mpv/ffplay, and only if pointed at one of our hosts.
    if (!/(^|\/)(mpv|ffplay)\b/.test(cmd)) continue;
    if (Number.isInteger(pid) && pid > 0 && matches(cmd)) pids.push(pid);
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
  // npm bin "pi" → the running process is the compiled cli; on macOS ps shows
  // comm="pi", args="pi". A node-script install shows the interpreter plus a
  // commandline containing the pi-coding-agent package path. Match all three.
  return (
    name === "pi" ||
    name === "pi.exe" ||
    args.includes("pi-coding-agent") ||
    /(^|\s|\/)pi(\s|$)/.test(args)
  );
}

// One-shot snapshot of every process on the host: pid → {ppid, name, args}.
// Two lines for args containing spaces, so split into exactly the leading
// pid/ppid/comm columns and rejoin the rest.
function enumerateProcesses(): Map<number, ProcInfo> {
  const map = new Map<number, ProcInfo>();
  if (isWin) {
    // One PowerShell call, JSON out. CommandLine is null for kernel processes.
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
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,comm=,args="], {
    encoding: "utf8",
    timeout: 8000,
  });
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/\s+/);
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    map.set(pid, {
      pid,
      ppid: Number(parts[1]) || 0,
      name: parts[2] ?? "",
      args: parts.slice(3).join(" "),
    });
  }
  return map;
}

// Find the pi agent process that (indirectly) ran this CLI, or null when there
// is none in the ancestor chain (e.g. the CLI was run from a plain terminal —
// no session to bind to, music keeps playing until explicitly stopped).
export function findPiProcess(): HostProcess | null {
  try {
    const procs = enumerateProcesses();
    const seen = new Set<number>();
    let pid = process.ppid;
    for (let depth = 0; depth < 32 && pid > 1 && !seen.has(pid); depth++) {
      seen.add(pid);
      const p = procs.get(pid);
      if (!p) break; // chain broken (ps raced a process exit) — give up
      if (isPiProcess(p.name, p.args)) return { pid, token: procStartToken(pid) };
      pid = p.ppid;
    }
  } catch {
    /* enumeration failed — no fallback anchor */
  }
  return null;
}
