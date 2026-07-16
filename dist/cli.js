#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/player.ts
import { spawn, execFileSync as execFileSync2 } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname3, join as join6 } from "node:path";

// src/state.ts
import { readFileSync as readFileSync4, writeFileSync as writeFileSync3, renameSync as renameSync2, mkdirSync as mkdirSync3, existsSync as existsSync2, unlinkSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";

// src/proc.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
function procStartToken(pid) {
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
        windowsHide: true
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
        { encoding: "utf8", timeout: 8e3, windowsHide: true }
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
function findOrphanPlayers(hosts2) {
  if (hosts2.length === 0) return [];
  const wanted = hosts2.map((h) => h.toLowerCase());
  const matches = (cmd) => {
    const c = cmd.toLowerCase();
    return wanted.some((h) => c.includes(h));
  };
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
    const out = execFileSync("ps", ["-eo", "pid=,args="], {
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
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(" ");
    if (sp === -1) continue;
    const pid = Number(trimmed.slice(0, sp));
    const cmd = trimmed.slice(sp + 1);
    if (!/(^|\/)(mpv|ffplay)\b/.test(cmd)) continue;
    if (Number.isInteger(pid) && pid > 0 && matches(cmd)) pids.push(pid);
  }
  return pids;
}

// src/registry.ts
import {
  readFileSync as readFileSync3,
  writeFileSync as writeFileSync2,
  renameSync,
  mkdirSync as mkdirSync2,
  existsSync
} from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// src/lock.ts
import { mkdirSync, readFileSync as readFileSync2, writeFileSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
var LOCK_STALE_MS = 15e3;
var LOCK_WAIT_MS = 3e4;
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function statMtime(p) {
  return statSync(p).mtimeMs;
}
function withCrossProcessLock(lockPath2, fn) {
  mkdirSync(dirname(lockPath2), { recursive: true });
  const holderFile = join(lockPath2, "holder");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (; ; ) {
    try {
      mkdirSync(lockPath2);
      break;
    } catch {
      let broke = false;
      let holderKnownAlive = false;
      let missingHolder = false;
      try {
        const holderPid = Number(readFileSync2(holderFile, "utf8").trim());
        if (pidAlive(holderPid)) holderKnownAlive = true;
        else broke = true;
      } catch {
        missingHolder = true;
      }
      if (!broke && missingHolder && !holderKnownAlive) {
        try {
          const age = Date.now() - statMtime(lockPath2);
          if (age > LOCK_STALE_MS) broke = true;
        } catch {
        }
      }
      if (broke) {
        forceRelease(lockPath2);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock: ${lockPath2}`);
      }
      sleep(50);
    }
  }
  try {
    writeFileSync(holderFile, String(process.pid));
    const result = fn();
    if (result && typeof result.then === "function") {
      return (async () => {
        try {
          return await result;
        } finally {
          release(lockPath2);
        }
      })();
    }
    release(lockPath2);
    return result;
  } catch (e) {
    release(lockPath2);
    throw e;
  }
}
function release(lockPath2) {
  try {
    rmSync(join(lockPath2, "holder"), { force: true });
  } catch {
  }
  try {
    rmdirSync(lockPath2);
  } catch {
  }
}
function forceRelease(lockPath2) {
  try {
    rmSync(lockPath2, { recursive: true, force: true });
  } catch {
  }
}

// src/registry.ts
var dir = join2(homedir(), ".pirate-radio");
var registryPath = join2(dir, "players.json");
var lockPath = join2(dir, "players.lock");
function readRaw() {
  if (!existsSync(registryPath)) return { players: [], watchdogs: [] };
  try {
    const r = JSON.parse(readFileSync3(registryPath, "utf8"));
    return { players: r.players ?? [], watchdogs: r.watchdogs ?? [] };
  } catch {
    return { players: [], watchdogs: [] };
  }
}
function writeRaw(r) {
  mkdirSync2(dir, { recursive: true });
  const tmp = `${registryPath}.${process.pid}.tmp`;
  writeFileSync2(tmp, JSON.stringify(r, null, 2));
  renameSync(tmp, registryPath);
}
function withLock(fn) {
  return withCrossProcessLock(lockPath, () => {
    const reg = readRaw();
    const result = fn(reg);
    writeRaw(reg);
    return result;
  });
}
function addPlayer(pid, host) {
  const token = procStartToken(pid);
  withLock((r) => {
    r.players = prune(r.players);
    r.players.push({ pid, token, host });
  });
}
function addWatchdog(pid) {
  const token = procStartToken(pid);
  withLock((r) => {
    r.watchdogs = prune(r.watchdogs);
    r.watchdogs.push({ pid, token });
  });
}
function livePlayerCountUnlocked() {
  try {
    return prune(readRaw().players).length;
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
function drainPlayers() {
  return withLock((r) => {
    const live = prune(r.players);
    r.players = [];
    return live;
  });
}
function drainWatchdogs() {
  return withLock((r) => {
    const live = prune(r.watchdogs);
    r.watchdogs = [];
    return live;
  });
}
function prune(list2) {
  return list2.filter((e) => sameProcess(e.pid, e.token));
}

// src/state.ts
var stateDir = join3(homedir2(), ".pirate-radio");
var statePath = join3(stateDir, "state.json");
var stateLockPath = join3(stateDir, "state.lock");
var anchorPath = join3(stateDir, "anchor.json");
var defaults = {
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
var now = { ...defaults };
var inProcTail = Promise.resolve();
async function withState(fn) {
  const run = () => withCrossProcessLock(stateLockPath, async () => {
    loadStateUnlocked();
    const out = await fn();
    saveStateUnlocked();
    return out;
  });
  const p = inProcTail.then(run, run);
  inProcTail = p.catch(() => {
  });
  return p;
}
var fieldType = {
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
  if (!existsSync2(statePath)) {
    Object.assign(now, defaults);
    return;
  }
  let raw = {};
  try {
    raw = JSON.parse(readFileSync4(statePath, "utf8"));
  } catch {
    process.stderr.write("radiohead: state.json unreadable, resetting to defaults\n");
    Object.assign(now, defaults);
    return;
  }
  const target = now;
  for (const key of Object.keys(defaults)) {
    const got = raw[key];
    if (got === null && defaults[key] === null || typeof got === fieldType[key]) target[key] = got;
    else target[key] = defaults[key];
  }
}
function saveStateUnlocked() {
  mkdirSync3(stateDir, { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync3(tmp, JSON.stringify(now, null, 2));
  renameSync2(tmp, statePath);
}
function saveState() {
  withCrossProcessLock(stateLockPath, () => saveStateUnlocked());
}
function readAnchor() {
  if (!existsSync2(anchorPath)) return null;
  try {
    const a = JSON.parse(readFileSync4(anchorPath, "utf8"));
    if (typeof a.pid === "number" && a.pid > 0) {
      return { pid: a.pid, token: a.token ?? null };
    }
  } catch {
  }
  return null;
}
function anchorAlive(anchor) {
  if (!anchor) return false;
  return sameProcess(anchor.pid, anchor.token);
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

// src/stations.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname as dirname2, join as join4 } from "node:path";
var here = dirname2(fileURLToPath(import.meta.url));
var stations = {};
try {
  stations = JSON.parse(readFileSync5(join4(here, "..", "data", "stations.json"), "utf8"));
} catch (e) {
  process.stderr.write(`radiohead: failed to load stations.json \u2014 ${e.message}
`);
}
function all() {
  return stations;
}
function genres() {
  return Object.keys(stations);
}
var hostCache = null;
function hosts() {
  if (hostCache) return hostCache;
  const set = /* @__PURE__ */ new Set();
  for (const list2 of Object.values(stations)) {
    for (const st of list2) {
      try {
        set.add(new URL(st.url).host.toLowerCase());
      } catch {
      }
    }
  }
  hostCache = [...set];
  return hostCache;
}

// src/dynhosts.ts
import { readFileSync as readFileSync6, writeFileSync as writeFileSync4, renameSync as renameSync3, mkdirSync as mkdirSync4, existsSync as existsSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join5 } from "node:path";
var dir2 = join5(homedir3(), ".pirate-radio");
var path = join5(dir2, "dynamic-hosts.json");
var CAP = 20;
function dynamicHosts() {
  if (!existsSync3(path)) return [];
  try {
    const arr = JSON.parse(readFileSync6(path, "utf8"));
    return Array.isArray(arr) ? arr.filter((h) => typeof h === "string") : [];
  } catch {
    return [];
  }
}
function rememberHost(host) {
  const h = host.toLowerCase();
  if (!h) return;
  try {
    const next4 = [h, ...dynamicHosts().filter((x) => x !== h)].slice(0, CAP);
    mkdirSync4(dir2, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync4(tmp, JSON.stringify(next4, null, 2));
    renameSync3(tmp, path);
  } catch {
  }
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
function stop() {
  for (const p of drainPlayers()) killPid(p.pid);
  for (const w of drainWatchdogs()) killPid(w.pid);
  sweepOrphans();
}
function sweepOrphans() {
  for (const pid of findOrphanPlayers([...hosts(), ...dynamicHosts()])) killPid(pid);
}
var here2 = dirname3(fileURLToPath2(import.meta.url));
function play(url, volume) {
  const player = detect();
  if (!player) throw new Error(installHint());
  stop();
  const args = player === "mpv" ? ["--no-video", "--really-quiet", `--volume=${volume}`, url] : ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", String(Math.round(volume / 100 * 256)), url];
  const child = spawn(player, args, { stdio: "ignore", detached: true, windowsHide: true });
  child.unref();
  const pid = child.pid;
  if (pid) {
    let host;
    try {
      host = new URL(url).host;
    } catch {
    }
    addPlayer(pid, host);
    child.on("error", () => removePlayer(pid));
    child.on("exit", () => removePlayer(pid));
    spawnWatchdog(pid);
  }
}
function spawnWatchdog(playerPid) {
  const anchor = readAnchor();
  if (!anchor || !anchorAlive(anchor)) return;
  const wd = spawn(
    process.execPath,
    [
      join6(here2, "watchdog.js"),
      String(anchor.pid),
      anchor.token ?? "",
      String(playerPid)
    ],
    { stdio: "ignore", detached: true, windowsHide: true }
  );
  wd.unref();
  const pid = wd.pid;
  if (pid) {
    addWatchdog(pid);
    wd.on("error", () => removeWatchdog(pid));
    wd.on("exit", () => removeWatchdog(pid));
  }
}

// src/sources/spotify.ts
import { readFileSync as readFileSync7, writeFileSync as writeFileSync5, mkdirSync as mkdirSync5, existsSync as existsSync4 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join7 } from "node:path";
import { createHash, randomBytes } from "node:crypto";
var API = "https://api.spotify.com/v1";
var AUTH = "https://accounts.spotify.com";
var REDIRECT = "http://127.0.0.1:8888/callback";
var SCOPES = "user-read-playback-state user-modify-playback-state playlist-read-private";
var cfgDir = join7(homedir4(), ".pirate-radio");
var tokenPath = join7(cfgDir, "spotify.json");
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
    return JSON.parse(readFileSync7(tokenPath, "utf8"));
  } catch {
    return null;
  }
}
function saveTokens(t) {
  mkdirSync5(cfgDir, { recursive: true });
  writeFileSync5(tokenPath, JSON.stringify(t, null, 2), { mode: 384 });
}
function loginUrl() {
  const v = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(v).digest());
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
async function complete(code) {
  const v = now.spotifyVerifier;
  if (!v) throw new Error("Call spotify_login first to start the flow.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId(),
    code_verifier: v
  });
  const r = await fetch(`${AUTH}/api/token`, {
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
var refreshInFlight = null;
async function accessToken() {
  const t = loadTokens();
  if (!t) throw new Error("Not logged in to Spotify. Run spotify_login.");
  if (Date.now() < t.expires_at - 3e4) return t.access_token;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: clientId()
      });
      const r = await fetch(`${AUTH}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (!r.ok) throw new Error(`Token refresh failed: ${await r.text()}`);
      const j = await r.json();
      if (!j.access_token) throw new Error("Token refresh returned no access token \u2014 run spotify_login again.");
      const ttl = Number(j.expires_in) || 3600;
      const next4 = { access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: Date.now() + ttl * 1e3 };
      saveTokens(next4);
      return next4.access_token;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
async function api(path2, init) {
  const tok = await accessToken();
  const r = await fetch(`${API}${path2}`, {
    ...init,
    headers: { ...init?.headers ?? {}, Authorization: `Bearer ${tok}` }
  });
  if (r.status === 404)
    throw statusError(404, "No active Spotify device found. Open the Spotify app (Premium required) and play something once, then retry \u2014 or use spotify_devices.");
  if (r.status === 403)
    throw statusError(403, "Spotify refused the command. Premium is required for playback control.");
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw statusError(r.status, `Spotify API ${r.status}: ${body.slice(0, 200) || r.statusText}`);
  }
  return r;
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
  await playWithRecovery(playBody(uri));
  stop();
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
    const { execFileSync: execFileSync6 } = await import("node:child_process");
    execFileSync6("open", ["-a", "Spotify"], { stdio: "ignore", timeout: 8e3 });
  } catch {
    return null;
  }
  for (let i = 0; i < 6; i++) {
    await new Promise((res) => setTimeout(res, 2e3));
    try {
      const ds = await deviceList();
      const d = ds.find((x) => x.type.toLowerCase() === "computer") ?? ds[0];
      if (d) return d.id;
    } catch {
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
async function setVolume(percent) {
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
  stop();
  if (now.source === "spotify") {
    try {
      await pause();
    } catch {
    }
  }
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
  let title = target;
  try {
    title = nowPlayingLine2();
  } catch {
  }
  now.state = "playing";
  now.source = "applemusic";
  now.title = title;
  return `> Apple Music (${played}): ${title}`;
}
function pauseIfRunning() {
  if (process.platform !== "darwin") return;
  try {
    osa(`if application "Music" is running then tell application "Music" to pause`);
  } catch {
  }
}
function pause2() {
  assertMac();
  osa(`tell application "Music" to pause`);
}
function resume2() {
  assertMac();
  osa(`tell application "Music" to play`);
}
function stop2() {
  assertMac();
  osa(`tell application "Music" to stop`);
}
function next() {
  assertMac();
  osa(`tell application "Music" to next track`);
}
function prev() {
  assertMac();
  osa(`tell application "Music" to previous track`);
}
function setVolume2(percent) {
  assertMac();
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  osa(`tell application "Music" to set sound volume to ${p}`);
}
function nowPlayingLine2() {
  assertMac();
  return osa(`tell application "Music" to (get name of current track) & " \u2014 " & (get artist of current track)`);
}

// src/sources/radio.ts
var stations2 = all();
function genres2() {
  return genres();
}
function list() {
  return genres2().map((g) => `${g} (${stations2[g].length} station${stations2[g].length > 1 ? "s" : ""})`).join(", ");
}
function normalize(genre) {
  const g = genre.trim().toLowerCase();
  return genres2().includes(g) ? g : null;
}
async function playGenre(genre, index = 0) {
  const g = normalize(genre);
  if (!g) throw new Error(`Unknown genre "${genre}". Available: ${genres2().join(", ")}`);
  if (now.source === "spotify") {
    try {
      await pause();
    } catch {
    }
  }
  if (now.source === "applemusic") pauseIfRunning();
  const len = stations2[g].length;
  const i = (Math.trunc(index) % len + len) % len;
  const st = stations2[g][i];
  play(st.url, now.volume);
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
  const len = stations2[now.genre].length;
  return playGenre(now.genre, (now.stationIndex - 1 + len) % len);
}

// src/sources/podcast.ts
var MAX_EPISODES = 50;
function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'");
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
async function fetchText(url) {
  const r = await fetch(url, { redirect: "follow" });
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
async function probe(url) {
  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: { Range: "bytes=0-0", "User-Agent": "Mozilla/5.0" }
    });
    try {
      await r.body?.cancel();
    } catch {
    }
    return r.ok ? url : null;
  } catch {
    return null;
  }
}
async function resolveDirect(url) {
  const direct = embeddedDirectUrl(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (direct && await probe(direct)) return direct;
    if (await probe(url)) return url;
    await new Promise((res) => setTimeout(res, 300));
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
async function playIndex(feedUrl, name, index) {
  const { channel, episodes } = parseFeed(await fetchText(feedUrl));
  if (episodes.length === 0) throw new Error("The feed has no playable episodes (no audio enclosures).");
  const i = Math.max(0, Math.min(index, episodes.length - 1));
  const ep = episodes[i];
  if (now.source === "spotify") {
    try {
      await pause();
    } catch {
    }
  }
  if (now.source === "applemusic") pauseIfRunning();
  const direct = await resolveDirect(ep.url);
  try {
    rememberHost(new URL(direct).host);
  } catch {
  }
  play(direct, now.volume);
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
  return playIndex(feedUrl, name, 0);
}
function requireCurrent() {
  if (now.source !== "podcast" || !now.podcastFeed)
    throw new Error("No podcast is playing. Use podcast_play first.");
  return now.podcastFeed;
}
async function next3() {
  return playIndex(requireCurrent(), now.podcastName, now.episodeIndex + 1);
}
async function prev3() {
  if (now.episodeIndex <= 0) throw new Error("Already at the newest episode.");
  return playIndex(requireCurrent(), now.podcastName, now.episodeIndex - 1);
}
async function resume3() {
  return playIndex(requireCurrent(), now.podcastName, now.episodeIndex);
}

// src/sources/hoer.ts
import { execFileSync as execFileSync4 } from "node:child_process";
var HOME = "https://hoer.live/";
var UA = { "User-Agent": "Mozilla/5.0" };
async function currentVideo() {
  const r = await fetch(HOME, { headers: UA, redirect: "follow" });
  if (!r.ok) throw new Error(`hoer.live returned ${r.status}.`);
  const html = await r.text();
  const m = html.match(/videoId:\s*['"]([\w-]{6,20})['"]/);
  if (!m) throw new Error("Couldn't find the current show on hoer.live \u2014 the page layout may have changed.");
  const id = m[1];
  let title = null;
  try {
    const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
    if (o.ok) title = (await o.json()).title ?? null;
  } catch {
  }
  return { id, title };
}
function resolveAudioUrl(id) {
  const args = ["-g", "-f", "bestaudio/best"];
  const cookieFile = process.env.HOER_COOKIES_FILE?.trim();
  const browser = process.env.HOER_COOKIES_FROM_BROWSER?.trim();
  if (cookieFile) args.push("--cookies", cookieFile);
  else if (browser) args.push("--cookies-from-browser", browser);
  args.push(`https://www.youtube.com/watch?v=${id}`);
  let out;
  try {
    out = execFileSync4("yt-dlp", args, { encoding: "utf8", timeout: 6e4, windowsHide: true });
  } catch (e) {
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
    throw new Error("yt-dlp couldn't resolve the H\xD6R stream (video may be members-only or region-locked).");
  }
  const url = out.trim().split("\n")[0];
  if (!url?.startsWith("http")) throw new Error("yt-dlp returned no stream URL for the H\xD6R show.");
  return url;
}
async function play3() {
  const { id, title } = await currentVideo();
  const url = resolveAudioUrl(id);
  if (now.source === "spotify") {
    try {
      await pause();
    } catch {
    }
  }
  if (now.source === "applemusic") pauseIfRunning();
  try {
    rememberHost(new URL(url).host);
  } catch {
  }
  play(url, now.volume);
  now.state = "playing";
  now.source = "hoer";
  now.title = title ?? "H\xD6R Berlin";
  return `> H\xD6R Berlin \u2014 ${title ?? "current show"}`;
}
async function resume4() {
  return play3();
}

// src/doctor.ts
import { execFileSync as execFileSync5 } from "node:child_process";
import { existsSync as existsSync5 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join8 } from "node:path";
var icon = { ok: "\u2713", warn: "!", fail: "\u2717" };
function onPath(bin) {
  try {
    if (process.platform === "win32") execFileSync5("where", [bin], { stdio: "ignore", windowsHide: true });
    else execFileSync5("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
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
  const hasToken = existsSync5(join8(homedir5(), ".pirate-radio", "spotify.json"));
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
  if (!anchor) return { level: "warn", label: "Session anchor", detail: "none \u2014 music started now won't auto-stop on session end" };
  return anchorAlive(anchor) ? { level: "ok", label: "Session anchor", detail: `live (pid ${anchor.pid})` } : { level: "warn", label: "Session anchor", detail: `stale (pid ${anchor.pid} gone) \u2014 will be cleared on next server start` };
}
function checkPlayers() {
  const n = livePlayerCountUnlocked();
  return { level: "ok", label: "Tracked players", detail: n === 0 ? "none playing" : `${n} live` };
}
async function checkStream() {
  const stations3 = all();
  const first = Object.values(stations3).flat()[0];
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
    description: `Play a built-in genre radio station. Genres: ${genres2().join(", ")}.`,
    schema: { type: "object", properties: { genre: { type: "string" } }, required: ["genre"] },
    handler: async (a) => {
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
        await skipNext();
        return "Next track.";
      }
      if (now.source === "applemusic") {
        next();
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
        await skipPrev();
        return "Previous track.";
      }
      if (now.source === "applemusic") {
        prev();
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
    description: "Pause playback (radio/podcast: stops the stream; Spotify/Apple Music: pauses the app).",
    schema: noArgs,
    handler: async () => {
      if (now.state === "stopped") {
        now.state = "stopped";
        now.source = null;
        return "Stopped.";
      }
      if (!now.source) {
        stop();
        now.state = "stopped";
        return "Stopped.";
      }
      if (now.source === "spotify") {
        try {
          await pause();
        } catch {
        }
      } else if (now.source === "applemusic") {
        try {
          pause2();
        } catch {
        }
      } else stop();
      now.state = "paused";
      return "|| Paused.";
    }
  },
  {
    name: "radio_resume",
    description: "Resume playback (a paused podcast restarts its episode from the top).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") await resume();
      else if (now.source === "applemusic") resume2();
      else if (now.source === "podcast") return resume3();
      else if (now.source === "hoer") return resume4();
      else if (now.source === "radio" && now.genre) await playGenre(now.genre, now.stationIndex);
      else throw new Error("Nothing to resume. Use radio_play, podcast_play, spotify_play_playlist, or music_play.");
      now.state = "playing";
      return "> Resumed.";
    }
  },
  {
    name: "radio_stop",
    description: "Stop playback entirely.",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") {
        try {
          await pause();
        } catch {
        }
      } else if (now.source === "applemusic") {
        try {
          stop2();
        } catch {
        }
      } else stop();
      now.state = "stopped";
      now.source = null;
      return "[] Stopped.";
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
    description: "Set volume 0-100 (applies to radio; restarts the current stream).",
    schema: { type: "object", properties: { level: { type: "number", minimum: 0, maximum: 100 } }, required: ["level"] },
    handler: async (a) => {
      const raw = a.level;
      const level = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(level)) throw new Error("Give a volume 0-100, e.g. level=60.");
      now.volume = Math.max(0, Math.min(100, Math.round(level)));
      if (now.source === "radio" && now.state === "playing" && now.genre)
        await playGenre(now.genre, now.stationIndex);
      else if (now.source === "podcast" && now.state === "playing")
        await resume3();
      else if (now.source === "hoer" && now.state === "playing")
        await resume4();
      else if (now.source === "spotify" && now.state === "playing") {
        try {
          await setVolume(now.volume);
        } catch {
        }
      } else if (now.source === "applemusic" && now.state === "playing") {
        try {
          setVolume2(now.volume);
        } catch {
        }
      }
      return `vol ${now.volume}`;
    }
  },
  {
    name: "spotify_login",
    description: "Start Spotify OAuth. Returns a URL to open; then paste the code with spotify_complete_login.",
    schema: noArgs,
    handler: () => `Open this URL, approve, then copy the "code" query param from the redirect and call spotify_complete_login:
${loginUrl()}`
  },
  {
    name: "spotify_complete_login",
    description: "Finish Spotify login by pasting the authorization code from the redirect URL.",
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
      if (wasAppleMusic) pauseIfRunning();
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

// src/cli.ts
async function main() {
  const [, , toolName, ...rest] = process.argv;
  if (!toolName) {
    console.error("Usage: cli.js <tool-name> [json-args]");
    console.error("Available tools: " + tools.map((t) => t.name).join(", "));
    process.exit(1);
  }
  if (toolName === "doctor" || toolName === "radio_doctor") {
    const report = await doctor();
    process.stdout.write(report + "\n");
    process.exit(report.includes("\u2717") ? 1 : 0);
  }
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    console.error(`Unknown tool: ${toolName}`);
    console.error("Available: " + tools.map((t) => t.name).join(", "));
    process.exit(1);
  }
  let args;
  try {
    args = parseArgs(rest, tool.schema);
  } catch {
    console.error(`Error: could not parse arguments: ${rest.join(" ")}`);
    process.exit(1);
  }
  try {
    const out = await withState(() => tool.handler(args));
    process.stdout.write(out + "\n");
  } catch (e) {
    try {
      saveState();
    } catch {
    }
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
}
main();
