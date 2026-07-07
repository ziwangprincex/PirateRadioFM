// Single source of truth for the bundled station list. radio.ts uses it to pick
// stations; the player/watchdog use hosts() to hunt down orphaned players whose
// command line references one of our stream URLs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface Station { name: string; url: string; }
export type Stations = Record<string, Station[]>;

const here = dirname(fileURLToPath(import.meta.url));
// dist/ -> ../data at runtime (this file compiles to dist/stations.js).
// If the bundled data file is missing or corrupt, start with an empty station
// map rather than crashing at module load — every entry-point (MCP server,
// CLI, watchdog, selfcheck) imports this, and a crash here bricks all of them.
// Individual tool calls will then fail with clear "Unknown genre" errors, and
// selfcheck's genre-count assertion turns the failure into a loud diagnostic.
let stations: Stations = {};
try {
  stations = JSON.parse(readFileSync(join(here, "..", "data", "stations.json"), "utf8"));
} catch (e) {
  process.stderr.write(`radiohead: failed to load stations.json — ${(e as Error).message}\n`);
}

export function all(): Stations {
  return stations;
}

export function genres(): string[] {
  return Object.keys(stations);
}

// Unique hostnames across every station URL. Used as the match set for the
// orphan sweep: any mpv/ffplay whose command line contains one of these is
// (almost certainly) one of ours. Spotify plays through its own client, not a
// local player, so radio hosts cover everything the local player ever streams.
let hostCache: string[] | null = null;
export function hosts(): string[] {
  if (hostCache) return hostCache;
  const set = new Set<string>();
  for (const list of Object.values(stations)) {
    for (const st of list) {
      try {
        set.add(new URL(st.url).host.toLowerCase());
      } catch {
        /* skip malformed URL */
      }
    }
  }
  hostCache = [...set];
  return hostCache;
}
