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
  // `name` is argv[0]'s basename (see enumerateProcesses), so the npm-bin case
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

// One-shot snapshot of every process on the host: pid → {ppid, name, args}.
//
// On unix we deliberately do NOT ask ps for `comm=`. macOS renders comm as the
// truncated-to-16-chars FULL PATH ("/usr/libexec/dpr"), not a basename, and it
// can itself contain spaces ("Core Audio Drive") — so a naive whitespace split
// misaligns the comm column AND shifts a stray token into args. Instead take
// only pid/ppid (always numeric, always first) and treat the entire remainder
// as args, then derive `name` from argv[0]'s basename ourselves. That is the
// same technique parseUnixPs() already uses.
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
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
    encoding: "utf8",
    timeout: 8000,
  });
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // Split off exactly two leading numeric columns; everything after is argv,
    // preserved verbatim (no whitespace collapsing).
    const m = t.match(/^(\d+)\s+(\d+)\s+([\s\S]*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const args = m[3];
    // argv[0]'s basename. Kernel threads show as "[kthread]" and have no path.
    const argv0 = args.split(" ")[0] ?? "";
    map.set(pid, {
      pid,
      ppid: Number(m[2]) || 0,
      name: argv0.slice(argv0.lastIndexOf("/") + 1),
      args,
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
