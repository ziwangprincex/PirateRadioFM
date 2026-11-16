import { withBudget } from "./http.js";
// Tool definitions + handlers. Registered on the MCP server in index.ts.
import * as radio from "./sources/radio.js";
import * as spotify from "./sources/spotify.js";
import * as podcast from "./sources/podcast.js";
import * as applemusic from "./sources/applemusic.js";
import * as hoer from "./sources/hoer.js";
import * as player from "./player.js";
import { now, describe, playbackEffect, withState } from "./state.js";
import { doctor } from "./doctor.js";
import { aliases } from "./stations.js";

type Handler = (args: any) => Promise<string> | string;
interface Tool { name: string; description: string; schema: any; handler: Handler; }

const noArgs = { type: "object", properties: {}, additionalProperties: false };

export const tools: Tool[] = [
  {
    name: "radio_list",
    description: "List available built-in radio genres and current playback state.",
    schema: noArgs,
    handler: () => `Genres: ${radio.list()}\n${describe()}`,
  },
  {
    name: "radio_play",
    // Genre list derived from the station data so it never drifts out of sync.
    description: `Play a built-in genre radio station. Genres: ${radio.genres().join(", ")}. Compatibility aliases: ${Object.keys(aliases()).join(", ")}.`,
    schema: {
      type: "object",
      properties: {
        genre: { type: "string" },
        resumePaused: { type: "boolean", description: "If playback is paused, resume it instead of starting this genre." },
      },
      required: ["genre"],
    },
    handler: async (a) => {
      // /play means "resume if paused". Slash commands execute before the model
      // reads the prompt, so that choice has to be made here, not in prose.
      if ((a.resumePaused === true || a.resumePaused === "true") && now.state === "paused" && now.source)
        return resumePlayback();
      const st = await radio.playGenre(String(a.genre));
      return `> ${now.genre} — ${st.name}`;
    },
  },
  {
    name: "radio_next",
    description: "Next station (radio), next track (Spotify/Apple Music), or next-older episode (podcast).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") { await playbackEffect(() => spotify.skipNext()); return "Next track."; }
      if (now.source === "applemusic") { await playbackEffect(() => applemusic.next()); return "Next track."; }
      if (now.source === "podcast") return podcast.next();
      if (now.source === "hoer") throw new Error("HÖR is a single live channel — nothing to skip to.");
      const st = await radio.next();
      return `Next: ${now.genre} — ${st.name}`;
    },
  },
  {
    name: "radio_prev",
    description: "Previous station (radio), previous track (Spotify/Apple Music), or next-newer episode (podcast).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") { await playbackEffect(() => spotify.skipPrev()); return "Previous track."; }
      if (now.source === "applemusic") { await playbackEffect(() => applemusic.prev()); return "Previous track."; }
      if (now.source === "podcast") return podcast.prev();
      if (now.source === "hoer") throw new Error("HÖR is a single live channel — nothing to skip to.");
      const st = await radio.prev();
      return `Prev: ${now.genre} — ${st.name}`;
    },
  },
  {
    name: "radio_pause",
    description: "Pause playback in place via mpv IPC or the remote app; ffplay requires stop instead.",
    schema: noArgs,
    handler: async () => {
      if (now.state === "stopped" && !now.source) {
        // Defensive: kill any orphaned player even if state says stopped (can
        // happen after a state.json corruption/reset while mpv is alive).
        await player.stop();
        return "Stopped.";
      }
      if (!now.source) {
        await player.stop();
        now.state = "stopped";
        return "Stopped.";
      }
      // Persist paused state only after the player acknowledged the command.
      if (now.source === "spotify") await spotify.pause();
      else if (now.source === "applemusic") applemusic.pause();
      else if (!(await player.setPaused(true))) throw new Error("No live player to pause. Use radio_resume to restart.");
      now.state = "paused";
      return "|| Paused.";
    },
  },
  {
    name: "radio_resume",
    description: "Resume a live mpv player at its saved position; restart only if the player has exited.",
    schema: noArgs,
    handler: () => resumePlayback(),
  },
  {
    name: "radio_stop",
    description: "Stop playback entirely.",
    schema: noArgs,
    handler: async () => {
      // The user's intent wins over remote success: local players always die and
      // the state always says stopped. A failed Spotify/Music.app call (offline,
      // expired token, no device) is reported, not allowed to roll the stop back.
      await player.stop();
      let warning = "";
      try {
        if (now.source === "spotify") await spotify.pause();
        else if (now.source === "applemusic") applemusic.stop();
      } catch (e) {
        warning = ` (${now.source === "spotify" ? "Spotify" : "Music.app"} did not confirm: ${(e as Error).message})`;
      }
      now.state = "stopped";
      now.source = null;
      return `[] Stopped.${warning}`;
    },
  },
  {
    name: "radio_now_playing",
    description: "Show what is currently playing, including the song on air for radio stations that publish it.",
    schema: noArgs,
    handler: async () => {
      // For the remote sources, ask the app for the real current track; fall
      // back to our recorded state when the call fails (offline, app closed).
      if (now.source === "spotify") {
        try { return `Spotify — ${await spotify.nowPlayingLine()}`; } catch { /* fall back */ }
      }
      if (now.source === "applemusic") {
        try { return `Apple Music — ${applemusic.nowPlayingLine()}`; } catch { /* fall back */ }
      }
      // Most stations name the song in the stream itself; mpv exposes it.
      // Not while paused: the last title read would be stale.
      const song = now.source === "radio" && now.state === "playing" ? await player.streamTitle(now.stationName) : null;
      return describe(song);
    },
  },
  {
    name: "radio_volume",
    description: "Set volume 0-100 without restarting mpv; ffplay requires mpv for live volume control.",
    schema: { type: "object", properties: { level: { type: "number", minimum: 0, maximum: 100 } }, required: ["level"] },
    handler: async (a) => {
      // Reject missing/non-numeric input up front. Be stricter than Number():
      // Number("") and Number(null) are 0, which would turn `/volume` or
      // `/volume level=` into an accidental mute.
      const raw = a.level;
      const level =
        typeof raw === "number" ? raw
          : typeof raw === "string" && raw.trim() !== "" ? Number(raw)
            : NaN;
      if (!Number.isFinite(level)) throw new Error("Give a volume 0-100, e.g. level=60.");
      now.volume = Math.max(0, Math.min(100, Math.round(level)));
      if (["radio", "podcast", "hoer"].includes(now.source ?? "") && now.state !== "stopped") {
        // ffplay has no control channel. Keep the new level for the next
        // station/episode rather than rejecting the change outright.
        if (!(await player.setVolume(now.volume)))
          return `vol ${now.volume} (applies from the next station/episode — ffplay can't change volume live; install mpv)`;
      } else if (now.source === "spotify" && now.state === "playing") {
        await spotify.setVolume(now.volume);
      } else if (now.source === "applemusic" && now.state === "playing") {
        applemusic.setVolume(now.volume);
      }
      return `vol ${now.volume}`;
    },
  },
  {
    name: "spotify_login",
    description: "Start Spotify OAuth. Returns a URL to open; then paste the redirect URL with spotify_complete_login.",
    schema: noArgs,
    handler: () =>
      `Open this URL and approve. Then copy the redirect URL from the address bar (the page itself won't load) and pass it — or just its "code" param — to spotify_complete_login:\n${spotify.loginUrl()}`,
  },
  {
    name: "spotify_complete_login",
    description: "Finish Spotify login by pasting the redirect URL, or just its code parameter.",
    schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    handler: async (a) => { await spotify.complete(String(a.code)); return "Spotify linked."; },
  },
  {
    name: "spotify_list_playlists",
    description: "List your Spotify playlists (requires login).",
    schema: noArgs,
    handler: () => spotify.listPlaylists(),
  },
  {
    name: "spotify_play_playlist",
    description:
      "Play anything on Spotify: a spotify: URI, an open.spotify.com URL, one of your playlists by name, " +
      "or free text (searches the catalog: track > album > playlist > show). Requires Premium + a Spotify client.",
    schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    handler: async (a) => {
      // spotify.ts can't import applemusic (applemusic imports spotify), so the
      // Music.app handoff lives here: capture the source before playContext
      // rewrites it, silence Music only after Spotify committed.
      const wasAppleMusic = now.source === "applemusic";
      const out = await spotify.playContext(String(a.target));
      if (wasAppleMusic) await playbackEffect(() => applemusic.pauseIfRunning());
      return out;
    },
  },
  {
    name: "spotify_search",
    description: `Search the Spotify catalog. Optional type: comma list of track, album, artist, playlist, show, episode (default "track,album,playlist,show").`,
    schema: {
      type: "object",
      properties: { query: { type: "string" }, type: { type: "string" } },
      required: ["query"],
    },
    handler: (a) => spotify.search(String(a.query), a.type == null ? undefined : String(a.type)),
  },
  {
    name: "spotify_devices",
    description: "List your online Spotify Connect devices (the active one is marked with >).",
    schema: noArgs,
    handler: () => spotify.devices(),
  },
  {
    name: "spotify_transfer",
    description: "Move Spotify playback to another device, by name (substring) or device id.",
    schema: { type: "object", properties: { device: { type: "string" } }, required: ["device"] },
    handler: (a) => spotify.transfer(String(a.device)),
  },
  {
    name: "podcast_play",
    description:
      "Play a podcast's newest episode via the local player. Give a podcast name (searched on iTunes, no login) " +
      "or an RSS feed URL. radio_next/radio_prev then step to older/newer episodes.",
    schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    handler: (a) => podcast.playQuery(String(a.target)),
  },
  {
    name: "hoer_play",
    description:
      "Play HÖR Berlin (hoer.live) — the live DJ stream when on air, otherwise the latest set. " +
      "Streams via YouTube, so yt-dlp must be installed.",
    schema: noArgs,
    handler: () => hoer.play(),
  },
  {
    name: "music_play",
    description:
      "Play from your Apple Music library via the local Music.app (macOS only). " +
      "Matches a playlist name first, then a track name, then an album name.",
    schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    handler: (a) => applemusic.play(String(a.target)),
  },
  {
    name: "radio_doctor",
    description:
      "Diagnose the playback environment: audio player, yt-dlp, Spotify config/login, " +
      "session anchor, tracked players, and stream reachability. Run this first when playback isn't working.",
    schema: noArgs,
    handler: () => doctor(),
  },
];

async function resumePlayback(): Promise<string> {
  if (["radio", "podcast", "hoer"].includes(now.source ?? "") &&
      await playbackEffect(() => player.setPaused(false))) {
    now.state = "playing";
    return "> Resumed at the current position.";
  }
  if (now.source === "spotify") await playbackEffect(() => spotify.resume());
  else if (now.source === "applemusic") await playbackEffect(() => applemusic.resume());
  else if (now.source === "podcast") return podcast.resume();
  else if (now.source === "hoer") return hoer.resume();
  else if (now.source === "radio" && now.genre) await radio.playGenre(now.genre, now.stationIndex);
  else throw new Error("Nothing to resume. Use radio_play, podcast_play, spotify_play_playlist, or music_play.");
  now.state = "playing";
  return "> Resumed.";
}

// Mutations bump the state revision, superseding older requests that are still
// resolving media. Volume is deliberately not one: adjusting it while a station
// loads must not cancel that station. Its effect is still serialized, so the
// pending play picks the new level up when it starts.
const mutations = new Set(["radio_play", "radio_next", "radio_prev", "radio_pause", "radio_resume", "radio_stop", "podcast_play", "hoer_play", "music_play", "spotify_play_playlist", "spotify_transfer"]);
const directEffects = new Set(["radio_pause", "radio_stop", "radio_volume", "spotify_transfer"]);

// Neither the MCP SDK nor the CLI enforces `required`. Reject blank text before
// any network call or effect: an empty device name, for one, substring-matches
// every Spotify device and would move playback to the first.
function checkRequired(tool: Tool, args: unknown): void {
  const given = (args ?? {}) as Record<string, unknown>;
  for (const key of (tool.schema.required ?? []) as string[]) {
    if (tool.schema.properties?.[key]?.type !== "string") continue;
    const value = given[key];
    if (value == null || String(value).trim() === "") throw new Error(`Missing "${key}" — ${tool.name} needs a non-empty ${key}.`);
  }
}

export async function runTool(name: string, args: unknown = {}, signal?: AbortSignal): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  checkRequired(tool, args);
  return withBudget(() => withState(() => directEffects.has(name)
    ? playbackEffect(() => tool.handler(args))
    : tool.handler(args), mutations.has(name)), signal);
}
