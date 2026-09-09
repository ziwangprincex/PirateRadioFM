import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { managedFiles } from "../install-files.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function source(name, imports, globals = {}) {
  const text = fs.readFileSync(join(root, "src", name), "utf8");
  const { code } = transformSync(text, { loader: "ts", format: "cjs", target: "node20" });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => {
    if (!(id in imports)) throw new Error(`Unexpected import ${id}`);
    return imports[id];
  }, ...globals });
  return module.exports;
}

function fakeProc(kills = []) {
  return source("proc.ts", {
    "node:child_process": { execFileSync: () => { throw new Error("no real processes"); } },
    "node:fs": { readFileSync: () => `101 (player) ${[...Array(19).fill("0"), "new-start"].join(" ")}` },
    "./lifecycle-mode.js": { lifecycleTestMode: false },
  }, { process: { platform: "linux", kill: (pid, signal) => {
    if (signal === 0) return;
    kills.push([pid, signal]);
    throw new Error("fake process exited");
  } } });
}

test("cleanup verifies registry identities before signalling", () => {
  const kills = [];
  const proc = fakeProc(kills);
  proc.killSameProcess(101, "l:old-start");
  assert.equal(kills.length, 0);
  proc.killSameProcess(101, "l:new-start");
  assert.deepEqual(kills, [[101, "SIGTERM"]]);
  const index = fs.readFileSync(join(root, "src/index.ts"), "utf8");
  assert.match(index, /for \(const p of reg\.players\) killSameProcess\(p\.pid, p\.token\)/);
  assert.match(index, /for \(const w of reg\.watchdogs\) killSameProcess\(w\.pid, w\.token\)/);
});

test("orphan discovery accepts only exact OS player names", () => {
  const proc = fakeProc();
  const rows = [
    "101 zsh /bin/zsh -c /opt/bin/mpv https://stream.invalid/live",
    "102 python3 /usr/bin/python3 /tmp/mpv-check.py https://stream.invalid/live",
    "103 mpv /opt/bin/mpv https://stream.invalid/live",
    "104 ffplay /opt/bin/ffplay https://stream.invalid/live",
    "105 mpv-helper /opt/bin/mpv-helper https://stream.invalid/live",
    "106 mpv /opt/bin/mpv https://different.invalid/live",
    "107 mpv /Applications/My Players/mpv https://stream.invalid/live",
    "108 Core Audio /opt/bin/mpv https://stream.invalid/live",
  ].join("\n");
  assert.deepEqual(Array.from(proc.parseUnixPs(rows, (cmd) => cmd.includes("stream.invalid"))), [103, 104, 107]);
});

test("watchdog retains interval on cleanup error and exits only after success", () => {
  let callback, cleared = 0, attempts = 0, exits = 0;
  const loop = source("watchdog-loop.ts", {}, {
    setInterval: (fn) => { callback = fn; return 1; },
    clearInterval: () => { cleared++; },
  });
  loop.startWatchdogLoop(10, () => {
    if (++attempts === 1) throw new Error("lock timeout");
    return attempts === 3;
  }, () => { exits++; });
  callback();
  assert.equal(cleared, 0);
  callback();
  assert.equal(exits, 0);
  callback();
  assert.equal(attempts, 3);
  assert.equal(cleared, 1);
  assert.equal(exits, 1);
});

// Minimal synchronous filesystem used to force the exact stale-observation
// interleaving without scheduling luck, real sleeps, signals or user files.
function lockHarness(platform = "linux") {
  const lock = "/state/players.lock";
  const nodes = new Map([["/", null], ["/state", null]]);
  let beforeUnlink = () => {}, beforeSleep = () => {}, clock = 100_000, uuid = 0;
  const error = (code) => Object.assign(new Error(code), { code });
  const children = (path) => [...nodes.keys()].filter((key) => key.slice(0, key.lastIndexOf("/")) === path && key !== path);
  const io = {
    mkdirSync(path, options) {
      if (nodes.has(path)) { if (options?.recursive) return; throw error("EEXIST"); }
      nodes.set(path, null);
    },
    writeFileSync: (path, value) => nodes.set(path, value),
    readFileSync(path) { if (!nodes.has(path)) throw error("ENOENT"); return nodes.get(path); },
    existsSync: (path) => nodes.has(path),
    readdirSync(path) {
      if (!nodes.has(path)) throw error("ENOENT");
      return children(path).map((key) => key.slice(path.length + 1));
    },
    statSync(path) { if (!nodes.has(path)) throw error("ENOENT"); return { mtimeMs: 0 }; },
    unlinkSync(path) { beforeUnlink(path); if (!nodes.delete(path)) throw error("ENOENT"); },
    rmdirSync(path) {
      if (children(path).length) throw error("ENOTEMPTY");
      if (!nodes.delete(path)) throw error("ENOENT");
    },
    rmSync(path) { for (const key of nodes.keys()) if (key === path || key.startsWith(path + "/")) nodes.delete(key); },
    renameSync(from, to) {
      if (!nodes.has(from)) throw error("ENOENT");
      if (children(to).length) throw error("ENOTEMPTY");
      const moved = [...nodes].filter(([key]) => key === from || key.startsWith(from + "/"));
      for (const [key] of moved) nodes.delete(key);
      for (const [key, value] of moved) nodes.set(to + key.slice(from.length), value);
    },
  };
  const api = source("lock.ts", {
    "node:fs": io,
    "node:path": { dirname, join: (...parts) => parts.join("/") },
    "node:crypto": { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    "./proc.js": { procStartToken: () => "live", sameProcess: (pid) => pid === 201 },
  }, {
    process: { pid: 201, platform }, Date: { now: () => clock },
    Atomics: { wait: () => { beforeSleep(); clock += 50; } }, SharedArrayBuffer, Int32Array,
  });
  return { lock, nodes, io, api, onUnlink: (fn) => { beforeUnlink = fn; }, onSleep: (fn) => { beforeSleep = fn; } };
}

test("stale reclaimer cannot remove a newly published owner's lock (ABA)", () => {
  const h = lockHarness();
  const stale = "holder-00000000-0000-4000-8000-000000000099";
  const fresh = "holder-00000000-0000-4000-8000-000000000098";
  h.nodes.set(h.lock, null);
  h.nodes.set(`${h.lock}/${stale}`, "999\ndead");
  let raced = false, entered = false, checked = false;
  h.onUnlink((path) => {
    if (raced || path !== `${h.lock}/${stale}`) return;
    raced = true;
    h.nodes.delete(path);
    h.nodes.set(`${h.lock}/${fresh}`, "201\nlive");
  });
  h.onSleep(() => {
    if (checked) return;
    checked = true;
    assert.ok(h.nodes.has(`${h.lock}/${fresh}`), "the new live lock must survive stale cleanup");
    assert.equal(entered, false);
    h.nodes.delete(`${h.lock}/${fresh}`);
    h.nodes.delete(h.lock);
  });
  h.api.withCrossProcessLock(h.lock, () => { entered = true; });
  assert.ok(raced && checked && entered);
  assert.equal(h.nodes.has(h.lock), false);
});

test("lock releases on synchronous throw and asynchronous rejection", async () => {
  const h = lockHarness();
  assert.throws(() => h.api.withCrossProcessLock(h.lock, () => { throw new Error("sync"); }), /sync/);
  assert.equal(h.nodes.has(h.lock), false);
  await assert.rejects(h.api.withCrossProcessLock(h.lock, async () => { throw new Error("async"); }), /async/);
  assert.equal(h.nodes.has(h.lock), false);
  assert.equal(h.api.withCrossProcessLock(h.lock, () => 42), 42);
});

test("live lock times out without stealing; legacy dead holder is reclaimed", () => {
  const h = lockHarness();
  h.nodes.set(h.lock, null);
  h.nodes.set(`${h.lock}/holder`, "201\nlive");
  assert.throws(() => h.api.withCrossProcessLock(h.lock, () => assert.fail("must not enter")), /Timed out/);
  assert.equal(h.nodes.get(`${h.lock}/holder`), "201\nlive");
  h.nodes.set(`${h.lock}/holder`, "999\ndead");
  assert.equal(h.api.withCrossProcessLock(h.lock, () => 42), 42);
  assert.equal(h.nodes.has(h.lock), false);
});

function homeFor(t) {
  const base = join(root, ".test-dist");
  fs.mkdirSync(base, { recursive: true });
  const home = fs.mkdtempSync(join(base, "installer-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function install(home, ...args) {
  const r = spawnSync(process.execPath, [join(root, "install.mjs"), ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
function put(path, content) { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, content); }

test("installer preserves unknown prompts and foreign MCP entries", (t) => {
  const home = homeFor(t);
  const prompt = join(home, ".codex/prompts/play.md");
  const cfg = join(home, ".codex/config.toml");
  const toml = '[mcp_servers.radiohead]\ncommand = "other-app"\n';
  put(prompt, "user prompt"); put(cfg, toml);
  const oc = join(home, ".config/opencode/opencode.json");
  put(oc, JSON.stringify({ mcp: { radiohead: { command: ["other-app"] } } }));
  install(home, "codex", "opencode");
  install(home, "codex", "opencode", "--uninstall");
  assert.equal(fs.readFileSync(prompt, "utf8"), "user prompt");
  assert.equal(fs.readFileSync(cfg, "utf8"), toml);
  assert.deepEqual(JSON.parse(fs.readFileSync(oc, "utf8")).mcp.radiohead.command, ["other-app"]);
});

test("edited managed files survive reinstall and uninstall; unchanged files are removed", (t) => {
  const home = homeFor(t);
  install(home, "codex", "opencode", "hermes", "pi");
  const prompt = join(home, ".codex/prompts/play.md");
  const stop = join(home, ".codex/prompts/stop.md");
  const content = fs.readFileSync(prompt, "utf8") + "\nuser customization\n";
  put(prompt, content);
  const extra = join(home, ".pi/agent/skills/radiohead/notes.txt");
  put(extra, "user notes");
  install(home, "codex", "opencode", "hermes", "pi");
  assert.equal(fs.readFileSync(prompt, "utf8"), content);
  install(home, "codex", "opencode", "hermes", "pi", "--uninstall");
  assert.equal(fs.readFileSync(prompt, "utf8"), content);
  assert.equal(fs.existsSync(stop), false);
  assert.equal(fs.readFileSync(extra, "utf8"), "user notes");
  assert.equal(fs.existsSync(join(dirname(extra), "SKILL.md")), false);
  assert.doesNotMatch(fs.readFileSync(join(home, ".codex/config.toml"), "utf8"), /mcp_servers\.radiohead/);
  assert.equal(JSON.parse(fs.readFileSync(join(home, ".config/opencode/opencode.json"), "utf8")).mcp, undefined);
  assert.doesNotMatch(fs.readFileSync(join(home, ".hermes/config.yaml"), "utf8"), /radiohead:/);
});

test("user edits to managed MCP entries survive uninstall", (t) => {
  const home = homeFor(t);
  install(home, "codex", "opencode", "hermes");
  const codex = join(home, ".codex/config.toml");
  const opencode = join(home, ".config/opencode/opencode.json");
  const hermes = join(home, ".hermes/config.yaml");
  put(codex, fs.readFileSync(codex, "utf8").replace("command =", "enabled = false\ncommand ="));
  const json = JSON.parse(fs.readFileSync(opencode, "utf8"));
  json.mcp.radiohead.enabled = false;
  put(opencode, JSON.stringify(json));
  put(hermes, fs.readFileSync(hermes, "utf8").replace("  radiohead:\n", "  radiohead:\n    enabled: false\n"));
  const before = [codex, opencode, hermes].map((path) => fs.readFileSync(path, "utf8"));
  install(home, "codex", "opencode", "hermes", "--uninstall");
  assert.deepEqual([codex, opencode, hermes].map((path) => fs.readFileSync(path, "utf8")), before);
});

test("managed updates create backups and refuse symlinks", (t) => {
  const home = homeFor(t);
  const path = join(home, "prompt.md");
  const managed = managedFiles(home, () => {});
  managed.write(path, "v1");
  managed.write(path, "v2");
  const backupDir = join(home, ".pirate-radio/install-backups");
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(join(backupDir, backups[0]), "utf8"), "v1");
  if (process.platform !== "win32") {
    const link = join(home, "linked.md");
    fs.symlinkSync(path, link);
    assert.throws(() => managed.write(link, "bad"), /non-regular/);
    assert.throws(() => managed.remove(link), /non-regular/);
    assert.equal(fs.readFileSync(path, "utf8"), "v2");
  }
});

test("installer preserves unsupported layouts and Hermes edits without a final newline", (t) => {
  const home = homeFor(t);
  const codex = join(home, ".codex/config.toml");
  const hermes = join(home, ".hermes/config.yaml");
  const toml = `[mcp_servers.radiohead] # custom header\ncommand = "other"\n`;
  const yaml = `mcp_servers: {radiohead: {command: other}}\n`;
  put(codex, toml); put(hermes, yaml);
  install(home, "codex", "hermes");
  assert.equal(fs.readFileSync(codex, "utf8"), toml);
  assert.equal(fs.readFileSync(hermes, "utf8"), yaml);
  fs.unlinkSync(hermes);
  install(home, "hermes");
  const edited = fs.readFileSync(hermes, "utf8") + "    enabled: false";
  put(hermes, edited);
  install(home, "hermes", "--uninstall");
  assert.equal(fs.readFileSync(hermes, "utf8"), edited);
});

test("config edits preserve unrelated TOML tables and YAML sections", (t) => {
  const home = homeFor(t);
  const codex = join(home, ".codex/config.toml");
  const hermes = join(home, ".hermes/config.yaml");
  const toml = `[mcp_servers.other]\ncommand = "other"\n`;
  const yaml = `plugins:\n  radiohead:\n    command: other\n`;
  put(codex, toml); put(hermes, yaml);
  install(home, "codex", "hermes");
  install(home, "codex", "hermes", "--uninstall");
  assert.equal(fs.readFileSync(codex, "utf8"), toml);
  assert.equal(fs.readFileSync(hermes, "utf8"), yaml + "mcp_servers:\n");
});

test("lock retries when its previous owner disappears after a rename collision", () => {
  const h = lockHarness();
  const rename = h.io.renameSync;
  let first = true;
  h.io.renameSync = (from, to) => {
    if (first) {
      first = false;
      throw Object.assign(new Error("just released"), { code: "ENOTEMPTY" });
    }
    return rename(from, to);
  };
  assert.equal(h.api.withCrossProcessLock(h.lock, () => 42), 42);
});

test("lock surfaces real filesystem errors instead of spinning", () => {
  const h = lockHarness();
  h.io.renameSync = () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };
  assert.throws(() => h.api.withCrossProcessLock(h.lock, () => assert.fail()), /permission denied/);
  assert.equal([...h.nodes.keys()].some((path) => path.includes(".claim.")), false);
});

for (const code of ["EPERM", "EACCES"]) {
  test(`Windows ${code} collision retries after the previous lock disappears`, () => {
    const h = lockHarness("win32");
    const rename = h.io.renameSync;
    let attempts = 0;
    h.io.renameSync = (from, to) => {
      if (++attempts === 1) {
        assert.equal(h.nodes.has(to), false, "previous owner already released its lock");
        throw Object.assign(new Error("destination was occupied"), { code });
      }
      return rename(from, to);
    };
    assert.equal(h.api.withCrossProcessLock(h.lock, () => 42), 42);
    assert.equal(attempts, 2);
    assert.equal([...h.nodes.keys()].some((path) => path.includes(".claim.")), false);
  });

  test(`Windows persistent ${code} is bounded and preserves the original error`, () => {
    const h = lockHarness("win32");
    const error = Object.assign(new Error("permission denied"), { code });
    h.io.renameSync = () => { throw error; };
    assert.throws(() => h.api.withCrossProcessLock(h.lock, () => assert.fail("must not enter")), (e) => {
      assert.match(e.message, /Timed out/);
      assert.equal(e.cause, error);
      return true;
    });
    assert.equal([...h.nodes.keys()].some((path) => path.includes(".claim.")), false);
  });
}

test("POSIX permission errors are not treated as contention even with a destination", () => {
  const h = lockHarness("linux");
  h.nodes.set(h.lock, null);
  h.nodes.set(`${h.lock}/holder`, "201\nlive");
  h.io.renameSync = () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };
  assert.throws(() => h.api.withCrossProcessLock(h.lock, () => assert.fail()), /permission denied/);
  assert.equal(h.nodes.get(`${h.lock}/holder`), "201\nlive");
});
