// Tool definitions + handlers. Registered on the MCP server in index.ts.
import * as radio from "./sources/radio.js";
import * as spotify from "./sources/spotify.js";
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
    description: "Switch to the next station (radio) or next track (Spotify).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") { await spotify.skipNext(); return "Next track."; }
      const st = await radio.next();
      return `Next: ${now.genre} — ${st.name}`;
    },
  },
  {
    name: "radio_prev",
    description: "Switch to the previous station (radio) or previous track (Spotify).",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") { await spotify.skipPrev(); return "Previous track."; }
      const st = await radio.prev();
      return `Prev: ${now.genre} — ${st.name}`;
    },
  },
  {
    name: "radio_pause",
    description: "Pause playback (radio: stops the stream; Spotify: pauses the device).",
    schema: noArgs,
    handler: async () => {
      // Reflect the user's INTENT in state even if the underlying call fails —
      // otherwise a Spotify network hiccup leaves now.state stuck at "playing"
      // and radio_now_playing lies.
      if (now.source === "spotify") { try { await spotify.pause(); } catch { /* keep going */ } }
      else player.stop();
      now.state = "paused";
      return "|| Paused.";
    },
  },
  {
    name: "radio_resume",
    description: "Resume playback.",
    schema: noArgs,
    handler: async () => {
      if (now.source === "spotify") await spotify.resume();
      else if (now.source === "radio" && now.genre) await radio.playGenre(now.genre, now.stationIndex);
      else throw new Error("Nothing to resume. Use radio_play or spotify_play_playlist.");
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
    handler: () => describe(),
  },
  {
    name: "radio_volume",
    description: "Set volume 0-100 (applies to radio; restarts the current stream).",
    schema: { type: "object", properties: { level: { type: "number", minimum: 0, maximum: 100 } }, required: ["level"] },
    handler: async (a) => {
      now.volume = Math.max(0, Math.min(100, Math.round(Number(a.level))));
      if (now.source === "radio" && now.state === "playing" && now.genre)
        await radio.playGenre(now.genre, now.stationIndex);
      else if (now.source === "spotify" && now.state === "playing") {
        // Best-effort: user's intent is to change volume, so recording it in
        // state should stick even if the remote device call fails.
        try { await spotify.setVolume(now.volume); } catch { /* keep going */ }
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
    description: "Play a Spotify playlist/podcast by name or uri. Requires Premium + a running Spotify client.",
    schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    handler: async (a) => spotify.playContext(String(a.target)),
  },
];
