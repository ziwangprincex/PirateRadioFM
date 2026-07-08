// Tool definitions + handlers. Registered on the MCP server in index.ts.
import * as radio from "./sources/radio.js";
import * as spotify from "./sources/spotify.js";
import * as podcast from "./sources/podcast.js";
import * as applemusic from "./sources/applemusic.js";
import * as hoer from "./sources/hoer.js";
import * as player from "./player.js";
import { now, describe } from "./state.js";

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
    description: `Play a built-in genre radio station. Genres: ${radio.genres().join(", ")}.`,
    schema: { type: "object", properties: { genre: { type: "string" } }, required: ["genre"] },
    handler: async (a) => {
      const st = await radio.playGenre(String(a.genre));
      return `> ${now.genre} — ${st.name}`;
    },
  },
  {
    name: "radio_next",
    description: "Next station (radio), next track (Spotify/Apple Music), or next-older episode (podcast).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") { await spotify.skipNext(); return "Next track."; }
      if (now.source === "applemusic") { applemusic.next(); return "Next track."; }
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
      if (now.source === "spotify") { await spotify.skipPrev(); return "Previous track."; }
      if (now.source === "applemusic") { applemusic.prev(); return "Previous track."; }
      if (now.source === "podcast") return podcast.prev();
      if (now.source === "hoer") throw new Error("HÖR is a single live channel — nothing to skip to.");
      const st = await radio.prev();
      return `Prev: ${now.genre} — ${st.name}`;
    },
  },
  {
    name: "radio_pause",
    description: "Pause playback (radio/podcast: stops the stream; Spotify/Apple Music: pauses the app).",
    schema: noArgs,
    handler: async () => {
      // Reflect the user's INTENT in state even if the underlying call fails —
      // otherwise a Spotify network hiccup leaves now.state stuck at "playing"
      // and radio_now_playing lies.
      if (now.source === "spotify") { try { await spotify.pause(); } catch { /* keep going */ } }
      else if (now.source === "applemusic") { try { applemusic.pause(); } catch { /* keep going */ } }
      else player.stop();
      now.state = "paused";
      return "|| Paused.";
    },
  },
  {
    name: "radio_resume",
    description: "Resume playback (a paused podcast restarts its episode from the top).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") await spotify.resume();
      else if (now.source === "applemusic") applemusic.resume();
      else if (now.source === "podcast") return podcast.resume();
      else if (now.source === "hoer") return hoer.resume();
      else if (now.source === "radio" && now.genre) await radio.playGenre(now.genre, now.stationIndex);
      else throw new Error("Nothing to resume. Use radio_play, podcast_play, spotify_play_playlist, or music_play.");
      now.state = "playing";
      return "> Resumed.";
    },
  },
  {
    name: "radio_stop",
    description: "Stop playback entirely.",
    schema: noArgs,
    handler: async () => {
      // Same rationale as radio_pause: user asked to stop, respect that in
      // state regardless of whether the remote call succeeded.
      if (now.source === "spotify") { try { await spotify.pause(); } catch { /* keep going */ } }
      else if (now.source === "applemusic") { try { applemusic.stop(); } catch { /* keep going */ } }
      else player.stop();
      now.state = "stopped";
      now.source = null;
      return "[] Stopped.";
    },
  },
  {
    name: "radio_now_playing",
    description: "Show what is currently playing.",
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
      return describe();
    },
  },
  {
    name: "radio_volume",
    description: "Set volume 0-100 (applies to radio; restarts the current stream).",
    schema: { type: "object", properties: { level: { type: "number", minimum: 0, maximum: 100 } }, required: ["level"] },
    handler: async (a) => {
      // Reject missing/non-numeric input up front: Number(undefined) is NaN, and
      // NaN would flow into state.json (as null) and later into mpv's --volume.
      const level = Number(a.level);
      if (!Number.isFinite(level)) throw new Error("Give a volume 0-100, e.g. level=60.");
      now.volume = Math.max(0, Math.min(100, Math.round(level)));
      if (now.source === "radio" && now.state === "playing" && now.genre)
        await radio.playGenre(now.genre, now.stationIndex);
      else if (now.source === "podcast" && now.state === "playing")
        await podcast.resume(); // restart the episode at the new volume, like radio
      else if (now.source === "hoer" && now.state === "playing")
        await hoer.resume(); // re-resolve and restart the stream at the new volume
      else if (now.source === "spotify" && now.state === "playing") {
        // Best-effort: user's intent is to change volume, so recording it in
        // state should stick even if the remote device call fails.
        try { await spotify.setVolume(now.volume); } catch { /* keep going */ }
      } else if (now.source === "applemusic" && now.state === "playing") {
        try { applemusic.setVolume(now.volume); } catch { /* keep going */ }
      }
      return `vol ${now.volume}`;
    },
  },
  {
    name: "spotify_login",
    description: "Start Spotify OAuth. Returns a URL to open; then paste the code with spotify_complete_login.",
    schema: noArgs,
    handler: () =>
      `Open this URL, approve, then copy the "code" query param from the redirect and call spotify_complete_login:\n${spotify.loginUrl()}`,
  },
  {
    name: "spotify_complete_login",
    description: "Finish Spotify login by pasting the authorization code from the redirect URL.",
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
      if (wasAppleMusic) applemusic.pauseIfRunning();
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
];
