// Radio source: picks/rotates stations from the shared station list, drives the player.
import * as player from "../player.js";
import * as spotify from "./spotify.js";
import { now } from "../state.js";
import { all, genres as allGenres, type Station } from "../stations.js";

const stations = all();

export function genres(): string[] {
  return allGenres();
}

export function list(): string {
  return genres()
    .map((g) => `${g} (${stations[g].length} station${stations[g].length > 1 ? "s" : ""})`)
    .join(", ");
}

function normalize(genre: string): string | null {
  const g = genre.trim().toLowerCase();
  return genres().includes(g) ? g : null;
}

export async function playGenre(genre: string, index = 0): Promise<Station> {
  const g = normalize(genre);
  if (!g) throw new Error(`Unknown genre "${genre}". Available: ${genres().join(", ")}`);
  // If we were on Spotify, silence it before starting the local stream — otherwise
  // both would play simultaneously (Spotify runs on its own Connect device, our
  // player.stop() only kills local mpv/ffplay).
  if (now.source === "spotify") {
    try { await spotify.pause(); } catch { /* best effort — network / not-logged-in */ }
  }
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
  const len = stations[now.genre].length;
  return playGenre(now.genre, (now.stationIndex - 1 + len) % len);
}
