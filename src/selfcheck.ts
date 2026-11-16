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
import { acceptedGenres, catalogVersion, hosts, resolveGenre } from "./stations.js";
import { parseArgs } from "./argparse.js";
import { tools } from "./tools.js";
import { parseFeed, embeddedDirectUrl, locateEpisode } from "./sources/podcast.js";
import { authorizationCode, spotifyErrorMessage } from "./sources/spotify.js";
import { escapeAS } from "./sources/applemusic.js";
import { describe, now } from "./state.js";

test("station catalog: exact genres, aliases, and schema version", () => {
  const expected = [
    "jazz", "classical", "indie", "covers", "rock", "metal", "country", "pop",
    "ambient", "chill", "soul", "lounge", "eighties", "world", "folk", "house",
    "techno", "bass", "kexp", "kcrw", "wfmu", "nts", "wwoz", "paradise", "public",
  ];
  assert.strictEqual(catalogVersion(), 2);
  assert.deepStrictEqual(radio.genres(), expected);
  assert.strictEqual(resolveGenre("lofi"), "chill");
  assert.strictEqual(resolveGenre("npr"), "public");
  assert.ok(acceptedGenres().includes("lofi"));
  assert.ok(acceptedGenres().includes("npr"));
});

test("hosts() is non-empty and unique", () => {
  // Used by /doctor's summary and the station health check. Process cleanup
  // never matches hosts (see the next test), so this only guards catalog data.
  const h = hosts();
  assert.ok(h.length > 0, "hosts() returned empty — stations.json broken?");
  assert.strictEqual(new Set(h).size, h.length, "hosts() has duplicates");
});

test("all orphan sweep sites require a session-specific marker, never a host", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  for (const file of ["player.ts", "watchdog.ts", "index.ts"]) {
    const body = readFileSync(join(src, file), "utf8");
    assert.match(body, /findOrphanPlayers\(playerMarker\(/);
    assert.ok(!/\bhosts\(\)/.test(body), `${file}: cleanup must not match stream hosts`);
  }
});

test("player detect returns a known value", () => {
  const p = player.playerAvailable();
  assert.ok(p === null || p === "mpv" || p === "ffplay");
});

test("player: icyTitle keeps real songs and drops empty or self-announcing titles", () => {
  // Shapes observed from the bundled stations through mpv's metadata property.
  assert.strictEqual(player.icyTitle({ "icy-name": "Groove Salad", "icy-title": "Kick Bong - Just You And Me" }, "SomaFM Groove Salad"), "Kick Bong - Just You And Me");
  assert.strictEqual(player.icyTitle({ "ICY-Title": "  Talk Talk -  It's My Life " }, "WFUV 90.7 New York"), "Talk Talk - It's My Life");
  assert.strictEqual(player.icyTitle({ "icy-title": "" }, "KEXP 90.3 Seattle"), null);
  assert.strictEqual(player.icyTitle({ "icy-title": " - " }, null), null);
  assert.strictEqual(player.icyTitle({ "icy-title": "The Current-" }, "The Current 89.3 (Minnesota Public Radio)"), null);
  assert.strictEqual(player.icyTitle({ "icy-title": "Radio Swiss Jazz - www.radioswissjazz.ch" }, "Radio Swiss Jazz"), null);
  assert.strictEqual(player.icyTitle({ "icy-name": "NTS 1" }, "NTS 1 London"), null);
  assert.strictEqual(player.icyTitle("property unavailable", "NTS 1 London"), null);
  assert.strictEqual(player.icyTitle(null), null);
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
    const m = body.match(/!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" ([a-z_]+)/) ??
      body.match(/```!\nnode "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" ([a-z_]+) --stdin=[a-z]+ <<'PIRATE_RADIO_ARGS'\n\$ARGUMENTS\nPIRATE_RADIO_ARGS\n```/);
    assert.ok(m, `${file}: missing CLI invocation`);
    assert.ok(toolNames.has(m[1]), `${file}: invokes missing tool ${m[1]}`);
    // Claude Code substitutes $ARGUMENTS as typed (no shell escaping): user
    // text may only reach the shell through the quoted heredoc above.
    assert.ok(!/!`[^`]*\$ARGUMENTS/.test(body), `${file}: $ARGUMENTS inlined into shell`);
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

test("podcast: parseFeed ignores an item cut off by feed truncation", () => {
  const head = `<rss><channel><title>Big</title>
    <item><title>New</title><enclosure url="https://cdn.example.com/2.mp3"/></item>
    <item><title>Old</title><enclosure url="https://cdn.exa`;
  const parsed = parseFeed(head);
  assert.strictEqual(parsed.channel, "Big");
  assert.deepStrictEqual(parsed.episodes, [{ title: "New", url: "https://cdn.example.com/2.mp3" }]);
});

test("podcast: parseFeed decodes numeric entities exactly once", () => {
  const parsed = parseFeed(`<rss><channel><title>Caf&#233; &#x26; Co</title>
    <item><title>What&#8217;s new &amp;lt;live&amp;gt;</title>
      <enclosure url="https://cdn.example.com/a.mp3?x=1&amp;y=2"/></item></channel></rss>`);
  assert.strictEqual(parsed.channel, "Café & Co");
  assert.strictEqual(parsed.episodes[0].title, "What’s new &lt;live&gt;");
  assert.strictEqual(parsed.episodes[0].url, "https://cdn.example.com/a.mp3?x=1&y=2");
});

test("podcast: stepping follows the current episode when the feed gains new ones", () => {
  const eps = (...titles: string[]) => titles.map((title) => ({ title, url: `https://cdn.example.com/${title}.mp3` }));
  // Was playing "B" at index 1; a new episode "N" was published since.
  assert.strictEqual(locateEpisode(eps("N", "A", "B", "C"), "B", 1), 2);
  // Duplicate titles resolve to the occurrence nearest the saved index.
  assert.strictEqual(locateEpisode(eps("X", "B", "Y", "B"), "B", 3), 3);
  // Unknown title (renamed/removed) falls back to the saved index.
  assert.strictEqual(locateEpisode(eps("A", "B"), "gone", 1), 1);
  assert.strictEqual(locateEpisode(eps("A", "B"), null, 0), 0);
});

test("spotify: authorization code is accepted bare or inside the pasted redirect URL", () => {
  assert.strictEqual(authorizationCode("AQBx-y_z"), "AQBx-y_z");
  assert.strictEqual(authorizationCode("http://127.0.0.1:8888/callback?code=AQBx-y_z&state=1"), "AQBx-y_z");
  assert.strictEqual(authorizationCode("code=AQBx-y_z"), "AQBx-y_z");
  assert.throws(() => authorizationCode("http://127.0.0.1:8888/callback?error=access_denied"), /access_denied/);
});

test("spotify: 403 reports Spotify's reason instead of always blaming Premium", () => {
  assert.match(spotifyErrorMessage(403, JSON.stringify({ error: { status: 403, message: "Player command failed: Premium required", reason: "PREMIUM_REQUIRED" } })), /Premium is required/);
  const restricted = spotifyErrorMessage(403, JSON.stringify({ error: { status: 403, message: "Player command failed: Restriction violated", reason: "UNKNOWN" } }));
  assert.match(restricted, /Restriction violated/);
  assert.doesNotMatch(restricted, /Premium/);
  assert.match(spotifyErrorMessage(500, "<html>oops</html>"), /Spotify API 500: <html>oops/);
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

test("version is identical in package.json, plugin.json and the MCP server", () => {
  // Releases bump all three by hand; this turns a forgotten one into a failure.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
  const server = readFileSync(join(root, "src", "index.ts"), "utf8").match(/name: "radiohead", version: "([^"]+)"/)?.[1];
  assert.strictEqual(plugin, pkg);
  assert.strictEqual(server, pkg);
});
