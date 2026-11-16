import { request, checkCancelled, wait } from "../http.js";
// Podcast source: iTunes Search API (no auth) → RSS feed → episode audio URL →
// the existing local player pipeline. Fully cross-platform, zero login.
// ponytail: no XML dependency — a podcast RSS <item> is regular enough that a
// scoped regex parse (enclosure url + title) is fine; anything unparseable is
// simply skipped. next/prev refetch the feed rather than caching episodes:
// one HTTP GET per skip keeps state tiny and the list always fresh.
import { now, playbackEffect } from "../state.js";
import * as player from "../player.js";
import * as spotify from "./spotify.js";
import * as applemusic from "./applemusic.js";

export interface Episode { title: string; url: string; }

const MAX_EPISODES = 50;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// One pass, so "&amp;lt;" decodes to the literal text "&lt;", not "<". Numeric
// references (&#8217; &#x2019;) are how most feeds encode curly quotes.
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return NAMED_ENTITIES[entity] ?? match;
    const hex = entity[1] === "x" || entity[1] === "X";
    const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
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

// Feeds are newest-first and only the first MAX_EPISODES items matter, but
// popular shows publish 5-20MB of history. Keep the head instead of failing;
// parseFeed only matches complete <item> blocks, so a cut-off tail is ignored.
const FEED_HEAD_BYTES = 2 * 1024 * 1024;

async function fetchText(url: string, feed = false): Promise<string> {
  const r = await request(url, { redirect: "follow" }, feed ? { maxBytes: FEED_HEAD_BYTES, truncate: true } : {});
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
async function probe(url: string, budgetMs = 2500): Promise<string | null> {
  try {
    const r = await request(url, {
      redirect: "follow",
      headers: { Range: "bytes=0-0", "User-Agent": "Mozilla/5.0" },
    }, { probe: true, timeoutMs: Math.min(2500, budgetMs), budgetMs, retries: 0 });
    try { await r.body?.cancel(); } catch { /* already closed */ }
    return r.ok ? url : null;
  } catch {
    checkCancelled();
    return null;
  }
}

async function resolveDirect(url: string): Promise<string> {
  const direct = embeddedDirectUrl(url);
  const deadline = Date.now() + 10_000;
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
    // Prefer the de-tracked direct URL; fall back to the full chain as-is.
    if (direct && Date.now() < deadline && (await probe(direct, deadline - Date.now()))) return direct;
    if (Date.now() < deadline && await probe(url, deadline - Date.now())) return url;
    if (Date.now() >= deadline) break;
    await wait(Math.min(300, deadline - Date.now()));
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

// Play the episode `choose` picks from the feed's newest-first list.
async function playEpisode(feedUrl: string, name: string | null, choose: (episodes: Episode[]) => number): Promise<string> {
  const { channel, episodes } = parseFeed(await fetchText(feedUrl, true));
  if (episodes.length === 0) throw new Error("The feed has no playable episodes (no audio enclosures).");
  const i = choose(episodes);
  const ep = episodes[i];
  const direct = await resolveDirect(ep.url);
  await playbackEffect(async () => {
    // Silence remote sources before starting the local stream (same rationale as
    // radio.playGenre); player.play() itself kills any previous local player.
    if (now.source === "spotify") {
      try { await spotify.pause(); } catch { /* best effort */ }
    }
    if (now.source === "applemusic") applemusic.pauseIfRunning();
    await player.play(direct, now.volume);
  });
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
  return playEpisode(feedUrl, name, () => 0);
}

function requireCurrent(): string {
  if (now.source !== "podcast" || !now.podcastFeed)
    throw new Error("No podcast is playing. Use podcast_play first.");
  return now.podcastFeed;
}

// The feed is refetched on every step, and publishing an episode shifts every
// index by one. Re-find the episode we were on by title — nearest its saved
// index if titles repeat — so next/prev step from it instead of replaying it.
// Exported for selfcheck.
export function locateEpisode(episodes: Episode[], title: string | null, index: number): number {
  let found = -1;
  episodes.forEach((ep, i) => {
    if (title && ep.title === title && (found < 0 || Math.abs(i - index) < Math.abs(found - index))) found = i;
  });
  return found >= 0 ? found : index;
}

// offset +1 = one episode OLDER (down the newest-first list), -1 = one newer,
// 0 = the current one again.
async function step(offset: number): Promise<string> {
  return playEpisode(requireCurrent(), now.podcastName, (episodes) => {
    const i = locateEpisode(episodes, now.title, now.episodeIndex) + offset;
    // Stepping past either end must not silently replay the current episode.
    if (offset > 0 && i >= episodes.length) throw new Error(`Already at the oldest episode (${episodes.length} available).`);
    if (offset < 0 && i < 0) throw new Error("Already at the newest episode.");
    return Math.max(0, Math.min(i, episodes.length - 1));
  });
}

export function next(): Promise<string> { return step(1); }
export function prev(): Promise<string> { return step(-1); }

// Explicit fallback when the old player has exited; live mpv resumes via IPC.
export function resume(): Promise<string> { return step(0); }
