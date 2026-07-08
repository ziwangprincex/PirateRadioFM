// Spotify source: OAuth PKCE login + remote control of an ALREADY-RUNNING Spotify client.
// The Web API cannot output audio itself — it commands a Connect device. Requires Premium.
// ponytail: no third-party SDK. Raw fetch + a JSON token cache on disk. Add a real HTTP
// callback server only if the manual paste flow proves annoying.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { now } from "../state.js";
import { stop as stopLocal } from "../player.js";

const API = "https://api.spotify.com/v1";
const AUTH = "https://accounts.spotify.com";
const REDIRECT = "http://127.0.0.1:8888/callback"; // register this in your Spotify app
const SCOPES = "user-read-playback-state user-modify-playback-state playlist-read-private";

const cfgDir = join(homedir(), ".pirate-radio");
const tokenPath = join(cfgDir, "spotify.json");

interface Tokens { access_token: string; refresh_token: string; expires_at: number; }
// PKCE verifier is held between loginUrl() and complete() across separate CLI
// invocations, so it lives in the persisted state, not module-level memory.

function clientId(): string {
  const id = process.env.SPOTIFY_CLIENT_ID;
  if (!id) throw new Error("Set SPOTIFY_CLIENT_ID (from your Spotify developer app) to use Spotify.");
  return id;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function loadTokens(): Tokens | null {
  if (!existsSync(tokenPath)) return null;
  try {
    return JSON.parse(readFileSync(tokenPath, "utf8"));
  } catch {
    // Corrupt token file — treat as logged-out rather than crashing every call.
    return null;
  }
}
function saveTokens(t: Tokens): void {
  mkdirSync(cfgDir, { recursive: true });
  // 0o600: refresh_token grants long-lived account access — no other user needs to read it.
  writeFileSync(tokenPath, JSON.stringify(t, null, 2), { mode: 0o600 });
}

// Step 1: build the authorize URL. User opens it, approves, and pastes back the ?code=.
export function loginUrl(): string {
  const v = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(v).digest());
  now.spotifyVerifier = v;
  const p = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: REDIRECT,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SCOPES,
  });
  return `${AUTH}/authorize?${p}`;
}

// Step 2: exchange the pasted code for tokens.
export async function complete(code: string): Promise<void> {
  const v = now.spotifyVerifier;
  if (!v) throw new Error("Call spotify_login first to start the flow.");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId(),
    code_verifier: v,
  });
  const r = await fetch(`${AUTH}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Token exchange failed: ${await r.text()}`);
  const j = (await r.json()) as any;
  // Fall back to Spotify's documented 1-hour default if expires_in is missing —
  // otherwise `undefined * 1000 = NaN` wedges the refresh check forever.
  const ttl = Number(j.expires_in) || 3600;
  saveTokens({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + ttl * 1000 });
  now.spotifyVerifier = null;
}

// In-flight refresh promise: if two callers hit accessToken() while the token
// is expiring, both should share the same POST /api/token rather than race and
// double-write. Set inside the refresh path and cleared when it settles.
// Scope note: this only dedupes WITHIN one process. Two separate CLI processes
// can still both refresh; that costs one wasted POST and the losing writer's
// tokens are overwritten — acceptable since refreshes happen ~hourly.
let refreshInFlight: Promise<string> | null = null;

async function accessToken(): Promise<string> {
  const t = loadTokens();
  if (!t) throw new Error("Not logged in to Spotify. Run spotify_login.");
  if (Date.now() < t.expires_at - 30_000) return t.access_token;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: clientId(),
      });
      const r = await fetch(`${AUTH}/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!r.ok) throw new Error(`Token refresh failed: ${await r.text()}`);
      const j = (await r.json()) as any;
      const ttl = Number(j.expires_in) || 3600;
      const next: Tokens = { access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: Date.now() + ttl * 1000 };
      saveTokens(next);
      return next.access_token;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const tok = await accessToken();
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${tok}` },
  });
  // Errors carry `.status` so callers can branch (playContext's no-device
  // recovery keys off 404) without string-matching the message.
  if (r.status === 404)
    throw statusError(404, "No active Spotify device found. Open the Spotify app (Premium required) and play something once, then retry — or use spotify_devices.");
  if (r.status === 403)
    throw statusError(403, "Spotify refused the command. Premium is required for playback control.");
  // Anything else that isn't 2xx (500, 502, 429, 400 with a bad body) must
  // surface as an error — otherwise callers happily parse an empty body and
  // report "success" or "no playlists found" when the real problem was a 500.
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw statusError(r.status, `Spotify API ${r.status}: ${body.slice(0, 200) || r.statusText}`);
  }
  return r;
}

function statusError(status: number, message: string): Error {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

export async function listPlaylists(): Promise<string> {
  const r = await api("/me/playlists?limit=20");
  const j = (await r.json()) as any;
  const items = (j.items ?? []).map((p: any) => `• ${p.name}  [${p.uri}]`);
  return items.length ? items.join("\n") : "No playlists found.";
}

// --- catalog search ---------------------------------------------------------

const SEARCH_TYPES = ["track", "album", "artist", "playlist", "show", "episode"] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

function fmtHit(t: SearchType, x: any): string {
  const by =
    t === "track" || t === "album"
      ? ` — ${(x.artists ?? []).map((a: any) => a.name).join(", ")}`
      : t === "playlist"
        ? ` — by ${x.owner?.display_name ?? "?"}`
        : t === "show"
          ? ` — ${x.publisher ?? "?"}`
          : "";
  return `• ${x.name}${by}  [${x.uri}]`;
}

// Search the whole Spotify catalog. `types` is a comma list; defaults cover the
// common "play me X" cases. Returns display lines with URIs the play tool accepts.
export async function search(query: string, types?: string): Promise<string> {
  const wanted = (types ?? "track,album,playlist,show")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is SearchType => (SEARCH_TYPES as readonly string[]).includes(t));
  if (wanted.length === 0)
    throw new Error(`No valid search type. Use a comma list of: ${SEARCH_TYPES.join(", ")}`);
  const p = new URLSearchParams({ q: query, type: wanted.join(","), limit: "5" });
  const r = await api(`/search?${p}`);
  const j = (await r.json()) as any;
  const out: string[] = [];
  for (const t of wanted) {
    // Search can return null placeholder items; drop them before formatting.
    const items = (j[`${t}s`]?.items ?? []).filter(Boolean);
    if (items.length === 0) continue;
    out.push(`${t.toUpperCase()}S`, ...items.map((x: any) => fmtHit(t, x)));
  }
  return out.length ? out.join("\n") : `No results for "${query}".`;
}

// Top result across types in play-priority order — what "just play X" wants.
async function searchBest(query: string): Promise<{ uri: string; name: string } | null> {
  const p = new URLSearchParams({ q: query, type: "track,album,playlist,show", limit: "1" });
  const r = await api(`/search?${p}`);
  const j = (await r.json()) as any;
  for (const t of ["track", "album", "playlist", "show"]) {
    const hit = (j[`${t}s`]?.items ?? []).filter(Boolean)[0];
    if (hit) return { uri: hit.uri, name: `${hit.name}${hit.artists ? ` — ${hit.artists.map((a: any) => a.name).join(", ")}` : ""}` };
  }
  return null;
}

// --- devices ----------------------------------------------------------------

interface Device { id: string; name: string; type: string; is_active: boolean; }

async function deviceList(): Promise<Device[]> {
  const r = await api("/me/player/devices");
  const j = (await r.json()) as any;
  return (j.devices ?? []).filter((d: any) => d.id);
}

export async function devices(): Promise<string> {
  const ds = await deviceList();
  if (ds.length === 0)
    return "No Spotify devices online. Open Spotify on your computer/phone, then retry.";
  return ds.map((d) => `${d.is_active ? "> " : "• "}${d.name} (${d.type})  [${d.id}]`).join("\n");
}

// Move playback to a device picked by (case-insensitive) name substring or id.
export async function transfer(nameOrId: string): Promise<string> {
  const ds = await deviceList();
  const q = nameOrId.trim().toLowerCase();
  const hit = ds.find((d) => d.id === nameOrId) ?? ds.find((d) => d.name.toLowerCase().includes(q));
  if (!hit) {
    const names = ds.map((d) => d.name).join(", ") || "(none online)";
    throw new Error(`No device matching "${nameOrId}". Online: ${names}`);
  }
  await api("/me/player", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_ids: [hit.id], play: true }),
  });
  return `Playback moved to ${hit.name}.`;
}

// --- now playing ------------------------------------------------------------

export async function nowPlayingLine(): Promise<string> {
  const r = await api("/me/player");
  if (r.status === 204) return "Spotify: nothing playing.";
  const j = (await r.json()) as any;
  const item = j.item;
  if (!item) return "Spotify: nothing playing.";
  const who = (item.artists ?? []).map((a: any) => a.name).join(", ") || item.show?.name || "";
  const t = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  const pos = Number.isFinite(j.progress_ms) && Number.isFinite(item.duration_ms)
    ? ` (${t(j.progress_ms)}/${t(item.duration_ms)})`
    : "";
  return `${j.is_playing ? "Playing" : "Paused"}: ${item.name}${who ? ` — ${who}` : ""}${pos} on ${j.device?.name ?? "?"}`;
}

// --- playback ---------------------------------------------------------------

// open.spotify.com/track/ID?si=… → spotify:track:ID (also album/playlist/artist/show/episode).
function urlToUri(s: string): string {
  const m = s.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|artist|show|episode)\/([A-Za-z0-9]+)/i);
  return m ? `spotify:${m[1].toLowerCase()}:${m[2]}` : s;
}

function playBody(uri: string): string {
  // Tracks and episodes are not "contexts" — they go in `uris`; everything
  // else (album/playlist/artist/show) is a context_uri.
  return /^spotify:(track|episode):/.test(uri)
    ? JSON.stringify({ uris: [uri] })
    : JSON.stringify({ context_uri: uri });
}

// Play anything: a spotify: URI, an open.spotify.com URL, one of the user's
// playlists by name, or free text (falls back to a catalog search, best hit
// in track > album > playlist > show order).
export async function playContext(uriOrName: string): Promise<string> {
  let uri = urlToUri(uriOrName.trim());
  let displayName = uriOrName;
  if (!uri.startsWith("spotify:")) {
    const r = await api("/me/playlists?limit=50");
    const j = (await r.json()) as any;
    const hit = (j.items ?? []).find((p: any) => p.name.toLowerCase() === uriOrName.toLowerCase());
    if (hit) {
      uri = hit.uri;
      displayName = hit.name;
    } else {
      const best = await searchBest(uriOrName);
      if (!best) throw new Error(`Nothing on Spotify matches "${uriOrName}". Try spotify_search.`);
      uri = best.uri;
      displayName = best.name;
    }
  }
  // Ask Spotify FIRST. If the API call fails (no active device, not Premium,
  // network) we bail and leave the local radio stream alone — otherwise we'd
  // kill the user's current audio and then give them an error, ending in
  // silence. Only silence local playback once Spotify has committed.
  await playWithRecovery(playBody(uri));
  stopLocal();
  now.state = "playing";
  now.source = "spotify";
  now.title = displayName;
  return `Playing ${displayName} on your Spotify device.`;
}

// PUT /me/player/play, and on the classic 404 no-active-device error try to
// self-heal on macOS: launch the Spotify app, wait for its Connect device to
// come online, transfer playback there, and retry once. Elsewhere (or if the
// app never shows up) rethrow the original guidance.
async function playWithRecovery(body: string): Promise<void> {
  const put = (device?: string) =>
    api(`/me/player/play${device ? `?device_id=${device}` : ""}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });
  try {
    await put();
  } catch (e) {
    if ((e as { status?: number }).status !== 404 || process.platform !== "darwin") throw e;
    const id = await launchAndWaitForDevice();
    if (!id) throw e;
    await put(id);
  }
}

async function launchAndWaitForDevice(): Promise<string | null> {
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("open", ["-a", "Spotify"], { stdio: "ignore", timeout: 8000 });
  } catch {
    return null; // app not installed — nothing to recover with
  }
  // The desktop app registers with Spotify Connect a few seconds after launch.
  for (let i = 0; i < 6; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    try {
      const ds = await deviceList();
      const d = ds.find((x) => x.type.toLowerCase() === "computer") ?? ds[0];
      if (d) return d.id;
    } catch {
      /* keep polling */
    }
  }
  return null;
}

export async function pause(): Promise<void> { await api("/me/player/pause", { method: "PUT" }); }
export async function resume(): Promise<void> { await api("/me/player/play", { method: "PUT" }); }
export async function skipNext(): Promise<void> { await api("/me/player/next", { method: "POST" }); }
export async function skipPrev(): Promise<void> { await api("/me/player/previous", { method: "POST" }); }
export async function setVolume(percent: number): Promise<void> {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  await api(`/me/player/volume?volume_percent=${p}`, { method: "PUT" });
}
