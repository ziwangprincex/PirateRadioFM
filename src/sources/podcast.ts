// Podcast source: iTunes Search API (no auth) → RSS feed → episode audio URL →
// the existing local player pipeline. Fully cross-platform, zero login.
// ponytail: no XML dependency — a podcast RSS <item> is regular enough that a
// scoped regex parse (enclosure url + title) is fine; anything unparseable is
// simply skipped. next/prev refetch the feed rather than caching episodes:
// one HTTP GET per skip keeps state tiny and the list always fresh.
import { now } from "../state.js";
import * as player from "../player.js";
import * as spotify from "./spotify.js";
import * as applemusic from "./applemusic.js";
import { rememberHost } from "../dynhosts.js";

export interface Episode { title: string; url: string; }

const MAX_EPISODES = 50;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'");
}

function textOf(block: string, tag: string): string | null {
  // CDATA first (common for titles), then plain text content.
  const m = block.match(new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, "i"));
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? "").trim();
  return raw ? decodeEntities(raw) : null;
}

// Channel title + newest-first episode list. Exported for selfcheck.
export function parseFeed(xml: string): { channel: string | null; episodes: Episode[] } {
  const episodes: Episode[] = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    const enc = item.match(/<enclosure\b[^>]*\burl\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const url = enc?.[1] ?? enc?.[2];
    if (!url) continue; // item without audio (e.g. announcement post)
    episodes.push({ title: textOf(item, "title") ?? "(untitled episode)", url: decodeEntities(url) });
    if (episodes.length >= MAX_EPISODES) break;
  }
  // The channel <title> is the first one before any <item>.
  const head = items.length ? xml.slice(0, xml.search(/<item[\s>]/i)) : xml;
  return { channel: textOf(head, "title"), episodes };
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`Fetch failed (${r.status}) for ${url}`);
  return r.text();
}

// Podcast enclosures are routinely wrapped in tracking chains (swap.fm,
// podtrac, chartable, mgln.ai ...) of the shape
//   https://tracker-a/.../tracker-b/real-host.com/path/file.mp3
// where each hop 302s to the rest of the path. Some hops are broken or flaky —
// the same hop can 404 one request and 302 the next. ffplay gives up on the
// first 404 and dies instantly, leaving "playing" state with no audio. The
// real file host is embedded in the path, so prefer it outright: take the LAST
// path segment that looks like a hostname and probe that URL directly.
export function embeddedDirectUrl(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const seg = u.pathname.split("/").filter(Boolean);
  // length-2: the host segment needs at least a filename after it. The final
  // label must be all-alphabetic (like a TLD), which rules out filename
  // segments such as "episode.mp3" or podtrac's "redirect.mp3" ("mp3" contains
  // a digit) while accepting real hosts like "traffic.megaphone.fm".
  for (let i = seg.length - 2; i >= 0; i--) {
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(seg[i])) {
      return `https://${seg.slice(i).join("/")}${u.search}`;
    }
  }
  return null;
}

// Probe a URL with a 1-byte range GET; returns the URL to hand the player
// (the probed one — stable — not the post-redirect signed CDN url, which can
// expire mid-episode) or null if it doesn't answer 2xx.
async function probe(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: { Range: "bytes=0-0", "User-Agent": "Mozilla/5.0" },
    });
    try { await r.body?.cancel(); } catch { /* already closed */ }
    return r.ok ? url : null;
  } catch {
    return null;
  }
}

async function resolveDirect(url: string): Promise<string> {
  const direct = embeddedDirectUrl(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    // Prefer the de-tracked direct URL; fall back to the full chain as-is.
    if (direct && (await probe(direct))) return direct;
    if (await probe(url)) return url;
    await new Promise((res) => setTimeout(res, 300));
  }
  return url; // let the player try anyway — it retries nothing, but who knows
}

// Resolve a user query to a feed URL: direct RSS URL passes through, anything
// else goes to the iTunes Search API (free, no key) and takes the top hit.
async function resolveFeed(target: string): Promise<{ feedUrl: string; name: string | null }> {
  const t = target.trim();
  if (/^https?:\/\//i.test(t)) return { feedUrl: t, name: null };
  const q = new URLSearchParams({ media: "podcast", limit: "5", term: t });
  const j = JSON.parse(await fetchText(`https://itunes.apple.com/search?${q}`)) as any;
  const hit = (j.results ?? []).find((r: any) => typeof r.feedUrl === "string");
  if (!hit) throw new Error(`No podcast found for "${target}". Try a different name or paste an RSS URL.`);
  return { feedUrl: hit.feedUrl, name: hit.collectionName ?? null };
}

// Play episode `index` (0 = newest) of the feed in `now.podcastFeed`.
async function playIndex(feedUrl: string, name: string | null, index: number): Promise<string> {
  const { channel, episodes } = parseFeed(await fetchText(feedUrl));
  if (episodes.length === 0) throw new Error("The feed has no playable episodes (no audio enclosures).");
  const i = Math.max(0, Math.min(index, episodes.length - 1));
  const ep = episodes[i];
  // Silence remote sources before starting the local stream (same rationale as
  // radio.playGenre); player.play() itself kills any previous local player.
  if (now.source === "spotify") {
    try { await spotify.pause(); } catch { /* best effort */ }
  }
  if (now.source === "applemusic") applemusic.pauseIfRunning();
  const direct = await resolveDirect(ep.url);
  try { rememberHost(new URL(direct).host); } catch { /* odd URL — sweep just won't cover it */ }
  player.play(direct, now.volume);
  const displayName = name ?? channel ?? feedUrl;
  now.state = "playing";
  now.source = "podcast";
  now.podcastFeed = feedUrl;
  now.podcastName = displayName;
  now.episodeIndex = i;
  now.title = ep.title;
  const pos = `${i + 1}/${episodes.length}`;
  return `> ${displayName} — ${ep.title} (episode ${pos}, newest first)`;
}

export async function playQuery(target: string): Promise<string> {
  const { feedUrl, name } = await resolveFeed(target);
  return playIndex(feedUrl, name, 0);
}

function requireCurrent(): string {
  if (now.source !== "podcast" || !now.podcastFeed)
    throw new Error("No podcast is playing. Use podcast_play first.");
  return now.podcastFeed;
}

// next = one episode OLDER (down the newest-first list), prev = one newer.
export async function next(): Promise<string> {
  return playIndex(requireCurrent(), now.podcastName, now.episodeIndex + 1);
}

export async function prev(): Promise<string> {
  if (now.episodeIndex <= 0) throw new Error("Already at the newest episode.");
  return playIndex(requireCurrent(), now.podcastName, now.episodeIndex - 1);
}

// Restart the current episode (from the top — mpv was killed on pause, so the
// position is gone; good enough for v1 and documented).
export async function resume(): Promise<string> {
  return playIndex(requireCurrent(), now.podcastName, now.episodeIndex);
}
