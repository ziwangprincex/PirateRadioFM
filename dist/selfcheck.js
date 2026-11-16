import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/selfcheck.ts
import { test } from "node:test";
import assert from "node:assert";
import { readdirSync as readdirSync2, readFileSync as readFileSync8 } from "node:fs";
import { dirname as dirname4, join as join9 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";

// src/player.ts
import { spawn, execFileSync as execFileSync2 } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname as dirname2, join as join4 } from "node:path";
import { mkdtempSync, rmSync as rmSync2, rmdirSync as rmdirSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID as randomUUID3 } from "node:crypto";

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
var KILL_GRACE_MS = 250;
var KILL_POLL_MS = 5;
function terminate(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (isWin) {
      execFileSync("taskkill", ["/F", "/PID", String(pid), "/T"], {
        stdio: "ignore",
        timeout: 8e3,
        windowsHide: true
      });
      return false;
    }
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
function forceKill(pid) {
  if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
    }
  }
}
async function killPidAsync(pid) {
  if (!terminate(pid)) return;
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && pidAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
  }
  forceKill(pid);
}
async function killSameProcessAsync(pid, token) {
  if (sameProcess(pid, token)) await killPidAsync(pid);
}
function findOrphanPlayers(marker) {
  if (!/^pirate-radio-[a-f0-9]{24}$/.test(marker)) return [];
  const matches = (cmd) => cmd.split(/[\s\"]+/).some((arg) => arg === `--title=${marker}` || arg === marker);
  try {
    if (isWin) {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='mpv.exe' OR Name='ffplay.exe'" -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`
        ],
        { encoding: "utf8", timeout: 8e3, windowsHide: true }
      );
      return parsePidLines(out, "	", matches);
    }
    const comm = isMac ? "ucomm=" : "comm=";
    const players = [];
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
function ps(args) {
  try {
    return execFileSync("ps", args, { encoding: "utf8", timeout: 8e3 });
  } catch (e) {
    const stdout = e.stdout;
    if (typeof stdout === "string" && e.status === 1) return stdout;
    throw e;
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
function ancestors() {
  if (isWin) return walk(enumerateWindowsProcesses());
  const parents = /* @__PURE__ */ new Map();
  for (const line of ps(["-eo", "pid=,ppid="]).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) parents.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: "", args: "" });
  }
  const chain = walk(parents);
  if (chain.length === 0) return [];
  const procs = /* @__PURE__ */ new Map();
  for (const line of ps(["-o", "pid=,ppid=,args=", "-p", chain.map((p) => p.pid).join(",")]).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\s\S]*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const args = m[3];
    const argv0 = args.split(" ")[0] ?? "";
    procs.set(pid, { pid, ppid: Number(m[2]) || 0, name: argv0.slice(argv0.lastIndexOf("/") + 1), args });
  }
  return walk(procs);
}
function walk(procs) {
  const chain = [];
  const seen = /* @__PURE__ */ new Set();
  let pid = process.ppid;
  for (let depth = 0; depth < 32 && pid > 1 && !seen.has(pid); depth++) {
    seen.add(pid);
    const p = procs.get(pid);
    if (!p) break;
    chain.push(p);
    pid = p.ppid;
  }
  return chain;
}
function enumerateWindowsProcesses() {
  const map = /* @__PURE__ */ new Map();
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"
    ],
    { encoding: "utf8", timeout: 8e3, windowsHide: true }
  );
  const rows = JSON.parse(out.trim() || "[]");
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
function findPiProcess() {
  try {
    for (const p of ancestors()) {
      if (isPiProcess(p.name, p.args)) return { pid: p.pid, token: procStartToken(p.pid) };
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
  const id = randomUUID();
  const owner = `holder-${id}`;
  const staged = `${lockPath2}.claim.${process.pid}.${id}`;
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
  let step2 = steps.next();
  while (!step2.done) {
    sleep(50);
    step2 = steps.next();
  }
  const owner = step2.value;
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
async function acquireAsyncCrossProcessLock(path, signal) {
  const steps = acquireSteps(path);
  try {
    for (; ; ) {
      signal?.throwIfAborted();
      const step2 = steps.next();
      if (step2.done) {
        const owner = step2.value;
        return () => release(path, owner);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    steps.return("");
  }
}
async function withAsyncCrossProcessLock(path, fn, signal) {
  const release2 = await acquireAsyncCrossProcessLock(path, signal);
  try {
    signal?.throwIfAborted();
    return await fn();
  } finally {
    release2();
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
function anchorAlive(anchor) {
  return !!anchor && sameProcess(anchor.pid, anchor.token);
}
function sessionId() {
  return boundSession ??= readAnchor()?.sessionId ?? "legacy";
}
function playerMarker(id = sessionId()) {
  return `pirate-radio-${createHash("sha256").update(`${dataDir()}:${id}`).digest("hex").slice(0, 24)}`;
}
function sessionEnvironment() {
  dataDir();
  const env = { ...process.env, PIRATE_RADIO_SESSION: scopeKey };
  if (scopeKey) delete env.PIRATE_RADIO_DEFAULT_SCOPE;
  else env.PIRATE_RADIO_DEFAULT_SCOPE = "1";
  return env;
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
    const before = JSON.stringify(reg);
    const result = fn(reg);
    if (JSON.stringify(reg) !== before) writeRaw(reg);
    return result;
  });
}
function addPlayer(pid, host, metadata = {}) {
  const token = procStartToken(pid);
  withLock((r) => {
    r.players = prune(r.players);
    r.players.push({ ...metadata, pid, token, host, sessionId: sessionId() });
  });
}
function addWatchdog(pid) {
  const token = procStartToken(pid);
  withLock((r) => {
    r.watchdogs = prune(r.watchdogs);
    r.watchdogs.push({ pid, token, sessionId: sessionId() });
  });
}
function livePlayers(id = sessionId()) {
  return withLock((r) => {
    r.players = prune(r.players);
    return r.players.filter((e) => owned(e, id));
  });
}
function livePlayerCountUnlocked() {
  try {
    return prune(readRaw().players).filter((e) => owned(e)).length;
  } catch {
    return 0;
  }
}
function removePlayer(pid) {
  withLock((r) => {
    r.players = r.players.filter((e) => e.pid !== pid);
  });
}
function removeWatchdog(pid) {
  withLock((r) => {
    r.watchdogs = r.watchdogs.filter((e) => e.pid !== pid);
  });
}
function owned(entry, id = sessionId()) {
  return (entry.sessionId ?? "legacy") === id;
}
function drainAll(id = sessionId()) {
  return withLock((r) => {
    const players = prune(r.players.filter((e) => owned(e, id)));
    const watchdogs = prune(r.watchdogs.filter((e) => owned(e, id)));
    r.players = r.players.filter((e) => !owned(e, id));
    r.watchdogs = r.watchdogs.filter((e) => !owned(e, id));
    return { players, watchdogs };
  });
}
function prune(list2) {
  return list2.filter((e) => sameProcess(e.pid, e.token));
}

// src/ipc.ts
import { createConnection } from "node:net";
import { randomInt } from "node:crypto";

// src/http.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
var context = new AsyncLocalStorage();
function operationSignal() {
  return context.getStore();
}
function checkCancelled() {
  operationSignal()?.throwIfAborted();
}
async function wait(ms) {
  checkCancelled();
  await delay(ms, void 0, { signal: operationSignal() });
}
function networkError(e) {
  const cause = e?.cause;
  const detail = cause?.message || cause?.code;
  return e instanceof TypeError && detail ? new Error(`Network error: ${detail}`, { cause: e }) : e;
}
async function request(url, init = {}, options = {}) {
  const deadline = Date.now() + (options.budgetMs ?? 15e3);
  const method = (init.method ?? "GET").toUpperCase();
  const retries = ["GET", "HEAD"].includes(method) ? options.retries ?? 1 : 0;
  const parent = init.signal ?? operationSignal();
  for (let attempt = 0; ; attempt++) {
    parent?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("HTTP retry budget exhausted");
    const ac = new AbortController();
    const abort = () => ac.abort(parent?.reason ?? new Error("Request cancelled"));
    parent?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => ac.abort(new Error("HTTP request timed out")), Math.min(options.timeoutMs ?? 8e3, remaining));
    let retryDelay = 200 * (attempt + 1);
    try {
      const response = await fetch(url, { ...init, signal: ac.signal });
      if (attempt < retries && [429, 502, 503, 504].includes(response.status)) {
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          retryDelay = Number.isFinite(seconds) ? seconds * 1e3 : Math.max(0, Date.parse(retryAfter) - Date.now());
        }
        await response.body?.cancel();
      } else {
        if (options.probe || method === "HEAD" || [204, 205, 304].includes(response.status)) {
          await response.body?.cancel();
          return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
        }
        const reader = response.body?.getReader();
        const chunks = [];
        let size = 0;
        if (reader) {
          try {
            for (; ; ) {
              const part = await reader.read();
              if (part.done) break;
              const limit = options.maxBytes ?? 4 * 1024 * 1024;
              if (size + part.value.length > limit) {
                if (!options.truncate) throw new Error("HTTP response exceeds size limit");
                chunks.push(part.value.subarray(0, limit - size));
                await reader.cancel().catch(() => {
                });
                break;
              }
              size += part.value.length;
              chunks.push(part.value);
            }
          } catch (e) {
            await reader.cancel().catch(() => {
            });
            throw e;
          } finally {
            reader.releaseLock();
          }
        }
        return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
      }
    } catch (e) {
      parent?.throwIfAborted();
      if (attempt >= retries) throw networkError(e);
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    }
    if (!Number.isFinite(retryDelay) || retryDelay >= deadline - Date.now()) throw new Error("HTTP retry budget exhausted");
    await delay(Math.max(0, retryDelay), void 0, { signal: parent ?? void 0 });
  }
}

// src/ipc.ts
async function mpvCommand(path, command, timeoutMs = 1500, signal = operationSignal()) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = randomInt(1, 2147483647);
    const socket = createConnection(path);
    let buffer = "", settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(data);
    };
    const abort = () => finish(new Error("Player control cancelled"));
    const timer = setTimeout(() => finish(new Error("mpv IPC timed out")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ command, request_id: id }) + "\n"));
    socket.on("error", (e) => finish(e));
    socket.on("close", () => finish(new Error("mpv IPC disconnected before acknowledgement")));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        finish(new Error("mpv IPC response too large"));
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.request_id !== id) continue;
          finish(message.error === "success" ? void 0 : new Error(`mpv: ${message.error ?? "invalid response"}`), message.data);
        } catch {
          finish(new Error("Malformed mpv IPC response"));
        }
      }
    });
  });
}

// src/player.ts
var detected;
function detect() {
  if (detected !== void 0) return detected;
  for (const p of ["mpv", "ffplay"]) {
    try {
      if (process.platform === "win32") {
        execFileSync2("where", [p], { stdio: "ignore", windowsHide: true });
      } else {
        execFileSync2("sh", ["-c", `command -v ${p}`], { stdio: "ignore" });
      }
      detected = p;
      return p;
    } catch {
    }
  }
  detected = null;
  return null;
}
function playerAvailable() {
  return detect();
}
function installHint() {
  return "No audio player found. Install mpv (recommended) or ffmpeg:\n  macOS:   brew install mpv\n  Windows: winget install mpv   (or scoop install mpv)\n  Linux:   sudo apt install mpv  (or your package manager)";
}
async function stop(id = sessionId()) {
  const { players, watchdogs } = drainAll(id);
  await Promise.all([
    ...players.map(async (p) => {
      await killSameProcessAsync(p.pid, p.token);
      removeIpc(p.ipc);
    }),
    ...watchdogs.filter((w) => w.pid !== process.pid).map((w) => killSameProcessAsync(w.pid, w.token))
  ]);
  await Promise.all(findOrphanPlayers(playerMarker(id)).map((pid) => killPidAsync(pid)));
}
var here = dirname2(fileURLToPath(import.meta.url));
function ipcPath() {
  if (process.platform === "win32") return `\\\\.\\pipe\\pirate-radio-${randomUUID3()}`;
  return join4(mkdtempSync(join4(tmpdir(), "pr-")), "mpv.sock");
}
function removeIpc(ipc) {
  if (!ipc || process.platform === "win32") return;
  try {
    rmSync2(ipc, { force: true });
  } catch {
  }
  if (basename(dirname2(ipc)).startsWith("pr-")) {
    try {
      rmdirSync2(dirname2(ipc));
    } catch {
    }
  }
}
async function play(url, volume) {
  checkCancelled();
  const player = detect();
  if (!player) throw new Error(installHint());
  await stop();
  const marker = playerMarker();
  const ipc = player === "mpv" ? ipcPath() : void 0;
  const args = player === "mpv" ? ["--no-config", "--no-video", "--really-quiet", `--title=${marker}`, `--input-ipc-server=${ipc}`, `--volume=${volume}`, "--", url] : ["-nodisp", "-autoexit", "-loglevel", "quiet", "-window_title", marker, "-volume", String(volume), "-i", url];
  const child = spawn(player, args, { stdio: "ignore", detached: true, windowsHide: true });
  const pid = child.pid;
  let error;
  child.on("error", (e) => {
    error = e;
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!pid) throw new Error("Audio player did not start");
    let host;
    try {
      host = new URL(url).host;
    } catch {
    }
    addPlayer(pid, host, { ipc, player });
    child.on("exit", () => {
      try {
        removePlayer(pid);
      } catch {
      }
    });
    if (ipc) {
      const deadline = Date.now() + 4e3;
      for (; ; ) {
        checkCancelled();
        if (error || child.exitCode !== null) throw error ?? new Error("mpv exited during startup");
        try {
          await mpvCommand(ipc, ["get_property", "pid"], 500);
          break;
        } catch (e) {
          if (Date.now() >= deadline) throw e;
          await wait(10);
        }
      }
    }
    spawnWatchdog(pid);
    child.unref();
  } catch (e) {
    if (pid) {
      await killPidAsync(pid);
      removePlayer(pid);
    }
    removeIpc(ipc);
    throw e;
  }
}
async function setPaused(paused) {
  const players = livePlayers();
  if (!players.length) return false;
  if (paused && players.some((p) => !p.ipc)) throw new Error("Pausing without restarting requires mpv. Use radio_stop or install mpv.");
  for (const p of players) {
    if (!sameProcess(p.pid, p.token)) throw new Error("Player exited");
    if (p.ipc) await mpvCommand(p.ipc, ["set_property", "pause", paused]);
  }
  return true;
}
async function setVolume(volume) {
  const players = livePlayers();
  if (players.some((p) => !p.ipc)) return false;
  for (const p of players) {
    if (!sameProcess(p.pid, p.token)) throw new Error("Player exited");
    await mpvCommand(p.ipc, ["set_property", "volume", volume]);
  }
  return true;
}
function spawnWatchdog(playerPid) {
  const anchor = readAnchor();
  if (anchor && anchorAlive(anchor)) {
    spawnWatchdogProc("file", anchor.pid, anchor.token, playerPid);
    return;
  }
  const host = hostProcess();
  if (host) spawnWatchdogProc("pid", host.pid, host.token, playerPid);
}
function spawnWatchdogProc(kind, anchorPid, token, playerPid) {
  const wd = spawn(
    process.execPath,
    [join4(here, "watchdog.js"), String(anchorPid), token ?? "", String(playerPid), kind, sessionId(), procStartToken(playerPid) ?? ""],
    { stdio: "ignore", detached: true, windowsHide: true, env: sessionEnvironment() }
  );
  wd.on("error", () => {
    if (wd.pid) {
      try {
        removeWatchdog(wd.pid);
      } catch {
      }
    }
  });
  if (wd.pid) {
    addWatchdog(wd.pid);
    wd.on("exit", () => {
      try {
        removeWatchdog(wd.pid);
      } catch {
      }
    });
  }
  wd.unref();
}

// src/sources/spotify.ts
import { readFileSync as readFileSync6, writeFileSync as writeFileSync5, mkdirSync as mkdirSync5, existsSync as existsSync4, renameSync as renameSync5 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join6 } from "node:path";
import { createHash as createHash2, randomBytes } from "node:crypto";

// src/state.ts
import { readFileSync as readFileSync5, writeFileSync as writeFileSync4, renameSync as renameSync4, mkdirSync as mkdirSync4, existsSync as existsSync3 } from "node:fs";
import { join as join5 } from "node:path";
import { AsyncLocalStorage as AsyncLocalStorage2 } from "node:async_hooks";
var stateDir = dataDir();
var stateFilePath = join5(stateDir, "state.json");
var stateLockPath = join5(stateDir, "state.lock");
var defaults = {
  revision: 0,
  state: "stopped",
  source: null,
  genre: null,
  stationName: null,
  stationIndex: 0,
  title: null,
  volume: 80,
  spotifyVerifier: null,
  podcastFeed: null,
  podcastName: null,
  episodeIndex: 0
};
var transactions = new AsyncLocalStorage2();
var fallback = { ...defaults };
var now = new Proxy(fallback, {
  get: (target, key) => Reflect.get(transactions.getStore()?.draft ?? target, key),
  set: (target, key, value) => Reflect.set(transactions.getStore()?.draft ?? target, key, value),
  ownKeys: () => Reflect.ownKeys(defaults),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
});
function snapshot() {
  return transactions.run(void 0, () => {
    loadStateUnlocked();
    return { ...fallback };
  });
}
function ensureCurrent(tx, current) {
  const anchor = readAnchor();
  if (!tx.release && tx.revision !== void 0 && current.revision !== tx.revision || tx.session !== "legacy" && anchor?.sessionId !== tx.session || anchor?.sessionId && anchor.sessionId !== tx.session) {
    throw new Error("Playback request superseded by a newer command or session");
  }
}
async function playbackEffect(fn) {
  checkCancelled();
  const tx = transactions.getStore();
  if (tx?.release) return await fn();
  const releaseSession = await acquireAsyncCrossProcessLock(join5(stateDir, "session.lock"), operationSignal());
  let releasePlayback;
  const release2 = () => {
    releasePlayback?.();
    releaseSession();
  };
  try {
    releasePlayback = await acquireAsyncCrossProcessLock(join5(stateDir, "playback.lock"), operationSignal());
  } catch (e) {
    releaseSession();
    throw e;
  }
  try {
    checkCancelled();
    if (tx) withCrossProcessLock(stateLockPath, () => {
      const current = snapshot();
      ensureCurrent(tx, current);
      const draft = { ...current };
      for (const key of Object.keys(defaults)) {
        if (key !== "revision" && tx.draft[key] !== tx.base[key])
          draft[key] = tx.draft[key];
      }
      tx.base = current;
      tx.draft = draft;
      tx.release = release2;
    });
    return await fn();
  } finally {
    if (!tx?.release) release2();
  }
}
var fieldType = {
  revision: "number",
  state: "string",
  source: "string",
  genre: "string",
  stationName: "string",
  stationIndex: "number",
  title: "string",
  volume: "number",
  spotifyVerifier: "string",
  podcastFeed: "string",
  podcastName: "string",
  episodeIndex: "number"
};
function loadStateUnlocked() {
  if (!existsSync3(stateFilePath)) {
    Object.assign(now, defaults);
    return;
  }
  let raw = {};
  try {
    raw = JSON.parse(readFileSync5(stateFilePath, "utf8"));
  } catch {
    process.stderr.write("radiohead: state.json unreadable, resetting to defaults\n");
    Object.assign(now, defaults);
    return;
  }
  const target = now;
  for (const key of Object.keys(defaults)) {
    const got = raw?.[key];
    if (got === null && defaults[key] === null || typeof got === fieldType[key]) target[key] = got;
    else target[key] = defaults[key];
  }
  if (!Number.isSafeInteger(now.revision) || now.revision < 0) now.revision = 0;
}
function describe() {
  if (now.state === "stopped" || !now.source) return "Stopped.";
  const localSource = now.source === "radio" || now.source === "podcast" || now.source === "hoer";
  if (localSource && now.state === "playing" && livePlayerCountUnlocked() === 0) {
    return "Stopped (player exited unexpectedly).";
  }
  const what = now.source === "radio" ? `${now.genre} radio \u2014 ${now.stationName}` : now.source === "podcast" ? `Podcast ${now.podcastName ?? "(unknown)"} \u2014 ${now.title ?? "(unknown)"}` : now.source === "hoer" ? `H\xD6R Berlin \u2014 ${now.title ?? "(unknown)"}` : now.source === "applemusic" ? `Apple Music \u2014 ${now.title ?? "(unknown)"}` : `Spotify \u2014 ${now.title ?? "(unknown)"}`;
  return `${now.state === "paused" ? "Paused" : "Playing"}: ${what} (vol ${now.volume})`;
}

// src/sources/spotify.ts
var API = "https://api.spotify.com/v1";
var AUTH = "https://accounts.spotify.com";
var REDIRECT = "http://127.0.0.1:8888/callback";
var SCOPES = "user-read-playback-state user-modify-playback-state playlist-read-private";
var cfgDir = join6(homedir2(), ".pirate-radio");
var tokenPath = join6(cfgDir, "spotify.json");
function clientId() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  if (!id) throw new Error("Set SPOTIFY_CLIENT_ID (from your Spotify developer app) to use Spotify.");
  return id;
}
function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function loadTokens() {
  if (!existsSync4(tokenPath)) return null;
  try {
    return JSON.parse(readFileSync6(tokenPath, "utf8"));
  } catch {
    return null;
  }
}
function saveTokens(t) {
  mkdirSync5(cfgDir, { recursive: true });
  const tmp = `${tokenPath}.${process.pid}.tmp`;
  writeFileSync5(tmp, JSON.stringify(t, null, 2), { mode: 384 });
  renameSync5(tmp, tokenPath);
}
function loginUrl() {
  const v = b64url(randomBytes(48));
  const challenge = b64url(createHash2("sha256").update(v).digest());
  now.spotifyVerifier = v;
  const p = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: REDIRECT,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SCOPES
  });
  return `${AUTH}/authorize?${p}`;
}
function authorizationCode(input) {
  const s = input.trim();
  let params = null;
  if (/^https?:\/\//i.test(s)) {
    try {
      params = new URL(s).searchParams;
    } catch {
    }
  } else if (/^\??code=/.test(s)) params = new URLSearchParams(s.replace(/^\?/, ""));
  if (!params) return s;
  const denied = params.get("error");
  if (denied) throw new Error(`Spotify login was not approved (${denied}). Run spotify_login again.`);
  const code = params.get("code");
  if (!code) throw new Error("No code= parameter in what was pasted. Copy the full redirect URL after approving.");
  return code;
}
async function complete(pasted) {
  const v = now.spotifyVerifier;
  if (!v) throw new Error("Call spotify_login first to start the flow.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode(pasted),
    redirect_uri: REDIRECT,
    client_id: clientId(),
    code_verifier: v
  });
  const r = await request(`${AUTH}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error(`Token exchange failed: ${await r.text()}`);
  const j = await r.json();
  if (!j.access_token || !j.refresh_token)
    throw new Error("Token exchange returned no tokens \u2014 check the code and your Spotify app settings.");
  const ttl = Number(j.expires_in) || 3600;
  saveTokens({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + ttl * 1e3 });
  now.spotifyVerifier = null;
}
async function accessToken() {
  const cached = loadTokens();
  if (!cached) throw new Error("Not logged in to Spotify. Run spotify_login.");
  if (Date.now() < cached.expires_at - 3e4) return cached.access_token;
  return withAsyncCrossProcessLock(join6(cfgDir, "spotify.lock"), async () => {
    const t = loadTokens();
    if (!t) throw new Error("Not logged in to Spotify. Run spotify_login.");
    if (Date.now() < t.expires_at - 3e4) return t.access_token;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId() });
    const r = await request(`${AUTH}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    if (!r.ok) throw new Error(`Token refresh failed (${r.status}); run spotify_login again.`);
    const j = await r.json();
    if (!j.access_token) throw new Error("Token refresh returned no access token \u2014 run spotify_login again.");
    const ttl = Number(j.expires_in) || 3600;
    saveTokens({ access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: Date.now() + ttl * 1e3 });
    return j.access_token;
  }, operationSignal());
}
async function api(path, init) {
  const tok = await accessToken();
  const r = await request(`${API}${path}`, {
    ...init,
    headers: { ...init?.headers ?? {}, Authorization: `Bearer ${tok}` }
  });
  if (!r.ok) {
    const body = r.status === 404 ? "" : await r.text().catch(() => "");
    throw statusError(r.status, spotifyErrorMessage(r.status, body, r.statusText));
  }
  return r;
}
function spotifyErrorMessage(status, body, statusText = "") {
  if (status === 404)
    return "No active Spotify device found. Open the Spotify app (Premium required) and play something once, then retry \u2014 or use spotify_devices.";
  let message = "", reason = "";
  try {
    const error = JSON.parse(body).error;
    if (typeof error?.message === "string") message = error.message;
    if (typeof error?.reason === "string") reason = error.reason;
  } catch {
  }
  if (status === 403) {
    return reason === "PREMIUM_REQUIRED" || /premium/i.test(message) || !message && !reason ? "Spotify refused the command. Premium is required for playback control." : `Spotify refused the command: ${message || reason}.`;
  }
  return `Spotify API ${status}: ${(message || body).slice(0, 200) || statusText}`;
}
function statusError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
async function listPlaylists() {
  const r = await api("/me/playlists?limit=20");
  const j = await r.json();
  const items = (j.items ?? []).map((p) => `\u2022 ${p.name}  [${p.uri}]`);
  return items.length ? items.join("\n") : "No playlists found.";
}
var SEARCH_TYPES = ["track", "album", "artist", "playlist", "show", "episode"];
function fmtHit(t, x) {
  const by = t === "track" || t === "album" ? ` \u2014 ${(x.artists ?? []).map((a) => a.name).join(", ")}` : t === "playlist" ? ` \u2014 by ${x.owner?.display_name ?? "?"}` : t === "show" ? ` \u2014 ${x.publisher ?? "?"}` : "";
  return `\u2022 ${x.name}${by}  [${x.uri}]`;
}
async function search(query, types) {
  const wanted = (types ?? "track,album,playlist,show").split(",").map((t) => t.trim().toLowerCase()).filter((t) => SEARCH_TYPES.includes(t));
  if (wanted.length === 0)
    throw new Error(`No valid search type. Use a comma list of: ${SEARCH_TYPES.join(", ")}`);
  const p = new URLSearchParams({ q: query, type: wanted.join(","), limit: "5" });
  const r = await api(`/search?${p}`);
  const j = await r.json();
  const out = [];
  for (const t of wanted) {
    const items = (j[`${t}s`]?.items ?? []).filter(Boolean);
    if (items.length === 0) continue;
    out.push(`${t.toUpperCase()}S`, ...items.map((x) => fmtHit(t, x)));
  }
  return out.length ? out.join("\n") : `No results for "${query}".`;
}
async function searchBest(query) {
  const p = new URLSearchParams({ q: query, type: "track,album,playlist,show", limit: "1" });
  const r = await api(`/search?${p}`);
  const j = await r.json();
  for (const t of ["track", "album", "playlist", "show"]) {
    const hit = (j[`${t}s`]?.items ?? []).filter(Boolean)[0];
    if (hit?.uri) return { uri: hit.uri, name: `${hit.name}${hit.artists ? ` \u2014 ${hit.artists.map((a) => a.name).join(", ")}` : ""}` };
  }
  return null;
}
async function deviceList() {
  const r = await api("/me/player/devices");
  const j = await r.json();
  return (j.devices ?? []).filter((d) => typeof d.id === "string");
}
async function devices() {
  const ds = await deviceList();
  if (ds.length === 0)
    return "No Spotify devices online. Open Spotify on your computer/phone, then retry.";
  return ds.map((d) => `${d.is_active ? "> " : "\u2022 "}${d.name} (${d.type})  [${d.id}]`).join("\n");
}
async function transfer(nameOrId) {
  const ds = await deviceList();
  const q = nameOrId.trim().toLowerCase();
  const hit = ds.find((d) => d.id === nameOrId) ?? ds.find((d) => d.name.toLowerCase().includes(q));
  if (!hit) {
    const names = ds.map((d) => d.name).join(", ") || "(none online)";
    throw new Error(`No device matching "${nameOrId}". Online: ${names}`);
  }
  await api("/me/player", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_ids: [hit.id], play: true })
  });
  return `Playback moved to ${hit.name}.`;
}
async function nowPlayingLine() {
  const r = await api("/me/player");
  if (r.status === 204) return "Spotify: nothing playing.";
  const j = await r.json();
  const item = j.item;
  if (!item) return "Spotify: nothing playing.";
  const who = (item.artists ?? []).map((a) => a.name).join(", ") || item.show?.name || "";
  const t = (ms) => `${Math.floor(ms / 6e4)}:${String(Math.floor(ms % 6e4 / 1e3)).padStart(2, "0")}`;
  const pos = Number.isFinite(j.progress_ms) && Number.isFinite(item.duration_ms) ? ` (${t(j.progress_ms)}/${t(item.duration_ms)})` : "";
  return `${j.is_playing ? "Playing" : "Paused"}: ${item.name}${who ? ` \u2014 ${who}` : ""}${pos} on ${j.device?.name ?? "?"}`;
}
function urlToUri(s) {
  const m = s.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|show|episode)\/([A-Za-z0-9]+)/i);
  return m ? `spotify:${m[1].toLowerCase()}:${m[2]}` : s;
}
function playBody(uri) {
  return /^spotify:(track|episode):/.test(uri) ? JSON.stringify({ uris: [uri] }) : JSON.stringify({ context_uri: uri });
}
async function playContext(uriOrName) {
  let uri = urlToUri(uriOrName.trim());
  let displayName = uriOrName;
  if (!uri.startsWith("spotify:")) {
    const r = await api("/me/playlists?limit=50");
    const j = await r.json();
    const hit = (j.items ?? []).find((p) => p.name?.toLowerCase() === uriOrName.toLowerCase());
    if (hit?.uri) {
      uri = hit.uri;
      displayName = hit.name ?? uriOrName;
    } else {
      const best = await searchBest(uriOrName);
      if (!best) throw new Error(`Nothing on Spotify matches "${uriOrName}". Try spotify_search.`);
      uri = best.uri;
      displayName = best.name;
    }
  }
  await playbackEffect(async () => {
    await playWithRecovery(playBody(uri));
    await stop();
  });
  now.state = "playing";
  now.source = "spotify";
  now.title = displayName;
  return `Playing ${displayName} on your Spotify device.`;
}
async function playWithRecovery(body) {
  const put = (device) => api(`/me/player/play${device ? `?device_id=${device}` : ""}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body
  });
  try {
    await put();
  } catch (e) {
    if (e.status !== 404 || process.platform !== "darwin") throw e;
    const id = await launchAndWaitForDevice();
    if (!id) throw e;
    await put(id);
  }
}
async function launchAndWaitForDevice() {
  try {
    const { execFileSync: execFileSync5 } = await import("node:child_process");
    execFileSync5("open", ["-a", "Spotify"], { stdio: "ignore", timeout: 8e3 });
  } catch {
    return null;
  }
  for (let i = 0; i < 6; i++) {
    await wait(2e3);
    try {
      const ds = await deviceList();
      const d = ds.find((x) => x.type.toLowerCase() === "computer") ?? ds[0];
      if (d) return d.id;
    } catch {
      checkCancelled();
    }
  }
  return null;
}
async function pause() {
  await api("/me/player/pause", { method: "PUT" });
}
async function resume() {
  await api("/me/player/play", { method: "PUT" });
}
async function skipNext() {
  await api("/me/player/next", { method: "POST" });
}
async function skipPrev() {
  await api("/me/player/previous", { method: "POST" });
}
async function setVolume2(percent) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  await api(`/me/player/volume?volume_percent=${p}`, { method: "PUT" });
}

// src/sources/applemusic.ts
import { execFileSync as execFileSync3 } from "node:child_process";
function assertMac() {
  if (process.platform !== "darwin")
    throw new Error("Apple Music control requires macOS (it drives the local Music.app via AppleScript).");
}
function escapeAS(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function osa(script) {
  return execFileSync3("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 15e3,
    windowsHide: true
  }).trim();
}
async function play2(target) {
  assertMac();
  const t = escapeAS(target.trim());
  if (!t) throw new Error("Give me a playlist, song, or album name from your Music library.");
  return playbackEffect(async () => {
    const attempts = [
      { script: `tell application "Music" to play playlist "${t}"`, kind: "playlist" },
      { script: `tell application "Music" to play (first track of library playlist 1 whose name contains "${t}")`, kind: "track" },
      { script: `tell application "Music" to play (first track of library playlist 1 whose album contains "${t}")`, kind: "album" }
    ];
    let played = null;
    for (const a of attempts) {
      try {
        osa(a.script);
        played = a.kind;
        break;
      } catch {
      }
    }
    if (!played)
      throw new Error(
        `Nothing in your Music library matches "${target}". AppleScript can only play what's already in the library \u2014 add it in Music.app first.`
      );
    await stop();
    if (now.source === "spotify") {
      try {
        await pause();
      } catch {
      }
    }
    let title = target;
    try {
      title = nowPlayingLine2();
    } catch {
    }
    now.state = "playing";
    now.source = "applemusic";
    now.title = title;
    return `> Apple Music (${played}): ${title}`;
  });
}
function pauseIfRunning() {
  if (process.platform !== "darwin") return;
  try {
    osa(ifRunning("pause"));
  } catch {
  }
}
function ifRunning(verb) {
  return `if application "Music" is running then tell application "Music" to ${verb}`;
}
function pause2() {
  assertMac();
  osa(ifRunning("pause"));
}
function stop2() {
  assertMac();
  osa(ifRunning("stop"));
}
function next() {
  assertMac();
  osa(ifRunning("next track"));
}
function prev() {
  assertMac();
  osa(ifRunning("previous track"));
}
function setVolume3(percent) {
  assertMac();
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  osa(ifRunning(`set sound volume to ${p}`));
}
function resume2() {
  assertMac();
  osa(`tell application "Music" to play`);
}
function nowPlayingLine2() {
  assertMac();
  const out = osa(
    `if application "Music" is running then tell application "Music" to (get name of current track) & " \u2014 " & (get artist of current track)`
  );
  if (!out) throw new Error("Music.app isn't running.");
  return out;
}

// src/stations.ts
import { readFileSync as readFileSync7 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname3, join as join7 } from "node:path";
var here2 = dirname3(fileURLToPath2(import.meta.url));
var emptyCatalog = { version: 2, aliases: {}, genres: {} };
var catalog = emptyCatalog;
try {
  const raw = JSON.parse(readFileSync7(join7(here2, "..", "data", "stations.json"), "utf8"));
  catalog = validateCatalog(raw);
} catch (e) {
  process.stderr.write(`radiohead: failed to load stations.json \u2014 ${e.message}
`);
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function validateCatalog(value) {
  if (!value || typeof value !== "object") throw new Error("catalog must be an object");
  const raw = value;
  if (raw.version !== 2) throw new Error(`unsupported catalog version: ${String(raw.version)}`);
  if (!raw.aliases || typeof raw.aliases !== "object" || Array.isArray(raw.aliases))
    throw new Error("aliases must be an object");
  if (!raw.genres || typeof raw.genres !== "object" || Array.isArray(raw.genres))
    throw new Error("genres must be an object");
  const genres3 = {};
  const seenUrls = /* @__PURE__ */ new Set();
  for (const [id, candidate] of Object.entries(raw.genres)) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid genre id: ${id}`);
    if (!candidate || typeof candidate !== "object") throw new Error(`${id}: genre must be an object`);
    const genre = candidate;
    if (!nonEmpty(genre.label)) throw new Error(`${id}: label is required`);
    if (!nonEmpty(genre.description)) throw new Error(`${id}: description is required`);
    if (!Array.isArray(genre.stations) || genre.stations.length === 0)
      throw new Error(`${id}: stations must be a non-empty array`);
    const stations2 = genre.stations.map((candidateStation, index) => {
      if (!candidateStation || typeof candidateStation !== "object")
        throw new Error(`${id}[${index}]: station must be an object`);
      const station = candidateStation;
      if (!nonEmpty(station.name)) throw new Error(`${id}[${index}]: name is required`);
      if (!nonEmpty(station.url)) throw new Error(`${id}[${index}]: url is required`);
      let parsed;
      try {
        parsed = new URL(station.url);
      } catch {
        throw new Error(`${id}[${index}]: invalid URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error(`${id}[${index}]: URL must be HTTP(S)`);
      if (seenUrls.has(station.url)) throw new Error(`${id}[${index}]: duplicate URL ${station.url}`);
      seenUrls.add(station.url);
      return { name: station.name, url: station.url };
    });
    genres3[id] = { label: genre.label, description: genre.description, stations: stations2 };
  }
  const aliases2 = {};
  for (const [alias, target] of Object.entries(raw.aliases)) {
    if (!/^[a-z0-9-]+$/.test(alias) || !nonEmpty(target)) throw new Error(`invalid alias: ${alias}`);
    if (genres3[alias]) throw new Error(`alias conflicts with genre: ${alias}`);
    if (!genres3[target]) throw new Error(`alias ${alias} targets unknown genre ${target}`);
    aliases2[alias] = target;
  }
  return { version: 2, aliases: aliases2, genres: genres3 };
}
function all() {
  return Object.fromEntries(Object.entries(catalog.genres).map(([id, genre]) => [id, genre.stations]));
}
function genres() {
  return Object.keys(catalog.genres);
}
function aliases() {
  return { ...catalog.aliases };
}
function acceptedGenres() {
  return [...genres(), ...Object.keys(catalog.aliases)];
}
function resolveGenre(input) {
  const id = input.trim().toLowerCase();
  if (catalog.genres[id]) return id;
  return catalog.aliases[id] ?? null;
}
function genreInfo(id) {
  const resolved = resolveGenre(id);
  return resolved ? catalog.genres[resolved] : null;
}
function catalogVersion() {
  return catalog.version;
}
var hostCache = null;
function hosts() {
  if (hostCache) return hostCache;
  const set = /* @__PURE__ */ new Set();
  for (const genre of Object.values(catalog.genres)) {
    for (const station of genre.stations) set.add(new URL(station.url).host.toLowerCase());
  }
  hostCache = [...set];
  return hostCache;
}

// src/sources/radio.ts
var stations = all();
function genres2() {
  return genres();
}
function list() {
  return genres2().map((g) => {
    const info = genreInfo(g);
    return `${g} \u2014 ${info.label} (${stations[g].length} station${stations[g].length > 1 ? "s" : ""})`;
  }).join(", ");
}
async function playGenre(genre, index = 0) {
  const g = resolveGenre(genre);
  if (!g) throw new Error(`Unknown genre "${genre}". Available: ${acceptedGenres().join(", ")}`);
  const len = stations[g].length;
  const i = (Math.trunc(index) % len + len) % len;
  const st = stations[g][i];
  await playbackEffect(async () => {
    if (now.source === "spotify") {
      try {
        await pause();
      } catch {
      }
    }
    if (now.source === "applemusic") pauseIfRunning();
    await play(st.url, now.volume);
  });
  now.state = "playing";
  now.source = "radio";
  now.genre = g;
  now.stationName = st.name;
  now.stationIndex = i;
  return st;
}
async function next2() {
  if (now.source !== "radio" || !now.genre)
    throw new Error("No radio station is playing.");
  return playGenre(now.genre, now.stationIndex + 1);
}
async function prev2() {
  if (now.source !== "radio" || !now.genre)
    throw new Error("No radio station is playing.");
  const genre = resolveGenre(now.genre);
  if (!genre) throw new Error(`Unknown saved genre "${now.genre}".`);
  const len = stations[genre].length;
  return playGenre(genre, (now.stationIndex - 1 + len) % len);
}

// src/argparse.ts
function parseArgs(rest, schema) {
  const args = {};
  if (rest.length === 1 && rest[0].startsWith("{")) {
    return JSON.parse(rest[0]);
  }
  const schemaProps = schema && schema.properties || {};
  let lastKey = null;
  for (const kv of rest) {
    const eq = kv.indexOf("=");
    if (eq === -1) {
      if (lastKey !== null && typeof args[lastKey] === "string") {
        args[lastKey] = `${args[lastKey]} ${kv}`;
      }
      continue;
    }
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    const expected = schemaProps[k]?.type;
    if ((expected === "number" || expected === "integer") && /^-?\d+(\.\d+)?$/.test(v)) {
      args[k] = Number(v);
      lastKey = null;
    } else {
      args[k] = v;
      lastKey = k;
    }
  }
  return args;
}

// src/sources/podcast.ts
var MAX_EPISODES = 50;
var NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\xA0" };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== "#") return NAMED_ENTITIES[entity] ?? match;
    const hex = entity[1] === "x" || entity[1] === "X";
    const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 1114111 ? String.fromCodePoint(code) : match;
  });
}
function textOf(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, "i"));
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? "").trim();
  return raw ? decodeEntities(raw) : null;
}
function parseFeed(xml) {
  const episodes = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    const enc = item.match(/<enclosure\b[^>]*\burl\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const url = enc?.[1] ?? enc?.[2];
    if (!url) continue;
    episodes.push({ title: textOf(item, "title") ?? "(untitled episode)", url: decodeEntities(url) });
    if (episodes.length >= MAX_EPISODES) break;
  }
  const head = items.length ? xml.slice(0, xml.search(/<item[\s>]/i)) : xml;
  return { channel: textOf(head, "title"), episodes };
}
var FEED_HEAD_BYTES = 2 * 1024 * 1024;
async function fetchText(url, feed = false) {
  const r = await request(url, { redirect: "follow" }, feed ? { maxBytes: FEED_HEAD_BYTES, truncate: true } : {});
  if (!r.ok) throw new Error(`Fetch failed (${r.status}) for ${url}`);
  return r.text();
}
function embeddedDirectUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const seg = u.pathname.split("/").filter(Boolean);
  for (let i = seg.length - 2; i >= 0; i--) {
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(seg[i])) {
      return `https://${seg.slice(i).join("/")}${u.search}`;
    }
  }
  return null;
}
async function probe(url, budgetMs = 2500) {
  try {
    const r = await request(url, {
      redirect: "follow",
      headers: { Range: "bytes=0-0", "User-Agent": "Mozilla/5.0" }
    }, { probe: true, timeoutMs: Math.min(2500, budgetMs), budgetMs, retries: 0 });
    try {
      await r.body?.cancel();
    } catch {
    }
    return r.ok ? url : null;
  } catch {
    checkCancelled();
    return null;
  }
}
async function resolveDirect(url) {
  const direct = embeddedDirectUrl(url);
  const deadline = Date.now() + 1e4;
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    if (direct && Date.now() < deadline && await probe(direct, deadline - Date.now())) return direct;
    if (Date.now() < deadline && await probe(url, deadline - Date.now())) return url;
    if (Date.now() >= deadline) break;
    await wait(Math.min(300, deadline - Date.now()));
  }
  return url;
}
async function resolveFeed(target) {
  const t = target.trim();
  if (/^https?:\/\//i.test(t)) return { feedUrl: t, name: null };
  const q = new URLSearchParams({ media: "podcast", limit: "5", term: t });
  const j = JSON.parse(await fetchText(`https://itunes.apple.com/search?${q}`));
  const hit = (j.results ?? []).find((r) => typeof r.feedUrl === "string");
  if (!hit) throw new Error(`No podcast found for "${target}". Try a different name or paste an RSS URL.`);
  return { feedUrl: hit.feedUrl, name: hit.collectionName ?? null };
}
async function playEpisode(feedUrl, name, choose) {
  const { channel, episodes } = parseFeed(await fetchText(feedUrl, true));
  if (episodes.length === 0) throw new Error("The feed has no playable episodes (no audio enclosures).");
  const i = choose(episodes);
  const ep = episodes[i];
  const direct = await resolveDirect(ep.url);
  await playbackEffect(async () => {
    if (now.source === "spotify") {
      try {
        await pause();
      } catch {
      }
    }
    if (now.source === "applemusic") pauseIfRunning();
    await play(direct, now.volume);
  });
  const displayName = name ?? channel ?? feedUrl;
  now.state = "playing";
  now.source = "podcast";
  now.podcastFeed = feedUrl;
  now.podcastName = displayName;
  now.episodeIndex = i;
  now.title = ep.title;
  const pos = `${i + 1}/${episodes.length}`;
  return `> ${displayName} \u2014 ${ep.title} (episode ${pos}, newest first)`;
}
async function playQuery(target) {
  const { feedUrl, name } = await resolveFeed(target);
  return playEpisode(feedUrl, name, () => 0);
}
function requireCurrent() {
  if (now.source !== "podcast" || !now.podcastFeed)
    throw new Error("No podcast is playing. Use podcast_play first.");
  return now.podcastFeed;
}
function locateEpisode(episodes, title, index) {
  let found = -1;
  episodes.forEach((ep, i) => {
    if (title && ep.title === title && (found < 0 || Math.abs(i - index) < Math.abs(found - index))) found = i;
  });
  return found >= 0 ? found : index;
}
async function step(offset) {
  return playEpisode(requireCurrent(), now.podcastName, (episodes) => {
    const i = locateEpisode(episodes, now.title, now.episodeIndex) + offset;
    if (offset > 0 && i >= episodes.length) throw new Error(`Already at the oldest episode (${episodes.length} available).`);
    if (offset < 0 && i < 0) throw new Error("Already at the newest episode.");
    return Math.max(0, Math.min(i, episodes.length - 1));
  });
}
function next3() {
  return step(1);
}
function prev3() {
  return step(-1);
}
function resume3() {
  return step(0);
}

// src/sources/hoer.ts
import { promisify } from "node:util";
import { execFile } from "node:child_process";
var HOME = "https://hoer.live/";
var UA = { "User-Agent": "Mozilla/5.0" };
async function currentVideo() {
  const r = await request(HOME, { headers: UA, redirect: "follow" });
  if (!r.ok) throw new Error(`hoer.live returned ${r.status}.`);
  const html = await r.text();
  const m = html.match(/videoId:\s*['"]([\w-]{6,20})['"]/);
  if (!m) throw new Error("Couldn't find the current show on hoer.live \u2014 the page layout may have changed.");
  const id = m[1];
  let title = null;
  try {
    const o = await request(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
    if (o.ok) title = (await o.json()).title ?? null;
  } catch {
  }
  return { id, title };
}
async function resolveAudioUrl(id) {
  const args = ["-g", "-f", "bestaudio/best"];
  const cookieFile = process.env.HOER_COOKIES_FILE?.trim();
  const browser = process.env.HOER_COOKIES_FROM_BROWSER?.trim();
  if (cookieFile) args.push("--cookies", cookieFile);
  else if (browser) args.push("--cookies-from-browser", browser);
  args.push(`https://www.youtube.com/watch?v=${id}`);
  let out;
  try {
    out = (await promisify(execFile)("yt-dlp", args, { encoding: "utf8", timeout: 3e4, windowsHide: true, signal: operationSignal() })).stdout;
  } catch (e) {
    checkCancelled();
    if (e.code === "ENOENT")
      throw new Error(
        "H\xD6R streams via YouTube, which needs yt-dlp:\n  macOS:   brew install yt-dlp\n  Windows: winget install yt-dlp\n  Linux:   pipx install yt-dlp  (or your package manager)"
      );
    const stderr = String(e.stderr ?? "");
    if (/Could not copy .* cookie database|database is locked/i.test(stderr))
      throw new Error(
        "Couldn't read the browser's cookie database \u2014 it's locked because the browser is running.\nFully quit " + (browser ?? "the browser") + " and retry, or export cookies to a file:\n  HOER_COOKIES_FILE=/path/to/cookies.txt"
      );
    if (/confirm you.?re not a bot|Sign in to confirm/i.test(stderr))
      throw new Error(
        "YouTube blocked this stream with a bot check. Authenticate yt-dlp:\n  HOER_COOKIES_FROM_BROWSER=firefox  (works while open)\n  HOER_COOKIES_FROM_BROWSER=chrome   (must close Chrome first on Windows)\n  HOER_COOKIES_FILE=/path/to/cookies.txt  (exported Netscape cookies \u2014 always works)"
      );
    if (e.killed)
      throw new Error("yt-dlp timed out resolving the H\xD6R stream (slow network, or YouTube is throttling). Try again.");
    throw new Error("yt-dlp couldn't resolve the H\xD6R stream (video may be members-only or region-locked).");
  }
  const url = out.trim().split("\n")[0];
  if (!url?.startsWith("http")) throw new Error("yt-dlp returned no stream URL for the H\xD6R show.");
  return url;
}
async function play3() {
  const { id, title } = await currentVideo();
  const url = await resolveAudioUrl(id);
  await playbackEffect(async () => {
    if (now.source === "spotify") {
      try {
        await pause();
      } catch {
      }
    }
    if (now.source === "applemusic") pauseIfRunning();
    await play(url, now.volume);
  });
  now.state = "playing";
  now.source = "hoer";
  now.title = title ?? "H\xD6R Berlin";
  return `> H\xD6R Berlin \u2014 ${title ?? "current show"}`;
}
async function resume4() {
  return play3();
}

// src/doctor.ts
import { execFileSync as execFileSync4 } from "node:child_process";
import { existsSync as existsSync5 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join8 } from "node:path";
var icon = { ok: "\u2713", warn: "!", fail: "\u2717" };
function onPath(bin) {
  try {
    if (process.platform === "win32") execFileSync4("where", [bin], { stdio: "ignore", windowsHide: true });
    else execFileSync4("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 20 ? { level: "ok", label: "Node.js", detail: `v${process.versions.node}` } : { level: "fail", label: "Node.js", detail: `v${process.versions.node} \u2014 need 20+` };
}
function checkPlayer() {
  const p = playerAvailable();
  return p ? { level: "ok", label: "Audio player", detail: p } : { level: "fail", label: "Audio player", detail: "no mpv/ffplay \u2014 install mpv (brew/winget/apt install mpv)" };
}
function checkYtDlp() {
  return onPath("yt-dlp") ? { level: "ok", label: "yt-dlp", detail: "found (H\xD6R available)" } : { level: "warn", label: "yt-dlp", detail: "not found \u2014 only /hoer needs it (winget/brew/pipx install yt-dlp)" };
}
function checkSpotify() {
  const hasId = !!process.env.SPOTIFY_CLIENT_ID;
  const hasToken = existsSync5(join8(homedir3(), ".pirate-radio", "spotify.json"));
  if (!hasId && !hasToken)
    return { level: "warn", label: "Spotify", detail: "not configured \u2014 set SPOTIFY_CLIENT_ID, then /spotify-login (optional)" };
  if (hasId && !hasToken)
    return { level: "warn", label: "Spotify", detail: "client id set, not logged in \u2014 run /spotify-login" };
  if (!hasId && hasToken)
    return { level: "warn", label: "Spotify", detail: "token cached but SPOTIFY_CLIENT_ID unset \u2014 refresh will fail" };
  return { level: "ok", label: "Spotify", detail: "client id set + logged in" };
}
function checkSession() {
  const anchor = readAnchor();
  if (!anchor) {
    const host = findPiProcess();
    return host ? { level: "ok", label: "Session anchor", detail: `none (raw CLI) \u2014 bound to pi (pid ${host.pid}); music stops when pi exits` } : { level: "warn", label: "Session anchor", detail: "none \u2014 music started now won't auto-stop on session end (run radio_stop)" };
  }
  return anchorAlive(anchor) ? { level: "ok", label: "Session anchor", detail: `live (pid ${anchor.pid})` } : { level: "warn", label: "Session anchor", detail: `stale (pid ${anchor.pid} gone) \u2014 will be cleared on next server start` };
}
function checkPlayers() {
  const n = livePlayerCountUnlocked();
  return { level: "ok", label: "Tracked players", detail: n === 0 ? "none playing" : `${n} live` };
}
async function checkStream() {
  const stations2 = all();
  const first = Object.values(stations2).flat()[0];
  if (!first) return { level: "fail", label: "Stream reachability", detail: "no stations loaded (stations.json missing?)" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6e3);
  try {
    const r = await fetch(first.url, { signal: ac.signal, redirect: "follow" });
    r.body?.cancel().catch(() => {
    });
    return r.ok || r.status === 405 ? { level: "ok", label: "Stream reachability", detail: `${first.name} \u2192 ${r.status}` } : { level: "warn", label: "Stream reachability", detail: `${first.name} \u2192 ${r.status} (may be temporary)` };
  } catch (e) {
    const why = e.name === "AbortError" ? "timed out" : e.message;
    return { level: "warn", label: "Stream reachability", detail: `${first.name} unreachable \u2014 ${why} (check your network)` };
  } finally {
    clearTimeout(timer);
  }
}
async function doctor() {
  const checks = [
    checkNode(),
    checkPlayer(),
    checkYtDlp(),
    checkSpotify(),
    checkSession(),
    checkPlayers(),
    await checkStream()
  ];
  const lines = checks.map((c) => `  ${icon[c.level]} ${c.label}: ${c.detail}`);
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  const summary = fails > 0 ? `${fails} problem(s) block playback \u2014 fix the \u2717 lines above.` : warns > 0 ? `Ready to play. ${warns} optional item(s) noted (!).` : "All systems go.";
  return `pirate-radio doctor (stations: ${hosts().length} hosts)
${lines.join("\n")}

${summary}`;
}

// src/tools.ts
var noArgs = { type: "object", properties: {}, additionalProperties: false };
var tools = [
  {
    name: "radio_list",
    description: "List available built-in radio genres and current playback state.",
    schema: noArgs,
    handler: () => `Genres: ${list()}
${describe()}`
  },
  {
    name: "radio_play",
    // Genre list derived from the station data so it never drifts out of sync.
    description: `Play a built-in genre radio station. Genres: ${genres2().join(", ")}. Compatibility aliases: ${Object.keys(aliases()).join(", ")}.`,
    schema: {
      type: "object",
      properties: {
        genre: { type: "string" },
        resumePaused: { type: "boolean", description: "If playback is paused, resume it instead of starting this genre." }
      },
      required: ["genre"]
    },
    handler: async (a) => {
      if ((a.resumePaused === true || a.resumePaused === "true") && now.state === "paused" && now.source)
        return resumePlayback();
      const st = await playGenre(String(a.genre));
      return `> ${now.genre} \u2014 ${st.name}`;
    }
  },
  {
    name: "radio_next",
    description: "Next station (radio), next track (Spotify/Apple Music), or next-older episode (podcast).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") {
        await playbackEffect(() => skipNext());
        return "Next track.";
      }
      if (now.source === "applemusic") {
        await playbackEffect(() => next());
        return "Next track.";
      }
      if (now.source === "podcast") return next3();
      if (now.source === "hoer") throw new Error("H\xD6R is a single live channel \u2014 nothing to skip to.");
      const st = await next2();
      return `Next: ${now.genre} \u2014 ${st.name}`;
    }
  },
  {
    name: "radio_prev",
    description: "Previous station (radio), previous track (Spotify/Apple Music), or next-newer episode (podcast).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") {
        await playbackEffect(() => skipPrev());
        return "Previous track.";
      }
      if (now.source === "applemusic") {
        await playbackEffect(() => prev());
        return "Previous track.";
      }
      if (now.source === "podcast") return prev3();
      if (now.source === "hoer") throw new Error("H\xD6R is a single live channel \u2014 nothing to skip to.");
      const st = await prev2();
      return `Prev: ${now.genre} \u2014 ${st.name}`;
    }
  },
  {
    name: "radio_pause",
    description: "Pause playback in place via mpv IPC or the remote app; ffplay requires stop instead.",
    schema: noArgs,
    handler: async () => {
      if (now.state === "stopped" && !now.source) {
        await stop();
        return "Stopped.";
      }
      if (!now.source) {
        await stop();
        now.state = "stopped";
        return "Stopped.";
      }
      if (now.source === "spotify") await pause();
      else if (now.source === "applemusic") pause2();
      else if (!await setPaused(true)) throw new Error("No live player to pause. Use radio_resume to restart.");
      now.state = "paused";
      return "|| Paused.";
    }
  },
  {
    name: "radio_resume",
    description: "Resume a live mpv player at its saved position; restart only if the player has exited.",
    schema: noArgs,
    handler: () => resumePlayback()
  },
  {
    name: "radio_stop",
    description: "Stop playback entirely.",
    schema: noArgs,
    handler: async () => {
      await stop();
      let warning = "";
      try {
        if (now.source === "spotify") await pause();
        else if (now.source === "applemusic") stop2();
      } catch (e) {
        warning = ` (${now.source === "spotify" ? "Spotify" : "Music.app"} did not confirm: ${e.message})`;
      }
      now.state = "stopped";
      now.source = null;
      return `[] Stopped.${warning}`;
    }
  },
  {
    name: "radio_now_playing",
    description: "Show what is currently playing.",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") {
        try {
          return `Spotify \u2014 ${await nowPlayingLine()}`;
        } catch {
        }
      }
      if (now.source === "applemusic") {
        try {
          return `Apple Music \u2014 ${nowPlayingLine2()}`;
        } catch {
        }
      }
      return describe();
    }
  },
  {
    name: "radio_volume",
    description: "Set volume 0-100 without restarting mpv; ffplay requires mpv for live volume control.",
    schema: { type: "object", properties: { level: { type: "number", minimum: 0, maximum: 100 } }, required: ["level"] },
    handler: async (a) => {
      const raw = a.level;
      const level = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(level)) throw new Error("Give a volume 0-100, e.g. level=60.");
      now.volume = Math.max(0, Math.min(100, Math.round(level)));
      if (["radio", "podcast", "hoer"].includes(now.source ?? "") && now.state !== "stopped") {
        if (!await setVolume(now.volume))
          return `vol ${now.volume} (applies from the next station/episode \u2014 ffplay can't change volume live; install mpv)`;
      } else if (now.source === "spotify" && now.state === "playing") {
        await setVolume2(now.volume);
      } else if (now.source === "applemusic" && now.state === "playing") {
        setVolume3(now.volume);
      }
      return `vol ${now.volume}`;
    }
  },
  {
    name: "spotify_login",
    description: "Start Spotify OAuth. Returns a URL to open; then paste the redirect URL with spotify_complete_login.",
    schema: noArgs,
    handler: () => `Open this URL and approve. Then copy the redirect URL from the address bar (the page itself won't load) and pass it \u2014 or just its "code" param \u2014 to spotify_complete_login:
${loginUrl()}`
  },
  {
    name: "spotify_complete_login",
    description: "Finish Spotify login by pasting the redirect URL, or just its code parameter.",
    schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    handler: async (a) => {
      await complete(String(a.code));
      return "Spotify linked.";
    }
  },
  {
    name: "spotify_list_playlists",
    description: "List your Spotify playlists (requires login).",
    schema: noArgs,
    handler: () => listPlaylists()
  },
  {
    name: "spotify_play_playlist",
    description: "Play anything on Spotify: a spotify: URI, an open.spotify.com URL, one of your playlists by name, or free text (searches the catalog: track > album > playlist > show). Requires Premium + a Spotify client.",
    schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    handler: async (a) => {
      const wasAppleMusic = now.source === "applemusic";
      const out = await playContext(String(a.target));
      if (wasAppleMusic) await playbackEffect(() => pauseIfRunning());
      return out;
    }
  },
  {
    name: "spotify_search",
    description: `Search the Spotify catalog. Optional type: comma list of track, album, artist, playlist, show, episode (default "track,album,playlist,show").`,
    schema: {
      type: "object",
      properties: { query: { type: "string" }, type: { type: "string" } },
      required: ["query"]
    },
    handler: (a) => search(String(a.query), a.type == null ? void 0 : String(a.type))
  },
  {
    name: "spotify_devices",
    description: "List your online Spotify Connect devices (the active one is marked with >).",
    schema: noArgs,
    handler: () => devices()
  },
  {
    name: "spotify_transfer",
    description: "Move Spotify playback to another device, by name (substring) or device id.",
    schema: { type: "object", properties: { device: { type: "string" } }, required: ["device"] },
    handler: (a) => transfer(String(a.device))
  },
  {
    name: "podcast_play",
    description: "Play a podcast's newest episode via the local player. Give a podcast name (searched on iTunes, no login) or an RSS feed URL. radio_next/radio_prev then step to older/newer episodes.",
    schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    handler: (a) => playQuery(String(a.target))
  },
  {
    name: "hoer_play",
    description: "Play H\xD6R Berlin (hoer.live) \u2014 the live DJ stream when on air, otherwise the latest set. Streams via YouTube, so yt-dlp must be installed.",
    schema: noArgs,
    handler: () => play3()
  },
  {
    name: "music_play",
    description: "Play from your Apple Music library via the local Music.app (macOS only). Matches a playlist name first, then a track name, then an album name.",
    schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    handler: (a) => play2(String(a.target))
  },
  {
    name: "radio_doctor",
    description: "Diagnose the playback environment: audio player, yt-dlp, Spotify config/login, session anchor, tracked players, and stream reachability. Run this first when playback isn't working.",
    schema: noArgs,
    handler: () => doctor()
  }
];
async function resumePlayback() {
  if (["radio", "podcast", "hoer"].includes(now.source ?? "") && await playbackEffect(() => setPaused(false))) {
    now.state = "playing";
    return "> Resumed at the current position.";
  }
  if (now.source === "spotify") await playbackEffect(() => resume());
  else if (now.source === "applemusic") await playbackEffect(() => resume2());
  else if (now.source === "podcast") return resume3();
  else if (now.source === "hoer") return resume4();
  else if (now.source === "radio" && now.genre) await playGenre(now.genre, now.stationIndex);
  else throw new Error("Nothing to resume. Use radio_play, podcast_play, spotify_play_playlist, or music_play.");
  now.state = "playing";
  return "> Resumed.";
}

// src/selfcheck.ts
test("station catalog: exact genres, aliases, and schema version", () => {
  const expected = [
    "jazz",
    "classical",
    "indie",
    "covers",
    "rock",
    "metal",
    "country",
    "pop",
    "ambient",
    "chill",
    "soul",
    "lounge",
    "eighties",
    "world",
    "folk",
    "house",
    "techno",
    "bass",
    "kexp",
    "kcrw",
    "wfmu",
    "nts",
    "wwoz",
    "paradise",
    "public"
  ];
  assert.strictEqual(catalogVersion(), 2);
  assert.deepStrictEqual(genres2(), expected);
  assert.strictEqual(resolveGenre("lofi"), "chill");
  assert.strictEqual(resolveGenre("npr"), "public");
  assert.ok(acceptedGenres().includes("lofi"));
  assert.ok(acceptedGenres().includes("npr"));
});
test("hosts() is non-empty and unique", () => {
  const h = hosts();
  assert.ok(h.length > 0, "hosts() returned empty \u2014 stations.json broken?");
  assert.strictEqual(new Set(h).size, h.length, "hosts() has duplicates");
});
test("all orphan sweep sites require a session-specific marker, never a host", () => {
  const src = join9(dirname4(fileURLToPath3(import.meta.url)), "..", "src");
  for (const file of ["player.ts", "watchdog.ts", "index.ts"]) {
    const body = readFileSync8(join9(src, file), "utf8");
    assert.match(body, /findOrphanPlayers\(playerMarker\(/);
    assert.ok(!/\bhosts\(\)/.test(body), `${file}: cleanup must not match stream hosts`);
  }
});
test("player detect returns a known value", () => {
  const p = playerAvailable();
  assert.ok(p === null || p === "mpv" || p === "ffplay");
});
test("tools registry: every slash command maps to a real tool", () => {
  const toolNames = new Set(tools.map((t) => t.name));
  for (const required of [
    "radio_list",
    "radio_play",
    "radio_next",
    "radio_prev",
    "radio_pause",
    "radio_resume",
    "radio_stop",
    "radio_now_playing",
    "radio_volume",
    "spotify_login",
    "spotify_complete_login",
    "spotify_list_playlists",
    "spotify_play_playlist",
    "spotify_search",
    "spotify_devices",
    "spotify_transfer",
    "podcast_play",
    "music_play",
    "hoer_play",
    "radio_doctor"
  ]) {
    assert.ok(toolNames.has(required), `tool missing: ${required}`);
  }
});
test("command files invoke registered CLI tools", () => {
  const here3 = dirname4(fileURLToPath3(import.meta.url));
  const commandDir = join9(here3, "..", "commands");
  const toolNames = new Set(tools.map((t) => t.name));
  for (const file of readdirSync2(commandDir).filter((f) => f.endsWith(".md"))) {
    const body = readFileSync8(join9(commandDir, file), "utf8").replace(/\r\n/g, "\n");
    const m = body.match(/!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" ([a-z_]+)/) ?? body.match(/```!\nnode "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" ([a-z_]+) --stdin=[a-z]+ <<'PIRATE_RADIO_ARGS'\n\$ARGUMENTS\nPIRATE_RADIO_ARGS\n```/);
    assert.ok(m, `${file}: missing CLI invocation`);
    assert.ok(toolNames.has(m[1]), `${file}: invokes missing tool ${m[1]}`);
    assert.ok(!/!`[^`]*\$ARGUMENTS/.test(body), `${file}: $ARGUMENTS inlined into shell`);
  }
});
test("podcast: parseFeed handles CDATA, entities, quoting, and missing enclosures", () => {
  const feed = `<?xml version="1.0"?><rss><channel>
    <title>My &amp; Show</title>
    <item><title><![CDATA[Ep 2 \u2014 latest]]></title>
      <enclosure url="https://cdn.example.com/ep2.mp3" type="audio/mpeg"/></item>
    <item><title>Announcement only</title></item>
    <item><title>Ep 1 &quot;pilot&quot;</title>
      <enclosure url='https://cdn.example.com/ep1.mp3' type="audio/mpeg"/></item>
  </channel></rss>`;
  const parsed = parseFeed(feed);
  assert.strictEqual(parsed.channel, "My & Show");
  assert.strictEqual(parsed.episodes.length, 2);
  assert.strictEqual(parsed.episodes[0].title, "Ep 2 \u2014 latest");
  assert.strictEqual(parsed.episodes[0].url, "https://cdn.example.com/ep2.mp3");
  assert.strictEqual(parsed.episodes[1].title, 'Ep 1 "pilot"');
  assert.strictEqual(parsed.episodes[1].url, "https://cdn.example.com/ep1.mp3");
});
test("podcast: parseFeed on a feed with no episodes returns []", () => {
  assert.deepStrictEqual(parseFeed("<rss><channel><title>empty</title></channel></rss>").episodes, []);
});
test("podcast: parseFeed ignores an item cut off by feed truncation", () => {
  const head = `<rss><channel><title>Big</title>
    <item><title>New</title><enclosure url="https://cdn.example.com/2.mp3"/></item>
    <item><title>Old</title><enclosure url="https://cdn.exa`;
  const parsed = parseFeed(head);
  assert.strictEqual(parsed.channel, "Big");
  assert.deepStrictEqual(parsed.episodes, [{ title: "New", url: "https://cdn.example.com/2.mp3" }]);
});
test("podcast: parseFeed decodes numeric entities exactly once", () => {
  const parsed = parseFeed(`<rss><channel><title>Caf&#233; &#x26; Co</title>
    <item><title>What&#8217;s new &amp;lt;live&amp;gt;</title>
      <enclosure url="https://cdn.example.com/a.mp3?x=1&amp;y=2"/></item></channel></rss>`);
  assert.strictEqual(parsed.channel, "Caf\xE9 & Co");
  assert.strictEqual(parsed.episodes[0].title, "What\u2019s new &lt;live&gt;");
  assert.strictEqual(parsed.episodes[0].url, "https://cdn.example.com/a.mp3?x=1&y=2");
});
test("podcast: stepping follows the current episode when the feed gains new ones", () => {
  const eps = (...titles) => titles.map((title) => ({ title, url: `https://cdn.example.com/${title}.mp3` }));
  assert.strictEqual(locateEpisode(eps("N", "A", "B", "C"), "B", 1), 2);
  assert.strictEqual(locateEpisode(eps("X", "B", "Y", "B"), "B", 3), 3);
  assert.strictEqual(locateEpisode(eps("A", "B"), "gone", 1), 1);
  assert.strictEqual(locateEpisode(eps("A", "B"), null, 0), 0);
});
test("spotify: authorization code is accepted bare or inside the pasted redirect URL", () => {
  assert.strictEqual(authorizationCode("AQBx-y_z"), "AQBx-y_z");
  assert.strictEqual(authorizationCode("http://127.0.0.1:8888/callback?code=AQBx-y_z&state=1"), "AQBx-y_z");
  assert.strictEqual(authorizationCode("code=AQBx-y_z"), "AQBx-y_z");
  assert.throws(() => authorizationCode("http://127.0.0.1:8888/callback?error=access_denied"), /access_denied/);
});
test("spotify: 403 reports Spotify's reason instead of always blaming Premium", () => {
  assert.match(spotifyErrorMessage(403, JSON.stringify({ error: { status: 403, message: "Player command failed: Premium required", reason: "PREMIUM_REQUIRED" } })), /Premium is required/);
  const restricted = spotifyErrorMessage(403, JSON.stringify({ error: { status: 403, message: "Player command failed: Restriction violated", reason: "UNKNOWN" } }));
  assert.match(restricted, /Restriction violated/);
  assert.doesNotMatch(restricted, /Premium/);
  assert.match(spotifyErrorMessage(500, "<html>oops</html>"), /Spotify API 500: <html>oops/);
});
test("applemusic: escapeAS escapes quotes and backslashes", () => {
  assert.strictEqual(escapeAS(`My "Best" Mix\\2024`), `My \\"Best\\" Mix\\\\2024`);
});
test("podcast: embeddedDirectUrl de-wraps tracking chains", () => {
  assert.strictEqual(
    embeddedDirectUrl("https://tracking.swap.fm/track/xyz/rss.swap.fm/feeds.megaphone.fm/CNE1/traffic.megaphone.fm/CNE2.mp3"),
    "https://traffic.megaphone.fm/CNE2.mp3"
  );
  assert.strictEqual(
    embeddedDirectUrl("https://mgln.ai/e/2/dts.podtrac.com/redirect.mp3/cdn.simplecastaudio.com/ep/audio.mp3?aid=rss&feed=x"),
    "https://cdn.simplecastaudio.com/ep/audio.mp3?aid=rss&feed=x"
  );
  assert.strictEqual(embeddedDirectUrl("https://cdn.example.com/episodes/42.mp3"), null);
});
test("argparse: number coercion only when the schema says number", () => {
  const numSchema = { type: "object", properties: { level: { type: "number" } } };
  assert.deepStrictEqual(parseArgs(["level=50"], numSchema), { level: 50 });
  assert.deepStrictEqual(parseArgs(["level=abc"], numSchema), { level: "abc" });
  const strSchema = { type: "object", properties: { genre: { type: "string" } } };
  assert.deepStrictEqual(parseArgs(["genre=80"], strSchema), { genre: "80" });
});
test("argparse: multi-word values, JSON blobs, and stray barewords", () => {
  const targetSchema = { type: "object", properties: { target: { type: "string" } } };
  assert.deepStrictEqual(
    parseArgs(["target=my", "chill", "list"], targetSchema),
    { target: "my chill list" }
  );
  const strSchema = { type: "object", properties: { genre: { type: "string" } } };
  assert.deepStrictEqual(parseArgs(['{"genre":"jazz"}'], strSchema), { genre: "jazz" });
  assert.deepStrictEqual(parseArgs(["stray", "target=x"], targetSchema), { target: "x" });
});
test("state/tool edge cases: blank volume is rejected; no source describes as stopped", async () => {
  const volume = tools.find((t) => t.name === "radio_volume");
  assert.ok(volume, "radio_volume tool missing");
  await assert.rejects(() => Promise.resolve(volume.handler({})), /Give a volume 0-100/);
  await assert.rejects(() => Promise.resolve(volume.handler({ level: "" })), /Give a volume 0-100/);
  const prev4 = { state: now.state, source: now.source };
  try {
    now.state = "playing";
    now.source = null;
    assert.strictEqual(describe(), "Stopped.");
  } finally {
    now.state = prev4.state;
    now.source = prev4.source;
  }
});
test("version is identical in package.json, plugin.json and the MCP server", () => {
  const root2 = join9(dirname4(fileURLToPath3(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync8(join9(root2, "package.json"), "utf8")).version;
  const plugin = JSON.parse(readFileSync8(join9(root2, ".claude-plugin", "plugin.json"), "utf8")).version;
  const server = readFileSync8(join9(root2, "src", "index.ts"), "utf8").match(/name: "radiohead", version: "([^"]+)"/)?.[1];
  assert.strictEqual(plugin, pkg);
  assert.strictEqual(server, pkg);
});
