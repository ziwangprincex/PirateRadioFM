// Single source of truth for the bundled station catalog. The catalog owns
// display metadata, compatibility aliases, stream URLs, and the host set used
// by the orphan sweep.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface Station { name: string; url: string; }
export interface Genre {
  label: string;
  description: string;
  stations: Station[];
}
export interface StationCatalog {
  version: number;
  aliases: Record<string, string>;
  genres: Record<string, Genre>;
}

const here = dirname(fileURLToPath(import.meta.url));
const emptyCatalog: StationCatalog = { version: 2, aliases: {}, genres: {} };
let catalog: StationCatalog = emptyCatalog;

try {
  const raw = JSON.parse(readFileSync(join(here, "..", "data", "stations.json"), "utf8")) as unknown;
  catalog = validateCatalog(raw);
} catch (e) {
  process.stderr.write(`radiohead: failed to load stations.json \u2014 ${(e as Error).message}\n`);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateCatalog(value: unknown): StationCatalog {
  if (!value || typeof value !== "object") throw new Error("catalog must be an object");
  const raw = value as Partial<StationCatalog>;
  if (raw.version !== 2) throw new Error(`unsupported catalog version: ${String(raw.version)}`);
  if (!raw.aliases || typeof raw.aliases !== "object" || Array.isArray(raw.aliases))
    throw new Error("aliases must be an object");
  if (!raw.genres || typeof raw.genres !== "object" || Array.isArray(raw.genres))
    throw new Error("genres must be an object");

  const genres: Record<string, Genre> = {};
  const seenUrls = new Set<string>();
  for (const [id, candidate] of Object.entries(raw.genres)) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid genre id: ${id}`);
    if (!candidate || typeof candidate !== "object") throw new Error(`${id}: genre must be an object`);
    const genre = candidate as Partial<Genre>;
    if (!nonEmpty(genre.label)) throw new Error(`${id}: label is required`);
    if (!nonEmpty(genre.description)) throw new Error(`${id}: description is required`);
    if (!Array.isArray(genre.stations) || genre.stations.length === 0)
      throw new Error(`${id}: stations must be a non-empty array`);
    const stations = genre.stations.map((candidateStation, index) => {
      if (!candidateStation || typeof candidateStation !== "object")
        throw new Error(`${id}[${index}]: station must be an object`);
      const station = candidateStation as Partial<Station>;
      if (!nonEmpty(station.name)) throw new Error(`${id}[${index}]: name is required`);
      if (!nonEmpty(station.url)) throw new Error(`${id}[${index}]: url is required`);
      let parsed: URL;
      try { parsed = new URL(station.url); } catch { throw new Error(`${id}[${index}]: invalid URL`); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error(`${id}[${index}]: URL must be HTTP(S)`);
      if (seenUrls.has(station.url)) throw new Error(`${id}[${index}]: duplicate URL ${station.url}`);
      seenUrls.add(station.url);
      return { name: station.name, url: station.url };
    });
    genres[id] = { label: genre.label, description: genre.description, stations };
  }

  const aliases: Record<string, string> = {};
  for (const [alias, target] of Object.entries(raw.aliases)) {
    if (!/^[a-z0-9-]+$/.test(alias) || !nonEmpty(target)) throw new Error(`invalid alias: ${alias}`);
    if (genres[alias]) throw new Error(`alias conflicts with genre: ${alias}`);
    if (!genres[target]) throw new Error(`alias ${alias} targets unknown genre ${target}`);
    aliases[alias] = target;
  }
  return { version: 2, aliases, genres };
}

export function all(): Record<string, Station[]> {
  return Object.fromEntries(Object.entries(catalog.genres).map(([id, genre]) => [id, genre.stations]));
}

export function genres(): string[] {
  return Object.keys(catalog.genres);
}

export function aliases(): Record<string, string> {
  return { ...catalog.aliases };
}

export function acceptedGenres(): string[] {
  return [...genres(), ...Object.keys(catalog.aliases)];
}

export function resolveGenre(input: string): string | null {
  const id = input.trim().toLowerCase();
  if (catalog.genres[id]) return id;
  return catalog.aliases[id] ?? null;
}

export function genreInfo(id: string): Genre | null {
  const resolved = resolveGenre(id);
  return resolved ? catalog.genres[resolved] : null;
}

export function catalogVersion(): number {
  return catalog.version;
}

let hostCache: string[] | null = null;
export function hosts(): string[] {
  if (hostCache) return hostCache;
  const set = new Set<string>();
  for (const genre of Object.values(catalog.genres)) {
    for (const station of genre.stations) set.add(new URL(station.url).host.toLowerCase());
  }
  hostCache = [...set];
  return hostCache;
}
