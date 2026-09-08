import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { createServer as socketServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request, withBudget } from "./http.js";
import { mpvCommand } from "./ipc.js";

const home = mkdtempSync(join(tmpdir(), "pr-optimization-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PIRATE_RADIO_SESSION = "optimization-tests";
// Dynamic imports ensure state paths are computed only after HOME is isolated.
const { withState, playbackEffect, now, loadState } = await import("./state.js");
const { bindSession, dataDir } = await import("./session.js");
const { addPlayer, livePlayers, drainAll } = await import("./registry.js");
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withHttp(fn: (url: string, hits: Record<string, number>) => Promise<void>): Promise<void> {
  const hits: Record<string, number> = {};
  const server = httpServer((req, res) => {
    const path = req.url!;
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === "/stall") { res.writeHead(200); res.write("partial"); return; }
    if (path === "/retry" && hits[path] === 1) { res.writeHead(503); res.end(); return; }
    if (path === "/rate") { res.writeHead(429, { "Retry-After": "120" }); res.end(); return; }
    if (path === "/write") { res.writeHead(503); res.end(); return; }
    if (path === "/large") { res.end("x".repeat(1024)); return; }
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`, hits); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("HTTP: timeout covers stalled response bodies, not just headers", async () => {
  await withHttp(async (url) => {
    const start = Date.now();
    await assert.rejects(request(`${url}/stall`, {}, { timeoutMs: 100, retries: 0 }));
    assert.ok(Date.now() - start < 1500);
  });
});
test("HTTP: bounded GET retry, no automatic replay of writes, Retry-After budget", async () => {
  await withHttp(async (url, hits) => {
    assert.deepEqual(await (await request(`${url}/retry`)).json(), { ok: true });
    assert.equal(hits["/retry"], 2);
    assert.equal((await request(`${url}/write`, { method: "POST" })).status, 503);
    assert.equal(hits["/write"], 1);
    await assert.rejects(request(`${url}/rate`, {}, { budgetMs: 500 }), /budget/);
    assert.equal(hits["/rate"], 1);
    await assert.rejects(request(`${url}/large`, {}, { maxBytes: 100, retries: 0 }), /size limit/);
  });
});
test("HTTP: caller cancellation and total operation budget abort pending reads", async () => {
  await withHttp(async (url) => {
    const ac = new AbortController();
    const pending = request(`${url}/stall`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(pending);
    await assert.rejects(withBudget(() => request(`${url}/stall`), undefined, 80));
  });
});

async function withIpc(fn: (path: string, commands: unknown[][]) => Promise<void>): Promise<void> {
  const path = process.platform === "win32" ? `\\\\.\\pipe\\pr-test-${randomUUID()}` : join(home, "mpv.sock");
  const commands: unknown[][] = [];
  const server = socketServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const message = JSON.parse(buffer.trim());
      commands.push(message.command);
      if (message.command[0] === "stall") return;
      if (message.command[0] === "disconnect") { socket.destroy(); return; }
      socket.write(JSON.stringify({ event: "property-change", data: 4 }) + "\n");
      const reply = JSON.stringify({ request_id: message.request_id, error: message.command[0] === "fail" ? "invalid parameter" : "success", data: true });
      socket.write(reply.slice(0, 5));
      socket.write(reply.slice(5) + "\n");
    });
  });
  server.listen(path);
  await once(server, "listening");
  try { await fn(path, commands); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
test("IPC: pause, resume and volume use acknowledged commands without restarting", async () => {
  await withIpc(async (path, commands) => {
    for (const command of [["set_property", "pause", true], ["set_property", "pause", false], ["set_property", "volume", 37]]) {
      assert.equal(await mpvCommand(path, command), true);
    }
    assert.equal(commands.length, 3);
    assert.deepEqual(commands[2], ["set_property", "volume", 37]);
  });
});
test("IPC: timeout, disconnect, error replies and cancellation are surfaced", async () => {
  await withIpc(async (path) => {
    await assert.rejects(mpvCommand(path, ["stall"], 50), /timed out/);
    await assert.rejects(mpvCommand(path, ["disconnect"]), /disconnected/);
    await assert.rejects(mpvCommand(path, ["fail"]), /invalid parameter/);
    const ac = new AbortController();
    const pending = mpvCommand(path, ["stall"], 1500, ac.signal);
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(pending, /cancelled/);
  });
});

test("state: slow preparation does not lock out a newer command; stale effect rejected", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let acted = false;
  const slow = withState(async () => {
    ready();
    await sleep(150);
    await playbackEffect(() => { acted = true; now.genre = "stale"; });
  }, true);
  const rejection = assert.rejects(slow, /superseded/);
  await started;
  await withState(() => playbackEffect(() => { now.genre = "new"; }), true);
  await rejection;
  assert.equal(acted, false);
  loadState();
  assert.equal(now.genre, "new");
});
test("state: effects remain serialized through commit and next command refreshes state", async () => {
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const first = withState(() => playbackEffect(async () => {
    ready();
    await sleep(100);
    now.genre = "committed";
  }), true);
  await started;
  let observed = "";
  const second = withState(() => playbackEffect(() => { observed = now.genre!; now.volume = 37; }), true);
  await Promise.all([first, second]);
  assert.equal(observed, "committed");
  loadState();
  assert.equal(now.volume, 37);
});
test("state: independent fields merge, same-field conflicts fail, failed drafts do not persist", async () => {
  await Promise.all([
    withState(async () => { await sleep(50); now.title = "merged"; }),
    withState(() => { now.volume = 42; }),
  ]);
  const slow = withState(async () => { await sleep(50); now.title = "loser"; });
  const rejection = assert.rejects(slow, /Concurrent state/);
  await withState(() => { now.title = "winner"; });
  await rejection;
  await assert.rejects(withState(() => { now.volume = 99; throw new Error("failed"); }), /failed/);
  loadState();
  assert.equal(now.title, "winner");
  assert.equal(now.volume, 42);
});
test("registry: draining one session preserves another session's process", () => {
  bindSession("one"); addPlayer(process.pid, "same.invalid");
  bindSession("two"); addPlayer(process.pid, "same.invalid");
  assert.equal(drainAll("one").players.length, 1);
  assert.equal(livePlayers("two").length, 1);
  assert.equal(livePlayers("one").length, 0);
  drainAll("two");
  bindSession("legacy");
  assert.ok(dataDir().includes("sessions"));
});

test("real mpv: pause/resume/volume retain PID and media position (null audio output)", async (t) => {
  if (spawnSync("mpv", ["--version"], { stdio: "ignore", timeout: 3000 }).status !== 0) { t.skip("mpv is not installed"); return; }
  const path = process.platform === "win32" ? `\\\\.\\pipe\\pr-real-${randomUUID()}` : join(home, "real.sock");
  const wav = join(home, "silence.wav");
  const bytes = 8000 * 2 * 20;
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + bytes, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(bytes, 40);
  writeFileSync(wav, Buffer.concat([header, Buffer.alloc(bytes)]));
  const mpv = spawn("mpv", ["--no-config", "--no-video", "--ao=null", "--pause", "--keep-open=yes", `--input-ipc-server=${path}`, wav], { stdio: "ignore", windowsHide: true });
  mpv.on("error", () => {});
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await mpvCommand(path, ["get_property", "duration"], 300); break; }
      catch (e) { if (Date.now() > deadline) throw e; await sleep(50); }
    }
    assert.ok(mpv.pid);
    addPlayer(mpv.pid, "local-test", { ipc: path, player: "mpv" });
    await withState(() => { now.source = "podcast"; now.state = "paused"; });
    await mpvCommand(path, ["seek", 5, "absolute+exact"]);
    const before = Number(await mpvCommand(path, ["get_property", "time-pos"]));
    const { runTool } = await import("./tools.js");
    await runTool("radio_volume", { level: 37 });
    assert.equal(await mpvCommand(path, ["get_property", "volume"]), 37);
    await runTool("radio_resume");
    await sleep(150);
    await runTool("radio_pause");
    assert.equal(await mpvCommand(path, ["get_property", "pause"]), true);
    assert.equal(await mpvCommand(path, ["get_property", "pid"]), mpv.pid);
    assert.ok(Number(await mpvCommand(path, ["get_property", "time-pos"])) >= before);
  } finally {
    drainAll();
    if (mpv.exitCode === null && mpv.signalCode === null) {
      const exited = once(mpv, "exit"); mpv.kill(); await exited;
    }
  }
});

test("ffplay: unsupported controls preserve the player and persisted state", async () => {
  const { runTool } = await import("./tools.js");
  await withState(() => { now.source = "podcast"; now.state = "playing"; now.volume = 42; });
  addPlayer(process.pid, "local-test", { player: "ffplay" });
  try {
    await assert.rejects(runTool("radio_pause"), /requires mpv/);
    await assert.rejects(runTool("radio_volume", { level: 33 }), /requires mpv/);
    loadState();
    assert.equal(now.state, "playing");
    assert.equal(now.volume, 42);
    assert.equal(livePlayers().length, 1);
  } finally { drainAll(); }
});

test("state: failed effects release locks and session retirement rejects stale requests", async () => {
  await assert.rejects(withState(() => playbackEffect(() => { throw new Error("effect failed"); }), true), /effect failed/);
  await withState(() => playbackEffect(() => { now.volume = 41; }), true);
  const { writeAnchor, clearAnchor } = await import("./session.js");
  const anchor = writeAnchor(process.pid);
  try {
    await assert.rejects(withState(async () => {
      clearAnchor(anchor);
      await playbackEffect(() => assert.fail("retired session must not act"));
    }, true), /superseded/);
  } finally { clearAnchor(anchor); bindSession("legacy"); }
});
