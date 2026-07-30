// Radio source: picks/rotates stations from the shared station list, drives the player.
import * as player from "../player.js";
import * as spotify from "./spotify.js";
import * as applemusic from "./applemusic.js";
import { now } from "../state.js";
import { all, acceptedGenres, genreInfo, genres as allGenres, resolveGenre, type Station } from "../stations.js";

const stations = all();

export function genres(): string[] {
  return allGenres();
}

export function list(): string {
  return genres()
    .map((g) => {
      const info = genreInfo(g)!;
      return `${g} \u2014 ${info.label} (${stations[g].length} station${stations[g].length > 1 ? "s" : ""})`;
    })
    .join(", ");
}

export async function playGenre(genre: string, index = 0): Promise<Station> {
  const g = resolveGenre(genre);
  if (!g) throw new Error(`Unknown genre "${genre}". Available: ${acceptedGenres().join(", ")}`);
  // If we were on a remote source (Spotify Connect, Music.app), silence it
  // before starting the local stream — otherwise both would play simultaneously
  // (they run in their own apps; our player.stop() only kills local mpv/ffplay).
  if (now.source === "spotify") {
    try { await spotify.pause(); } catch { /* best effort — network / not-logged-in */ }
  }
  if (now.source === "applemusic") applemusic.pauseIfRunning();
  // Floor-mod, not JS %: a negative or fractional index (corrupt state.json,
  // prev() underflow) must still land on a real station, not stations[-1].
  const len = stations[g].length;
  const i = ((Math.trunc(index) % len) + len) % len;
  const st = stations[g][i];
  player.play(st.url, now.volume);
  now.state = "playing";
  now.source = "radio";
  now.genre = g;
  now.stationName = st.name;
  now.stationIndex = i;
  return st;
}

export async function next(): Promise<Station> {
  if (now.source !== "radio" || !now.genre)
    throw new Error("No radio station is playing.");
  return playGenre(now.genre, now.stationIndex + 1);
}

export async function prev(): Promise<Station> {
  if (now.source !== "radio" || !now.genre)
    throw new Error("No radio station is playing.");
  const genre = resolveGenre(now.genre);
  if (!genre) throw new Error(`Unknown saved genre "${now.genre}".`);
  const len = stations[genre].length;
  return playGenre(genre, (now.stationIndex - 1 + len) % len);
}
