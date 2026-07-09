// `pirate-radio doctor` — user-facing diagnostics. Where selfcheck.ts tests our
// own pure functions (developer view), doctor probes the ENVIRONMENT that makes
// playback actually work: the audio player, yt-dlp, Spotify config/tokens, the
// session anchor, and live stream reachability. Every failure this tool can
// name turns a mystery ("why is there no sound?") into one actionable line.
//
// Never throws: each check is independent and returns a line, so one broken
// probe can't hide the rest. Exit code is non-zero iff any FAIL is present.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { playerAvailable } from "./player.js";
import { readAnchor, anchorAlive } from "./state.js";
import { livePlayerCountUnlocked } from "./registry.js";
import { all, hosts } from "./stations.js";

type Level = "ok" | "warn" | "fail";
interface Check { level: Level; label: string; detail: string; }

const icon: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };

// Is `bin` on PATH? Same argv-array, no-shell approach as player.detect() so
// Git-Bash/MSYS never mangles anything.
function onPath(bin: string): boolean {
  try {
    if (process.platform === "win32") execFileSync("where", [bin], { stdio: "ignore", windowsHide: true });
    else execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkNode(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 20
    ? { level: "ok", label: "Node.js", detail: `v${process.versions.node}` }
    : { level: "fail", label: "Node.js", detail: `v${process.versions.node} — need 20+` };
}

function checkPlayer(): Check {
  const p = playerAvailable();
  return p
    ? { level: "ok", label: "Audio player", detail: p }
    : { level: "fail", label: "Audio player", detail: "no mpv/ffplay — install mpv (brew/winget/apt install mpv)" };
}

function checkYtDlp(): Check {
  return onPath("yt-dlp")
    ? { level: "ok", label: "yt-dlp", detail: "found (HÖR available)" }
    : { level: "warn", label: "yt-dlp", detail: "not found — only /hoer needs it (winget/brew/pipx install yt-dlp)" };
}

function checkSpotify(): Check {
  const hasId = !!process.env.SPOTIFY_CLIENT_ID;
  const hasToken = existsSync(join(homedir(), ".pirate-radio", "spotify.json"));
  if (!hasId && !hasToken)
    return { level: "warn", label: "Spotify", detail: "not configured — set SPOTIFY_CLIENT_ID, then /spotify-login (optional)" };
  if (hasId && !hasToken)
    return { level: "warn", label: "Spotify", detail: "client id set, not logged in — run /spotify-login" };
  if (!hasId && hasToken)
    return { level: "warn", label: "Spotify", detail: "token cached but SPOTIFY_CLIENT_ID unset — refresh will fail" };
  return { level: "ok", label: "Spotify", detail: "client id set + logged in" };
}

function checkSession(): Check {
  const anchor = readAnchor();
  if (!anchor) return { level: "warn", label: "Session anchor", detail: "none — music started now won't auto-stop on session end" };
  return anchorAlive(anchor)
    ? { level: "ok", label: "Session anchor", detail: `live (pid ${anchor.pid})` }
    : { level: "warn", label: "Session anchor", detail: `stale (pid ${anchor.pid} gone) — will be cleared on next server start` };
}

function checkPlayers(): Check {
  const n = livePlayerCountUnlocked();
  return { level: "ok", label: "Tracked players", detail: n === 0 ? "none playing" : `${n} live` };
}

// Reachability of a real station stream: headers come back fast even though the
// body is an endless audio stream, so we abort the body once we have a status.
async function checkStream(): Promise<Check> {
  const stations = all();
  const first = Object.values(stations).flat()[0];
  if (!first) return { level: "fail", label: "Stream reachability", detail: "no stations loaded (stations.json missing?)" };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(first.url, { signal: ac.signal, redirect: "follow" });
    r.body?.cancel().catch(() => { /* already closed */ });
    return r.ok || r.status === 405 // some Icecast servers 405 a bare GET but still stream
      ? { level: "ok", label: "Stream reachability", detail: `${first.name} → ${r.status}` }
      : { level: "warn", label: "Stream reachability", detail: `${first.name} → ${r.status} (may be temporary)` };
  } catch (e) {
    const why = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
    return { level: "warn", label: "Stream reachability", detail: `${first.name} unreachable — ${why} (check your network)` };
  } finally {
    clearTimeout(timer);
  }
}

// Runs every check and returns a formatted report. The MCP/CLI handler prints
// this; callers that need the pass/fail signal can re-scan for "✗".
export async function doctor(): Promise<string> {
  const checks: Check[] = [
    checkNode(),
    checkPlayer(),
    checkYtDlp(),
    checkSpotify(),
    checkSession(),
    checkPlayers(),
    await checkStream(),
  ];
  const lines = checks.map((c) => `  ${icon[c.level]} ${c.label}: ${c.detail}`);
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  const summary =
    fails > 0 ? `${fails} problem(s) block playback — fix the ✗ lines above.`
      : warns > 0 ? `Ready to play. ${warns} optional item(s) noted (!).`
        : "All systems go.";
  return `pirate-radio doctor (stations: ${hosts().length} hosts)\n${lines.join("\n")}\n\n${summary}`;
}
