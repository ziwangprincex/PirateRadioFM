// Apple Music source (macOS only): drives the local Music.app via osascript.
// No developer token, no MusicKit — AppleScript can play anything already in
// the user's library (playlists, downloaded/added Apple Music content) and
// gives full transport control. It CANNOT search the Apple Music catalog;
// that's a MusicKit-web-only capability, useless from a CLI.
// First run triggers macOS's one-time Automation permission prompt.
import { execFileSync } from "node:child_process";
import { now } from "../state.js";
import { stop as stopLocal } from "../player.js";
import * as spotify from "./spotify.js";

function assertMac(): void {
  if (process.platform !== "darwin")
    throw new Error("Apple Music control requires macOS (it drives the local Music.app via AppleScript).");
}

// Escape for embedding inside an AppleScript double-quoted string literal.
export function escapeAS(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function osa(script: string): string {
  return execFileSync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  }).trim();
}

// Play something from the user's Music library. Resolution order: playlist
// name → track name → album name (all case-insensitive `contains` matches).
// `library playlist 1` is the whole library by class reference — the literal
// playlist named "Library" is locale-dependent, so never match it by name.
export async function play(target: string): Promise<string> {
  assertMac();
  const t = escapeAS(target.trim());
  if (!t) throw new Error("Give me a playlist, song, or album name from your Music library.");
  // Silence the other sources first (best effort): local mpv/ffplay always;
  // Spotify only if it was the active source, since pause() needs login+device.
  stopLocal();
  if (now.source === "spotify") {
    try { await spotify.pause(); } catch { /* best effort */ }
  }
  const attempts: Array<{ script: string; kind: string }> = [
    { script: `tell application "Music" to play playlist "${t}"`, kind: "playlist" },
    { script: `tell application "Music" to play (first track of library playlist 1 whose name contains "${t}")`, kind: "track" },
    { script: `tell application "Music" to play (first track of library playlist 1 whose album contains "${t}")`, kind: "album" },
  ];
  let played: string | null = null;
  for (const a of attempts) {
    try {
      osa(a.script);
      played = a.kind;
      break;
    } catch {
      /* not found under this kind — try the next */
    }
  }
  if (!played)
    throw new Error(
      `Nothing in your Music library matches "${target}". AppleScript can only play ` +
        `what's already in the library — add it in Music.app first.`,
    );
  // current track may not be queryable in the instant after `play` — fall back
  // to what the user asked for rather than failing the whole call.
  let title = target;
  try { title = nowPlayingLine(); } catch { /* keep the requested name */ }
  now.state = "playing";
  now.source = "applemusic";
  now.title = title;
  return `> Apple Music (${played}): ${title}`;
}

// Pause Music.app WITHOUT launching it if it isn't running — a bare
// `tell application "Music" to pause` would boot the app just to pause it.
export function pauseIfRunning(): void {
  if (process.platform !== "darwin") return;
  try {
    osa(ifRunning("pause"));
  } catch {
    /* best effort */
  }
}

// Every transport command goes through this guard. A bare `tell application
// "Music" to ...` LAUNCHES Music.app when it isn't running — verified: the tell
// itself is the launch trigger, not the verb. Since now.source persists across
// CLI invocations, a user who played Apple Music and then quit the app would
// get it re-launched by a later /stop or /pause; `resume` was worst, since
// `to play` boots the app AND starts playing.
function ifRunning(verb: string): string {
  return `if application "Music" is running then tell application "Music" to ${verb}`;
}

export function pause(): void { assertMac(); osa(ifRunning("pause")); }
export function stop(): void { assertMac(); osa(ifRunning("stop")); }
export function next(): void { assertMac(); osa(ifRunning("next track")); }
export function prev(): void { assertMac(); osa(ifRunning("previous track")); }
export function setVolume(percent: number): void {
  assertMac();
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  osa(ifRunning(`set sound volume to ${p}`));
}

// resume() is the one command that SHOULD launch Music.app: the user explicitly
// asked to hear the Apple Music they were playing, and refusing because they
// quit the app would just be a silent no-op.
export function resume(): void { assertMac(); osa(`tell application "Music" to play`); }

// "Song — Artist" of the current track, straight from the app. Throws when
// Music.app isn't running rather than launching it just to answer a read-only
// question — both callers already catch and fall back to the recorded title.
export function nowPlayingLine(): string {
  assertMac();
  const out = osa(
    `if application "Music" is running then ` +
      `tell application "Music" to (get name of current track) & " — " & (get artist of current track)`,
  );
  if (!out) throw new Error("Music.app isn't running.");
  return out;
}
