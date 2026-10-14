import { createHash } from "node:crypto";
// Cross-process lifecycle integration tests. Every test uses an isolated HOME
// and only kills Node child processes it spawned itself.
import { test } from "node:test";
import assert from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

// PIRATE_RADIO_DEFAULT_SCOPE pins the default scope like a watchdog inherits
// it: no pi-ancestor scan (a full PowerShell process listing per child on
// Windows, slow enough on CI to push concurrent children past their timeouts).
function isolatedEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PIRATE_RADIO_SESSION: "", PIRATE_RADIO_DEFAULT_SCOPE: "1", HOME: home, USERPROFILE: home, ...extra };
}

function stateDir(home: string): string { return join(home, ".pirate-radio"); }
function makeHome(): string { return mkdtempSync(join(tmpdir(), "pirate-radio-lifecycle-")); }
function removeHome(home: string): void {
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

function child(home: string, args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcess {
  return spawn(process.execPath, [self, ...args], {
    env: isolatedEnv(home, extra), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
}

function runChild(home: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [self, ...args], {
    env: isolatedEnv(home, extra), encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
}

function sleeper(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore", windowsHide: true,
  });
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopChild(proc: ChildProcess): void {
  if (!proc.pid || !alive(proc.pid)) return;
  try { process.kill(proc.pid, "SIGTERM"); } catch { /* already gone */ }
}

async function stopAndWait(proc: ChildProcess, timeoutMs = 4000): Promise<void> {
  if (!proc.pid || !alive(proc.pid)) return;
  stopChild(proc);
  try { await waitFor(() => !alive(proc.pid), timeoutMs); }
  catch {
    try { process.kill(proc.pid, "SIGKILL"); } catch { /* already gone */ }
    await waitFor(() => !alive(proc.pid), 1000).catch(() => { /* best effort */ });
  }
}

async function exitResult(proc: ChildProcess, timeoutMs = 5000): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk) => { stderr += chunk; });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stopChild(proc); reject(new Error("child did not exit")); }, timeoutMs);
    proc.once("exit", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}

async function childMain(): Promise<boolean> {
  const mode = process.argv[2];
  if (!mode) return false;
  if (mode === "registry-add") {
    const registry = await import("./registry.js");
    const pid = Number(process.argv[3]);
    if (process.argv[4] === "watchdog") registry.addWatchdog(pid);
    else registry.addPlayer(pid, "test.invalid");
    return true;
  }
  if (mode === "state-set") {
    const { now, withState } = await import("./state.js");
    const field = process.argv[3] as "genre" | "volume";
    const value = process.argv[4];
    const delay = Number(process.argv[5] ?? 0);
    await withState(async () => {
      if (delay > 0) await sleep(delay);
      if (field === "volume") now.volume = Number(value);
      else now.genre = value;
    });
    return true;
  }
  if (mode === "lock-stress" || mode === "lock-hold") {
    const { withCrossProcessLock } = await import("./lock.js");
    const dir = join(process.env.HOME!, ".pirate-radio");
    const lock = join(dir, "stress.lock");
    if (mode === "lock-hold") {
      await withCrossProcessLock(lock, async () => {
        writeFileSync(join(dir, "ready"), "ready");
        await sleep(60_000);
      });
      return true;
    }
    for (let i = 0; i < 5; i++) {
      await withCrossProcessLock(lock, async () => {
        const guard = join(dir, "critical-section");
        writeFileSync(guard, String(process.pid), { flag: "wx" });
        try {
          const counter = join(dir, "counter");
          const value = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
          await sleep(10);
          writeFileSync(counter, String(value + 1));
        } finally {
          rmSync(guard);
        }
      });
    }
    return true;
  }
  if (mode === "player-stop") {
    const player = await import("./player.js");
    player.stop();
    return true;
  }
  return false;
}

if (!(await childMain())) {

  test("six processes reclaim a legacy stale lock without overlapping critical sections", { concurrency: false }, async () => {
    const home = makeHome();
    const workers: ChildProcess[] = [];
    try {
      const lock = join(stateDir(home), "stress.lock");
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "holder"), "999999997\ndead");
      for (let i = 0; i < 6; i++) workers.push(child(home, ["lock-stress"]));
      const results = await Promise.all(workers.map((p) => exitResult(p, 20_000)));
      for (const result of results) assert.strictEqual(result.code, 0, result.stderr);
      assert.strictEqual(readFileSync(join(stateDir(home), "counter"), "utf8"), "30");
      assert.ok(!existsSync(lock));
    } finally {
      await Promise.all(workers.map((p) => stopAndWait(p)));
      removeHome(home);
    }
  });

  test("a hard-killed lock owner is reclaimed using its unique owner file", { concurrency: false }, async () => {
    const home = makeHome();
    const holder = child(home, ["lock-hold"]);
    try {
      await waitFor(() => existsSync(join(stateDir(home), "ready")), 5000);
      assert.ok(holder.pid);
      process.kill(holder.pid, "SIGKILL");
      await waitFor(() => !alive(holder.pid), 5000);
      const result = runChild(home, ["lock-stress"]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(readFileSync(join(stateDir(home), "counter"), "utf8"), "5");
      assert.ok(!existsSync(join(stateDir(home), "stress.lock")));
    } finally {
      await stopAndWait(holder);
      removeHome(home);
    }
  });

  test("concurrent state writers preserve each other's fields", { concurrency: false }, async () => {
    const home = makeHome();
    try {
      const first = child(home, ["state-set", "genre", "jazz", "250"]);
      await sleep(40);
      const second = child(home, ["state-set", "volume", "37", "0"]);
      const [a, b] = await Promise.all([exitResult(first), exitResult(second)]);
      assert.strictEqual(a.code, 0, a.stderr);
      assert.strictEqual(b.code, 0, b.stderr);
      const state = JSON.parse(readFileSync(join(stateDir(home), "state.json"), "utf8"));
      assert.strictEqual(state.genre, "jazz");
      assert.strictEqual(state.volume, 37);
    } finally {
      removeHome(home);
    }
  });

  test("process identity rejects a live PID with the wrong start token", { concurrency: false }, async () => {
    const home = makeHome();
    const proc = sleeper();
    try {
      assert.ok(proc.pid);
      const result = spawnSync(process.execPath, [join(dirname(self), "processcheck.js"), String(proc.pid), "definitely-not-this-process"], {
        env: isolatedEnv(home), encoding: "utf8", timeout: 10_000, windowsHide: true,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout.trim(), "false");
    } finally {
      await stopAndWait(proc);
      removeHome(home);
    }
  });


  test("server startup cleans a dead session before taking ownership", { concurrency: false }, async () => {
    const home = makeHome();
    const player = sleeper();
    const serverPath = join(dirname(self), "index.js");
    let server: ChildProcess | null = null;
    try {
      assert.ok(player.pid);
      const dir = stateDir(home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "anchor.json"), JSON.stringify({ pid: 999_999_997, token: "dead-session" }));
      writeFileSync(join(dir, "state.json"), JSON.stringify({ state: "playing", source: "radio", genre: "jazz", stationName: "stale", stationIndex: 0, title: null, volume: 80, spotifyVerifier: "stale", podcastFeed: null, podcastName: null, episodeIndex: 0 }));
      const added = runChild(home, ["registry-add", String(player.pid), "player"], {});
      assert.strictEqual(added.status, 0, added.stderr);
      server = spawn(process.execPath, [serverPath], {
        env: isolatedEnv(home, {}),
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      await waitFor(() => !alive(player.pid), 6000);
      await waitFor(() => {
        try { return JSON.parse(readFileSync(join(dir, "anchor.json"), "utf8")).pid === server?.pid; }
        catch { return false; }
      }, 3000);
      const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
      assert.strictEqual(state.state, "stopped");
      assert.strictEqual(state.source, null);
      assert.strictEqual(state.spotifyVerifier, null);
    } finally {
      if (server) await stopAndWait(server);
      await stopAndWait(player);
      removeHome(home);
    }
  });

  test("a second MCP server refuses to replace a live session anchor", { concurrency: false }, async () => {
    const home = makeHome();
    const serverPath = join(dirname(self), "index.js");
    const first = spawn(process.execPath, [serverPath], {
      env: isolatedEnv(home, {}),
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    try {
      await waitFor(() => existsSync(join(stateDir(home), "anchor.json")) && alive(first.pid), 3000);
      const second = spawn(process.execPath, [serverPath], {
        env: isolatedEnv(home, {}),
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      const result = await exitResult(second, 4000);
      assert.strictEqual(result.code, 2, result.stderr);
      assert.match(result.stderr, /another server is already running/);
      assert.ok(alive(first.pid), "the original server must remain alive");
    } finally {
      await stopAndWait(first);
      removeHome(home);
    }
  });

  test("simultaneous server starts elect exactly one owner atomically", { concurrency: false }, async () => {
    const home = makeHome();
    const serverPath = join(dirname(self), "index.js");
    const servers = [0, 1].map(() => spawn(process.execPath, [serverPath], {
      env: isolatedEnv(home), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }));
    try {
      await waitFor(() => servers.some((p) => p.exitCode === 2), 6000);
      assert.equal(servers.filter((p) => alive(p.pid)).length, 1);
      const anchor = JSON.parse(readFileSync(join(stateDir(home), "anchor.json"), "utf8"));
      assert.equal(anchor.pid, servers.find((p) => alive(p.pid))?.pid);
    } finally { await Promise.all(servers.map((p) => stopAndWait(p))); removeHome(home); }
  });

  test("explicit session scopes run concurrently without sharing anchor ownership", { concurrency: false }, async () => {
    const home = makeHome();
    const servers = ["alpha", "beta"].map((id) => spawn(process.execPath, [join(dirname(self), "index.js")], {
      env: isolatedEnv(home, { PIRATE_RADIO_SESSION: id }), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }));
    try {
      for (const id of ["alpha", "beta"]) {
        const scope = createHash("sha256").update(id).digest("hex").slice(0, 24);
        await waitFor(() => existsSync(join(stateDir(home), "sessions", scope, "anchor.json")), 5000);
      }
      await stopAndWait(servers[0]);
      assert.ok(alive(servers[1].pid));
    } finally { await Promise.all(servers.map((p) => stopAndWait(p))); removeHome(home); }
  });

  test("an old watchdog leaves a player alone after a newer session takes the anchor", { concurrency: false }, async () => {
    const home = makeHome();
    const player = sleeper();
    try {
      assert.ok(player.pid);
      const dir = stateDir(home);
      mkdirSync(dir, { recursive: true });
      const oldPid = 999_999_998;
      writeFileSync(join(dir, "anchor.json"), JSON.stringify({ pid: process.pid, token: "new-session" }));
      const added = runChild(home, ["registry-add", String(player.pid), "player"], {});
      assert.strictEqual(added.status, 0, added.stderr);
      const watchdog = spawn(process.execPath, [join(dirname(self), "watchdog.js"), String(oldPid), "old-session", String(player.pid)], {
        env: isolatedEnv(home, {}),
        stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      });
      const result = await exitResult(watchdog, 3000);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(alive(player.pid), "old watchdog must not kill a newer session's player registry");
      const anchor = JSON.parse(readFileSync(join(dir, "anchor.json"), "utf8"));
      assert.strictEqual(anchor.token, "new-session");
    } finally {
      await stopAndWait(player);
      removeHome(home);
    }
  });

  test("orphan sweep stops an unregistered marked player but preserves unmarked same-host playback", { concurrency: false }, async () => {
    const home = makeHome();
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const fakePlayer = join(bin, process.platform === "win32" ? "mpv.exe" : "mpv");
    // Linux matches the kernel comm. Node 24 renames its main thread to
    // "MainThread", so a copied node binary no longer reads as "mpv" there; a
    // script keeps its own basename as comm. Elsewhere a node copy is fine.
    const linux = process.platform === "linux";
    if (linux) writeFileSync(fakePlayer, "#!/bin/sh\nwhile :; do sleep 1; done\n");
    else copyFileSync(process.execPath, fakePlayer);
    if (process.platform !== "win32") chmodSync(fakePlayer, 0o755);
    const idle = linux ? [] : ["-e", "setInterval(() => {}, 1000)"];
    const uniqueHost = `lifecycle-${process.pid}-${Date.now()}.invalid`;
    mkdirSync(stateDir(home), { recursive: true });
    writeFileSync(join(stateDir(home), "dynamic-hosts.json"), JSON.stringify([uniqueHost]));
    const marker = `pirate-radio-${createHash("sha256").update(`${stateDir(home)}:legacy`).digest("hex").slice(0, 24)}`;
    const manual = spawn(fakePlayer, [...idle, `https://${uniqueHost}/test`], { stdio: "ignore", windowsHide: true });
    const orphan = spawn(fakePlayer, [...idle, `https://${uniqueHost}/test`, `--title=${marker}`], {
      stdio: "ignore", windowsHide: true,
    });
    try {
      assert.ok(orphan.pid);
      await waitFor(() => alive(orphan.pid), 1000);
      const stopped = runChild(home, ["player-stop"]);
      assert.strictEqual(stopped.status, 0, stopped.stderr);
      await waitFor(() => !alive(orphan.pid), 5000);
      assert.ok(alive(manual.pid), "unmarked player at the same host must survive");
    } finally {
      await stopAndWait(orphan);
      await stopAndWait(manual);
      removeHome(home);
    }
  });

  test("watchdog stops a registered player when its session anchor is dead", { concurrency: false }, async () => {
    const home = makeHome();
    const player = sleeper();
    try {
      assert.ok(player.pid);
      const dir = stateDir(home);
      mkdirSync(dir, { recursive: true });
      const deadAnchorPid = 999_999_999;
      writeFileSync(join(dir, "anchor.json"), JSON.stringify({ pid: deadAnchorPid, token: "dead" }));
      const added = runChild(home, ["registry-add", String(player.pid), "player"], {});
      assert.strictEqual(added.status, 0, added.stderr);

      const watchdogPath = join(dirname(self), "watchdog.js");
      const watchdog = spawn(process.execPath, [watchdogPath, String(deadAnchorPid), "dead", String(player.pid)], {
        env: isolatedEnv(home, {}),
        stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      });
      const result = await exitResult(watchdog, 6000);
      assert.strictEqual(result.code, 0, result.stderr);
      await waitFor(() => !alive(player.pid), 3000);
      assert.ok(!existsSync(join(dir, "anchor.json")), "watchdog should clear its dead anchor");
    } finally {
      await stopAndWait(player);
      removeHome(home);
    }
  });

  test("pid-mode watchdog stops its player when the host process dies", { concurrency: false }, async () => {
    const home = makeHome();
    const player = sleeper();
    const host = sleeper(); // stands in for the pi process
    try {
      assert.ok(player.pid && host.pid);
      const dir = stateDir(home);
      mkdirSync(dir, { recursive: true });
      // pid mode must never touch anchor.json — a concurrent MCP session may
      // own it, so write a foreign one and require it to survive.
      writeFileSync(join(dir, "anchor.json"), JSON.stringify({ pid: 999_999_996, token: "not-ours" }));
      const watchdog = spawn(process.execPath, [join(dirname(self), "watchdog.js"), String(host.pid), "", String(player.pid), "pid"], {
        env: isolatedEnv(home, {}),
        stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      });
      // Host alive → the player must survive several poll cycles.
      await sleep(400);
      assert.ok(alive(player.pid), "player must keep playing while the host lives");
      stopChild(host); // the "pi" process exits
      const result = await exitResult(watchdog, 6000);
      assert.strictEqual(result.code, 0, result.stderr);
      await waitFor(() => !alive(player.pid), 3000);
      const anchor = JSON.parse(readFileSync(join(dir, "anchor.json"), "utf8"));
      assert.strictEqual(anchor.pid, 999_999_996, "pid-mode watchdog must not clear anchor.json");
    } finally {
      await stopAndWait(player);
      await stopAndWait(host);
      removeHome(home);
    }
  });

  test("pid-mode watchdog leaves another session's player alone", { concurrency: false }, async () => {
    const home = makeHome();
    const other = sleeper(); // a player owned by a different pi session
    const host = sleeper();
    const mine = sleeper();
    try {
      assert.ok(other.pid && host.pid && mine.pid);
      const dir = stateDir(home);
      mkdirSync(dir, { recursive: true });
      const added = runChild(home, ["registry-add", String(other.pid), "player"], {});
      assert.strictEqual(added.status, 0, added.stderr);
      const watchdog = spawn(process.execPath, [join(dirname(self), "watchdog.js"), String(host.pid), "", String(mine.pid), "pid"], {
        env: isolatedEnv(home, {}),
        stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      });
      await sleep(300);
      stopChild(host);
      const result = await exitResult(watchdog, 6000);
      assert.strictEqual(result.code, 0, result.stderr);
      await waitFor(() => !alive(mine.pid), 3000);
      assert.ok(alive(other.pid), "pid-mode watchdog must not kill players it doesn't own");
    } finally {
      await stopAndWait(other);
      await stopAndWait(host);
      await stopAndWait(mine);
      removeHome(home);
    }
  });
}
