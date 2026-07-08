// Minimal runnable check (ponytail: one self-check, no framework).
// Grew from "one line: genres load" into a small pure-function battery. We
// still avoid touching the real state.json — everything here is either module-
// level constants (stations, hosts) or pure functions (parseArgs).
import assert from "node:assert";
import * as radio from "./sources/radio.js";
import * as player from "./player.js";
import { hosts } from "./stations.js";
import { parseArgs } from "./argparse.js";
import { tools } from "./tools.js";
import { parseFeed, embeddedDirectUrl } from "./sources/podcast.js";
import { escapeAS } from "./sources/applemusic.js";

// --- station data ----------------------------------------------------------
const expected = [
  "jazz", "classical", "indie", "rock", "country", "pop",
  "ambient", "lofi", "soul", "eighties", "world", "house", "techno",
  "kexp", "kcrw", "wfmu", "nts", "wwoz", "paradise", "npr",
];
const got = radio.genres();
for (const g of expected) assert.ok(got.includes(g), `missing genre: ${g}`);

// hosts() must be unique and non-empty — a duplicate entry would only waste
// work in the orphan sweep, but an empty list would make the sweep no-op and
// silently break the "no music survives a stop" guarantee.
const h = hosts();
assert.ok(h.length > 0, "hosts() returned empty — stations.json broken?");
assert.strictEqual(new Set(h).size, h.length, "hosts() has duplicates");

// --- player detect ---------------------------------------------------------
const p = player.playerAvailable();
assert.ok(p === null || p === "mpv" || p === "ffplay");

// --- tools registry --------------------------------------------------------
// Every command file must map to a real tool name. Catches typos when adding
// slash commands.
const toolNames = new Set(tools.map((t) => t.name));
for (const required of [
  "radio_list", "radio_play", "radio_next", "radio_prev", "radio_pause",
  "radio_resume", "radio_stop", "radio_now_playing", "radio_volume",
  "spotify_login", "spotify_complete_login", "spotify_list_playlists",
  "spotify_play_playlist", "spotify_search", "spotify_devices", "spotify_transfer",
  "podcast_play", "music_play", "hoer_play",
]) {
  assert.ok(toolNames.has(required), `tool missing: ${required}`);
}

// --- podcast feed parsing ----------------------------------------------------
// CDATA title, entity-encoded title, single-quoted enclosure url, and an item
// with no enclosure (must be skipped). Channel title must not leak from items.
const feed = `<?xml version="1.0"?><rss><channel>
  <title>My &amp; Show</title>
  <item><title><![CDATA[Ep 2 — latest]]></title>
    <enclosure url="https://cdn.example.com/ep2.mp3" type="audio/mpeg"/></item>
  <item><title>Announcement only</title></item>
  <item><title>Ep 1 &quot;pilot&quot;</title>
    <enclosure url='https://cdn.example.com/ep1.mp3' type="audio/mpeg"/></item>
</channel></rss>`;
const parsed = parseFeed(feed);
assert.strictEqual(parsed.channel, "My & Show");
assert.strictEqual(parsed.episodes.length, 2);
assert.strictEqual(parsed.episodes[0].title, "Ep 2 — latest");
assert.strictEqual(parsed.episodes[0].url, "https://cdn.example.com/ep2.mp3");
assert.strictEqual(parsed.episodes[1].title, 'Ep 1 "pilot"');
assert.strictEqual(parsed.episodes[1].url, "https://cdn.example.com/ep1.mp3");
assert.deepStrictEqual(parseFeed("<rss><channel><title>empty</title></channel></rss>").episodes, []);

// --- AppleScript string escaping ----------------------------------------------
assert.strictEqual(escapeAS(`My "Best" Mix\\2024`), `My \\"Best\\" Mix\\\\2024`);

// --- tracking-chain de-wrapping -------------------------------------------------
// swap.fm-style chain: take the LAST embedded hostname, keep the tail + query.
assert.strictEqual(
  embeddedDirectUrl("https://tracking.swap.fm/track/xyz/rss.swap.fm/feeds.megaphone.fm/CNE1/traffic.megaphone.fm/CNE2.mp3"),
  "https://traffic.megaphone.fm/CNE2.mp3",
);
// podtrac-style: "redirect.mp3" must not count as a hostname; query survives.
assert.strictEqual(
  embeddedDirectUrl("https://mgln.ai/e/2/dts.podtrac.com/redirect.mp3/cdn.simplecastaudio.com/ep/audio.mp3?aid=rss&feed=x"),
  "https://cdn.simplecastaudio.com/ep/audio.mp3?aid=rss&feed=x",
);
// plain direct URL: nothing embedded → null.
assert.strictEqual(embeddedDirectUrl("https://cdn.example.com/episodes/42.mp3"), null);

// --- argparse: number coercion only when schema says so --------------------
const numSchema = { type: "object", properties: { level: { type: "number" } } };
assert.deepStrictEqual(parseArgs(["level=50"], numSchema), { level: 50 });
assert.deepStrictEqual(parseArgs(["level=abc"], numSchema), { level: "abc" });

const strSchema = { type: "object", properties: { genre: { type: "string" } } };
assert.deepStrictEqual(parseArgs(["genre=80"], strSchema), { genre: "80" }); // NOT 80

// Multi-word value folded from bareword follow-ons.
const targetSchema = { type: "object", properties: { target: { type: "string" } } };
assert.deepStrictEqual(
  parseArgs(["target=my", "chill", "list"], targetSchema),
  { target: "my chill list" },
);

// JSON blob short-circuit.
assert.deepStrictEqual(parseArgs(['{"genre":"jazz"}'], strSchema), { genre: "jazz" });

// Barewords before any key are ignored.
assert.deepStrictEqual(parseArgs(["stray", "target=x"], targetSchema), { target: "x" });

console.log(`selfcheck OK — genres=${got.join(",")} hosts=${h.length} tools=${toolNames.size} player=${p ?? "none(will hint on play)"}`);
