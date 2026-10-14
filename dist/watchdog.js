#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/session.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2, renameSync as renameSync2, unlinkSync as unlinkSync2 } from "node:fs";

// src/proc.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// src/lifecycle-mode.ts
var lifecycleTestMode = false;

// src/proc.ts
var isWin = process.platform === "win32";
var isMac = process.platform === "darwin";
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
var selfToken;
function procStartToken(pid) {
  if (lifecycleTestMode) return null;
  if (pid === process.pid) {
    if (selfToken === void 0) selfToken = readStartToken(pid);
    return selfToken;
  }
  return readStartToken(pid);
}
function readStartToken(pid) {
  if (!pidAlive(pid)) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const starttime = rest[19];
      return starttime ? `l:${starttime}` : null;
    }
    if (isMac) {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 4e3,
        windowsHide: true,
        env: { ...process.env, LC_ALL: "C" }
      }).trim();
      return out ? `d:${out}` : null;
    }
    if (isWin) {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CreationDate`
        ],
        { encoding: "utf8", timeout: 15e3, windowsHide: true }
      ).trim();
      return out ? `w:${out}` : null;
    }
  } catch {
  }
  return null;
}
function sameProcess(pid, token) {
  if (!pidAlive(pid)) return false;
  if (!token) return true;
  const cur = procStartToken(pid);
  return cur === null ? true : cur === token;
}
function killSameProcess(pid, token) {
  if (sameProcess(pid, token)) killPid(pid);
}
function killPid(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  try {
    if (isWin) {
      execFileSync("taskkill", ["/F", "/PID", String(pid), "/T"], {
        stdio: "ignore",
        timeout: 8e3,
        windowsHide: true
      });
    } else {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 250;
      while (Date.now() < deadline && pidAlive(pid)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      if (pidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
        }
      }
    }
  } catch {
  }
}
function findOrphanPlayers(marker) {
  if (!/^pirate-radio-[a-f0-9]{24}$/.test(marker)) return [];
  const matches = (cmd) => cmd.split(/[\s\"]+/).some((arg) => arg === `--title=${marker}` || arg === marker);
  try {
    if (isWin) {
      const out2 = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='mpv.exe' OR Name='ffplay.exe'" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`
        ],
        { encoding: "utf8", timeout: 8e3, windowsHide: true }
      );
      return parsePidLines(out2, "	", matches);
    }
    const out = execFileSync("ps", ["-eo", isMac ? "pid=,ucomm=,args=" : "pid=,comm=,args="], {
      encoding: "utf8",
      timeout: 8e3
    });
    return parseUnixPs(out, matches);
  } catch {
    return [];
  }
}
function parsePidLines(out, sep, matches) {
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf(sep);
    if (i === -1) continue;
    const pid = Number(line.slice(0, i).trim());
    const cmd = line.slice(i + 1);
    if (Number.isInteger(pid) && pid > 0 && matches(cmd)) pids.push(pid);
  }
  return pids;
}
function parseUnixPs(out, matches) {
  const pids = [];
  for (const line of out.split("\n")) {
    const row = line.trim().match(/^(\d+)\s+(mpv|ffplay)\s+([\s\S]+)$/);
    if (!row) continue;
    const pid = Number(row[1]);
    if (Number.isInteger(pid) && pid > 0 && matches(row[3])) pids.push(pid);
  }
  return pids;
}
function isPiProcess(name, args) {
  if (name === "pi" || name === "pi.exe") return true;
  if (args.includes("pi-coding-agent")) return true;
  const argv1 = args.split(" ")[1] ?? "";
  const base = argv1.slice(argv1.lastIndexOf("/") + 1);
  return base === "pi" || base === "pi.js";
}
function enumerateProcesses() {
  const map = /* @__PURE__ */ new Map();
  if (isWin) {
    const out2 = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"
      ],
      { encoding: "utf8", timeout: 8e3, windowsHide: true }
    );
    const rows = JSON.parse(out2.trim() || "[]");
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      if (!r.ProcessId) continue;
      map.set(r.ProcessId, {
        pid: r.ProcessId,
        ppid: r.ParentProcessId ?? 0,
        name: r.Name ?? "",
        args: r.CommandLine ?? ""
      });
    }
    return map;
  }
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
    encoding: "utf8",
    timeout: 8e3
  });
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s+(\d+)\s+([\s\S]*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const args = m[3];
    const argv0 = args.split(" ")[0] ?? "";
    map.set(pid, {
      pid,
      ppid: Number(m[2]) || 0,
      name: argv0.slice(argv0.lastIndexOf("/") + 1),
      args
    });
  }
  return map;
}
function findPiProcess() {
  try {
    const procs = enumerateProcesses();
    const seen = /* @__PURE__ */ new Set();
    let pid = process.ppid;
    for (let depth = 0; depth < 32 && pid > 1 && !seen.has(pid); depth++) {
      seen.add(pid);
      const p = procs.get(pid);
      if (!p) break;
      if (isPiProcess(p.name, p.args)) return { pid, token: procStartToken(pid) };
      pid = p.ppid;
    }
  } catch {
  }
  return null;
}

// src/lock.ts
import { mkdirSync, readFileSync as readFileSync2, writeFileSync, renameSync, rmSync, rmdirSync, statSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
var LOCK_STALE_MS = 15e3;
var LOCK_WAIT_MS = 3e4;
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function reclaimDeadOwner(lockPath2) {
  try {
    const files = readdirSync(lockPath2);
    if (files.length === 0) {
      if (Date.now() - statSync(lockPath2).mtimeMs > LOCK_STALE_MS) rmdirSync(lockPath2);
      return;
    }
    if (files.length !== 1) return;
    const name = files[0];
    if (name !== "holder" && !/^holder-[0-9a-f-]{36}$/.test(name)) return;
    const holder = join(lockPath2, name);
    const [pidText, token] = readFileSync2(holder, "utf8").trim().split("\n");
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) {
      if (Date.now() - statSync(holder).mtimeMs <= LOCK_STALE_MS) return;
    } else if (sameProcess(pid, token || null)) {
      return;
    }
    unlinkSync(holder);
    rmdirSync(lockPath2);
  } catch {
  }
}
function release(lockPath2, owner) {
  try {
    unlinkSync(join(lockPath2, owner));
  } catch {
  }
  try {
    rmdirSync(lockPath2);
  } catch {
  }
}
function* acquireSteps(lockPath2) {
  mkdirSync(dirname(lockPath2), { recursive: true });
  const id2 = randomUUID();
  const owner = `holder-${id2}`;
  const staged = `${lockPath2}.claim.${process.pid}.${id2}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  mkdirSync(staged);
  try {
    writeFileSync(join(staged, owner), `${process.pid}
${procStartToken(process.pid) ?? ""}`);
    for (; ; ) {
      try {
        renameSync(staged, lockPath2);
        return owner;
      } catch (e) {
        const code = e.code;
        const occupied = code === "EEXIST" || code === "ENOTEMPTY";
        const windowsOccupied = process.platform === "win32" && (code === "EPERM" || code === "EACCES");
        if (!occupied && !windowsOccupied) throw e;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for lock: ${lockPath2}`, { cause: e });
        }
      }
      reclaimDeadOwner(lockPath2);
      yield;
    }
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}
function withCrossProcessLock(lockPath2, fn) {
  const steps = acquireSteps(lockPath2);
  let step = steps.next();
  while (!step.done) {
    sleep(50);
    step = steps.next();
  }
  const owner = step.value;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return (async () => {
        try {
          return await result;
        } finally {
          release(lockPath2, owner);
        }
      })();
    }
    release(lockPath2, owner);
    return result;
  } catch (e) {
    release(lockPath2, owner);
    throw e;
  }
}

// src/session.ts
var root = join2(homedir(), ".pirate-radio");
var directory;
var scopeKey = "";
var boundSession;
var pi;
function hostProcess() {
  if (pi === void 0) pi = findPiProcess();
  return pi;
}
function dataDir() {
  if (directory) return directory;
  const explicit = process.env.PIRATE_RADIO_SESSION?.trim();
  const inheritedDefault = !explicit && process.env.PIRATE_RADIO_DEFAULT_SCOPE === "1";
  const host = explicit || inheritedDefault ? null : hostProcess();
  const key = explicit || (host ? `pi:${host.pid}:${host.token ?? ""}` : "");
  scopeKey = key;
  directory = key ? join2(root, "sessions", createHash("sha256").update(key).digest("hex").slice(0, 24)) : root;
  return directory;
}
function readAnchor() {
  try {
    const a = JSON.parse(readFileSync3(join2(dataDir(), "anchor.json"), "utf8"));
    if (Number.isInteger(a?.pid) && a.pid > 0 && (a.token == null || typeof a.token === "string")) {
      return { pid: a.pid, token: a.token ?? null, sessionId: typeof a.sessionId === "string" ? a.sessionId : void 0 };
    }
  } catch {
  }
  return null;
}
function sessionId() {
  return boundSession ??= readAnchor()?.sessionId ?? "legacy";
}
function clearAnchor(expected) {
  const cur = readAnchor();
  if (expected && (!cur || cur.pid !== expected.pid || cur.token !== expected.token || cur.sessionId !== expected.sessionId)) return;
  try {
    unlinkSync2(join2(dataDir(), "anchor.json"));
  } catch {
  }
}
function withSessionLock(fn) {
  return withCrossProcessLock(join2(dataDir(), "session.lock"), fn);
}
function playerMarker(id2 = sessionId()) {
  return `pirate-radio-${createHash("sha256").update(`${dataDir()}:${id2}`).digest("hex").slice(0, 24)}`;
}
function bindSession(id2) {
  boundSession = id2;
}

// src/registry.ts
import {
  readFileSync as readFileSync4,
  writeFileSync as writeFileSync3,
  renameSync as renameSync3,
  mkdirSync as mkdirSync3,
  existsSync as existsSync2
} from "node:fs";
import { join as join3 } from "node:path";
var dir = dataDir();
var regPath = join3(dir, "players.json");
var lockPath = join3(dir, "players.lock");
function readRaw() {
  if (!existsSync2(regPath)) return { players: [], watchdogs: [] };
  try {
    const r = JSON.parse(readFileSync4(regPath, "utf8"));
    return { players: r.players ?? [], watchdogs: r.watchdogs ?? [] };
  } catch {
    return { players: [], watchdogs: [] };
  }
}
function writeRaw(r) {
  mkdirSync3(dir, { recursive: true });
  const tmp = `${regPath}.${process.pid}.tmp`;
  writeFileSync3(tmp, JSON.stringify(r, null, 2));
  renameSync3(tmp, regPath);
}
function withLock(fn) {
  return withCrossProcessLock(lockPath, () => {
    const reg = readRaw();
    const result = fn(reg);
    writeRaw(reg);
    return result;
  });
}
function livePlayers(id2 = sessionId()) {
  return withLock((r) => {
    r.players = prune(r.players);
    return r.players.filter((e) => owned(e, id2));
  });
}
function owned(entry, id2 = sessionId()) {
  return (entry.sessionId ?? "legacy") === id2;
}
function drainAll(id2 = sessionId()) {
  return withLock((r) => {
    const players = prune(r.players.filter((e) => owned(e, id2)));
    const watchdogs = prune(r.watchdogs.filter((e) => owned(e, id2)));
    r.players = r.players.filter((e) => !owned(e, id2));
    r.watchdogs = r.watchdogs.filter((e) => !owned(e, id2));
    return { players, watchdogs };
  });
}
function prune(list) {
  return list.filter((e) => sameProcess(e.pid, e.token));
}

// src/watchdog-loop.ts
function startWatchdogLoop(pollMs, finish, exit) {
  const timer = setInterval(() => {
    try {
      if (!finish()) return;
      clearInterval(timer);
      exit();
    } catch {
    }
  }, pollMs);
  return timer;
}

// src/watchdog.ts
var anchorPid = Number(process.argv[2]);
var anchorToken = process.argv[3] || null;
var playerPid = Number(process.argv[4]);
var kind = process.argv[5] === "pid" ? "pid" : "file";
var id = process.argv[6] || "legacy";
var playerToken = process.argv[7] || procStartToken(playerPid);
if (!Number.isInteger(anchorPid) || anchorPid <= 0 || !Number.isInteger(playerPid) || playerPid <= 0) process.exit(1);
bindSession(id);
var anchor = { pid: anchorPid, token: anchorToken, sessionId: id === "legacy" ? void 0 : id };
function stillOurAnchor() {
  const cur = readAnchor();
  return !!cur && cur.pid === anchor.pid && cur.token === anchor.token && cur.sessionId === anchor.sessionId;
}
function stopOwned() {
  const { players, watchdogs } = drainAll(id);
  for (const p of players) killSameProcess(p.pid, p.token);
  for (const w of watchdogs) if (w.pid !== process.pid) killSameProcess(w.pid, w.token);
  for (const pid of findOrphanPlayers(playerMarker(id))) killPid(pid);
}
var POLL_MS = lifecycleTestMode ? 50 : 3e3;
var tick = 0;
startWatchdogLoop(POLL_MS, () => {
  tick++;
  if (kind === "file" && !stillOurAnchor()) return true;
  if (!pidAlive(playerPid) && livePlayers(id).length === 0) return true;
  const dead = !pidAlive(anchorPid) || tick % 10 === 0 && !sameProcess(anchorPid, anchorToken);
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
