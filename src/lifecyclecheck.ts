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

function isolatedEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, ...extra };
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
  if (mode === "player-stop") {
    const player = await import("./player.js");
    player.stop();
    return true;
  }
  return false;
}

if (!(await childMain())) {

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

  test("orphan sweep stops an unregistered player pointed at a bundled stream host", { concurrency: false }, async () => {
    const home = makeHome();
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const fakePlayer = join(bin, process.platform === "win32" ? "mpv.exe" : "mpv");
    copyFileSync(process.execPath, fakePlayer);
    if (process.platform !== "win32") chmodSync(fakePlayer, 0o755);
    const uniqueHost = `lifecycle-${process.pid}-${Date.now()}.invalid`;
    mkdirSync(stateDir(home), { recursive: true });
    writeFileSync(join(stateDir(home), "dynamic-hosts.json"), JSON.stringify([uniqueHost]));
    const orphan = spawn(fakePlayer, ["-e", "setInterval(() => {}, 1000)", `https://${uniqueHost}/test`], {
      stdio: "ignore", windowsHide: true,
    });
    try {
      assert.ok(orphan.pid);
      await waitFor(() => alive(orphan.pid), 1000);
      const stopped = runChild(home, ["player-stop"]);
      assert.strictEqual(stopped.status, 0, stopped.stderr);
      await waitFor(() => !alive(orphan.pid), 5000);
    } finally {
      await stopAndWait(orphan);
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
}
