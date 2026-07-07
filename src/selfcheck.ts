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

// --- station data ----------------------------------------------------------
const expected = [
  "jazz", "classical", "indie", "rock", "country", "pop",
  "ambient", "lofi", "soul", "eighties", "world", "house", "techno",
  "kexp", "kcrw", "wfmu", "nts", "wwoz", "paradise",
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
  "spotify_play_playlist",
]) {
  assert.ok(toolNames.has(required), `tool missing: ${required}`);
}

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
