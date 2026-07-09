// Test suite — Node's built-in runner (node:test), no third-party framework.
// Run with `node --test dist/selfcheck.js` after building. Where doctor.ts probes
// the live environment, this pins the pure logic: station data, tool registry,
// RSS parsing, tracking-URL de-wrapping, AppleScript escaping, arg parsing.
// It never touches the real state.json — everything here is module-level
// constants or pure functions.
import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as radio from "./sources/radio.js";
import * as player from "./player.js";
import { hosts } from "./stations.js";
import { parseArgs } from "./argparse.js";
import { tools } from "./tools.js";
import { parseFeed, embeddedDirectUrl } from "./sources/podcast.js";
import { escapeAS } from "./sources/applemusic.js";
import { describe, now } from "./state.js";

test("station data: every expected genre loads", () => {
  const expected = [
    "jazz", "classical", "indie", "rock", "country", "pop",
    "ambient", "lofi", "soul", "eighties", "world", "house", "techno",
    "kexp", "kcrw", "wfmu", "nts", "wwoz", "paradise", "npr",
  ];
  const got = radio.genres();
  for (const g of expected) assert.ok(got.includes(g), `missing genre: ${g}`);
});

test("hosts() is non-empty and unique", () => {
  // A duplicate only wastes orphan-sweep work, but an EMPTY list would make the
  // sweep a no-op and silently break the "no music survives a stop" guarantee.
  const h = hosts();
  assert.ok(h.length > 0, "hosts() returned empty — stations.json broken?");
  assert.strictEqual(new Set(h).size, h.length, "hosts() has duplicates");
});

test("player detect returns a known value", () => {
  const p = player.playerAvailable();
  assert.ok(p === null || p === "mpv" || p === "ffplay");
});

test("tools registry: every slash command maps to a real tool", () => {
  // Catches typos when adding slash commands.
  const toolNames = new Set(tools.map((t) => t.name));
  for (const required of [
    "radio_list", "radio_play", "radio_next", "radio_prev", "radio_pause",
    "radio_resume", "radio_stop", "radio_now_playing", "radio_volume",
    "spotify_login", "spotify_complete_login", "spotify_list_playlists",
    "spotify_play_playlist", "spotify_search", "spotify_devices", "spotify_transfer",
    "podcast_play", "music_play", "hoer_play", "radio_doctor",
  ]) {
    assert.ok(toolNames.has(required), `tool missing: ${required}`);
  }
});

test("command files invoke registered CLI tools", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const commandDir = join(here, "..", "commands");
  const toolNames = new Set(tools.map((t) => t.name));
  for (const file of readdirSync(commandDir).filter((f) => f.endsWith(".md"))) {
    const body = readFileSync(join(commandDir, file), "utf8").replace(/\r\n/g, "\n");
    const m = body.match(/!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" ([a-z_]+)/);
    assert.ok(m, `${file}: missing CLI invocation`);
    assert.ok(toolNames.has(m[1]), `${file}: invokes missing tool ${m[1]}`);
  }
});

test("podcast: parseFeed handles CDATA, entities, quoting, and missing enclosures", () => {
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
});

test("podcast: parseFeed on a feed with no episodes returns []", () => {
  assert.deepStrictEqual(parseFeed("<rss><channel><title>empty</title></channel></rss>").episodes, []);
});

test("applemusic: escapeAS escapes quotes and backslashes", () => {
  assert.strictEqual(escapeAS(`My "Best" Mix\\2024`), `My \\"Best\\" Mix\\\\2024`);
});

test("podcast: embeddedDirectUrl de-wraps tracking chains", () => {
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
});

test("argparse: number coercion only when the schema says number", () => {
  const numSchema = { type: "object", properties: { level: { type: "number" } } };
  assert.deepStrictEqual(parseArgs(["level=50"], numSchema), { level: 50 });
  assert.deepStrictEqual(parseArgs(["level=abc"], numSchema), { level: "abc" });

  const strSchema = { type: "object", properties: { genre: { type: "string" } } };
  assert.deepStrictEqual(parseArgs(["genre=80"], strSchema), { genre: "80" }); // NOT 80
});

test("argparse: multi-word values, JSON blobs, and stray barewords", () => {
  const targetSchema = { type: "object", properties: { target: { type: "string" } } };
  // Multi-word value folded from bareword follow-ons.
  assert.deepStrictEqual(
    parseArgs(["target=my", "chill", "list"], targetSchema),
    { target: "my chill list" },
  );
  // JSON blob short-circuit.
  const strSchema = { type: "object", properties: { genre: { type: "string" } } };
  assert.deepStrictEqual(parseArgs(['{"genre":"jazz"}'], strSchema), { genre: "jazz" });
  // Barewords before any key are ignored.
  assert.deepStrictEqual(parseArgs(["stray", "target=x"], targetSchema), { target: "x" });
});

test("state/tool edge cases: blank volume is rejected; no source describes as stopped", async () => {
  const volume = tools.find((t) => t.name === "radio_volume");
  assert.ok(volume, "radio_volume tool missing");
  await assert.rejects(() => Promise.resolve(volume.handler({})), /Give a volume 0-100/);
  await assert.rejects(() => Promise.resolve(volume.handler({ level: "" })), /Give a volume 0-100/);

  const prev = { state: now.state, source: now.source };
  try {
    now.state = "playing";
    now.source = null;
    assert.strictEqual(describe(), "Stopped.");
  } finally {
    now.state = prev.state;
    now.source = prev.source;
  }
});
