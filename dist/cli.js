#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/player.ts
import { spawn, execFileSync as execFileSync2 } from "node:child_process";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname3, join as join5 } from "node:path";

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
      try {
        const holderPid = Number(readFileSync2(holderFile, "utf8").trim());
        if (!pidAlive(holderPid)) broke = true;
      } catch {
      }
      if (!broke) {
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
        forceRelease(lockPath2);
        continue;
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
  spotifyVerifier: null
};
var now = { ...defaults };
async function withState(fn) {
  return withCrossProcessLock(stateLockPath, async () => {
    loadStateUnlocked();
    const out = await fn();
    saveStateUnlocked();
    return out;
  });
}
var fieldType = {
  state: "string",
  source: "string",
  genre: "string",
  stationName: "string",
  stationIndex: "number",
  title: "string",
  volume: "number",
  spotifyVerifier: "string"
};
function loadStateUnlocked() {
  if (!existsSync2(statePath)) return;
  let raw = {};
  try {
    raw = JSON.parse(readFileSync4(statePath, "utf8"));
  } catch {
    process.stderr.write("pirate-radio: state.json unreadable, resetting to defaults\n");
    Object.assign(now, defaults);
    return;
  }
  const target = now;
  for (const key of Object.keys(defaults)) {
    const got = raw[key];
    if (got === null || typeof got === fieldType[key]) target[key] = got;
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
  if (now.state === "stopped") return "Stopped.";
  if (now.source === "radio" && now.state === "playing" && livePlayerCountUnlocked() === 0) {
    return "Stopped (player exited unexpectedly).";
  }
  const what = now.source === "radio" ? `${now.genre} radio \u2014 ${now.stationName}` : `Spotify \u2014 ${now.title ?? "(unknown)"}`;
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
  process.stderr.write(`pirate-radio: failed to load stations.json \u2014 ${e.message}
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
function installHint() {
  return "No audio player found. Install mpv (recommended) or ffmpeg:\n  macOS:   brew install mpv\n  Windows: winget install mpv   (or scoop install mpv)\n  Linux:   sudo apt install mpv  (or your package manager)";
}
function stop() {
  for (const p of drainPlayers()) killPid(p.pid);
  for (const w of drainWatchdogs()) killPid(w.pid);
  sweepOrphans();
}
function sweepOrphans() {
  for (const pid of findOrphanPlayers(hosts())) killPid(pid);
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
      join5(here2, "watchdog.js"),
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
import { readFileSync as readFileSync6, writeFileSync as writeFileSync4, mkdirSync as mkdirSync4, existsSync as existsSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join6 } from "node:path";
import { createHash, randomBytes } from "node:crypto";
var API = "https://api.spotify.com/v1";
var AUTH = "https://accounts.spotify.com";
var REDIRECT = "http://127.0.0.1:8888/callback";
var SCOPES = "user-read-playback-state user-modify-playback-state playlist-read-private";
var cfgDir = join6(homedir3(), ".pirate-radio");
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
  if (!existsSync3(tokenPath)) return null;
  try {
    return JSON.parse(readFileSync6(tokenPath, "utf8"));
  } catch {
    return null;
  }
}
function saveTokens(t) {
  mkdirSync4(cfgDir, { recursive: true });
  writeFileSync4(tokenPath, JSON.stringify(t, null, 2), { mode: 384 });
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
      const ttl = Number(j.expires_in) || 3600;
      const next2 = { access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: Date.now() + ttl * 1e3 };
      saveTokens(next2);
      return next2.access_token;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
async function api(path, init) {
  const tok = await accessToken();
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...init?.headers ?? {}, Authorization: `Bearer ${tok}` }
  });
  if (r.status === 404)
    throw new Error("No active Spotify device found. Open the Spotify app (Premium required) and play something once, then retry.");
  if (r.status === 403)
    throw new Error("Spotify refused the command. Premium is required for playback control.");
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Spotify API ${r.status}: ${body.slice(0, 200) || r.statusText}`);
  }
  return r;
}
async function listPlaylists() {
  const r = await api("/me/playlists?limit=20");
  const j = await r.json();
  const items = (j.items ?? []).map((p) => `\u2022 ${p.name}  [${p.uri}]`);
  return items.length ? items.join("\n") : "No playlists found.";
}
async function playContext(uriOrName) {
  let uri = uriOrName;
  let displayName = uriOrName;
  if (!uri.startsWith("spotify:")) {
    const r = await api("/me/playlists?limit=50");
    const j = await r.json();
    const hit = (j.items ?? []).find((p) => p.name.toLowerCase() === uriOrName.toLowerCase());
    if (!hit) throw new Error(`No playlist named "${uriOrName}". Use spotify_list_playlists.`);
    uri = hit.uri;
    displayName = hit.name;
  }
  await api("/me/player/play", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context_uri: uri })
  });
  stop();
  now.state = "playing";
  now.source = "spotify";
  now.title = displayName;
  return `Playing ${displayName} on your Spotify device.`;
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
  const st = stations2[g][index % stations2[g].length];
  play(st.url, now.volume);
  now.state = "playing";
  now.source = "radio";
  now.genre = g;
  now.stationName = st.name;
  now.stationIndex = index % stations2[g].length;
  return st;
}
async function next() {
  if (now.source !== "radio" || !now.genre)
    throw new Error("No radio station is playing.");
  return playGenre(now.genre, now.stationIndex + 1);
}
async function prev() {
  if (now.source !== "radio" || !now.genre)
    throw new Error("No radio station is playing.");
  const len = stations2[now.genre].length;
  return playGenre(now.genre, (now.stationIndex - 1 + len) % len);
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
    description: "Switch to the next station (radio) or next track (Spotify).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") {
        await skipNext();
        return "Next track.";
      }
      const st = await next();
      return `Next: ${now.genre} \u2014 ${st.name}`;
    }
  },
  {
    name: "radio_prev",
    description: "Switch to the previous station (radio) or previous track (Spotify).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") {
        await skipPrev();
        return "Previous track.";
      }
      const st = await prev();
      return `Prev: ${now.genre} \u2014 ${st.name}`;
    }
  },
  {
    name: "radio_pause",
    description: "Pause playback (radio: stops the stream; Spotify: pauses the device).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") {
        try {
          await pause();
        } catch {
        }
      } else stop();
      now.state = "paused";
      return "|| Paused.";
    }
  },
  {
    name: "radio_resume",
    description: "Resume playback.",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") await resume();
      else if (now.source === "radio" && now.genre) await playGenre(now.genre, now.stationIndex);
      else throw new Error("Nothing to resume. Use radio_play or spotify_play_playlist.");
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
    handler: () => describe()
  },
  {
    name: "radio_volume",
    description: "Set volume 0-100 (applies to radio; restarts the current stream).",
    schema: { type: "object", properties: { level: { type: "number", minimum: 0, maximum: 100 } }, required: ["level"] },
    handler: async (a) => {
      now.volume = Math.max(0, Math.min(100, Math.round(Number(a.level))));
      if (now.source === "radio" && now.state === "playing" && now.genre)
        await playGenre(now.genre, now.stationIndex);
      else if (now.source === "spotify" && now.state === "playing") {
        try {
          await setVolume(now.volume);
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
    description: "Play a Spotify playlist/podcast by name or uri. Requires Premium + a running Spotify client.",
    schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    handler: async (a) => playContext(String(a.target))
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
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    console.error(`Unknown tool: ${toolName}`);
    console.error("Available: " + tools.map((t) => t.name).join(", "));
    process.exit(1);
  }
  const args = parseArgs(rest, tool.schema);
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
