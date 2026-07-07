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
  if (r.status === 404)
    throw new Error("No active Spotify device found. Open the Spotify app (Premium required) and play something once, then retry.");
  if (r.status === 403)
    throw new Error("Spotify refused the command. Premium is required for playback control.");
  // Anything else that isn't 2xx (500, 502, 429, 400 with a bad body) must
  // surface as an error — otherwise callers happily parse an empty body and
  // report "success" or "no playlists found" when the real problem was a 500.
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Spotify API ${r.status}: ${body.slice(0, 200) || r.statusText}`);
  }
  return r;
}

export async function listPlaylists(): Promise<string> {
  const r = await api("/me/playlists?limit=20");
  const j = (await r.json()) as any;
  const items = (j.items ?? []).map((p: any) => `• ${p.name}  [${p.uri}]`);
  return items.length ? items.join("\n") : "No playlists found.";
}

export async function playContext(uriOrName: string): Promise<string> {
  let uri = uriOrName;
  let displayName = uriOrName;
  if (!uri.startsWith("spotify:")) {
    const r = await api("/me/playlists?limit=50");
    const j = (await r.json()) as any;
    const hit = (j.items ?? []).find((p: any) => p.name.toLowerCase() === uriOrName.toLowerCase());
    if (!hit) throw new Error(`No playlist named "${uriOrName}". Use spotify_list_playlists.`);
    uri = hit.uri;
    displayName = hit.name;
  }
  // Ask Spotify FIRST. If the API call fails (no active device, not Premium,
  // network) we bail and leave the local radio stream alone — otherwise we'd
  // kill the user's current audio and then give them an error, ending in
  // silence. Only silence local playback once Spotify has committed.
  await api("/me/player/play", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ context_uri: uri }),
  });
  stopLocal();
  now.state = "playing";
  now.source = "spotify";
  now.title = displayName;
  return `Playing ${displayName} on your Spotify device.`;
}

export async function pause(): Promise<void> { await api("/me/player/pause", { method: "PUT" }); }
export async function resume(): Promise<void> { await api("/me/player/play", { method: "PUT" }); }
export async function skipNext(): Promise<void> { await api("/me/player/next", { method: "POST" }); }
export async function skipPrev(): Promise<void> { await api("/me/player/previous", { method: "POST" }); }
export async function setVolume(percent: number): Promise<void> {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  await api(`/me/player/volume?volume_percent=${p}`, { method: "PUT" });
}
