#!/usr/bin/env node
// radiohead MCP server. stdio transport — works with Claude Code, Codex, OpenCode, Hermes.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools } from "./tools.js";
import { loadState, saveState, writeAnchor, clearAnchor, readAnchor, anchorAlive, withState, now, statePath as getStatePath } from "./state.js";
import { stop } from "./player.js";
import { killPid, findOrphanPlayers } from "./proc.js";
import { sweepHosts } from "./dynhosts.js";
import { readRegistryUnsafe, saveStateUnsafe } from "./lock.js";
import { registryPath } from "./registry.js";

// This server process is a child of the Claude Code session. Record its PID +
// start-token as the "anchor": the detached watchdog spawned by the player polls
// it, so when this process dies (session closed / terminal shut / hard kill) the
// music is stopped even though a SessionEnd hook is not guaranteed to fire.
loadState();

// Startup orphan sweep: if a PREVIOUS session's anchor is dead (crash, hard kill,
// watchdog also killed) any music it started may still be playing. Clear it out
// before we take over, so a new session never inherits a stuck stream.
const prevAnchor = readAnchor();
if (prevAnchor && anchorAlive(prevAnchor)) {
  // Another radiohead MCP server is already running under a live session.
  // Sharing state.json / players.json / anchor.json across two of them causes
  // cross-session kills (each watchdog would eventually manage the other's
  // players). Better to fail loudly than to silently break both.
  process.stderr.write(
    `radiohead: another server is already running (pid ${prevAnchor.pid}). ` +
      `Refusing to start a second instance.\n`,
  );
  process.exit(2);
}
if (prevAnchor && !anchorAlive(prevAnchor)) {
  stop(); // kills registered players + host orphans from the dead session
  clearAnchor();
  // Reset in-memory (and later, on-disk) state: the previous session left it
  // showing "playing/radio/jazz" but nothing is actually playing anymore, and
  // any half-finished spotify_login flow's PKCE verifier is now unusable.
  now.state = "stopped";
  now.source = null;
  now.spotifyVerifier = null;
  // Persist immediately. Otherwise the first tool call in the new session would
  // fresh-load the stale "playing" state and undo this cleanup.
  saveState();
}

writeAnchor(process.pid);

// Clean-exit fast path: when the server shuts down gracefully, stop the music
// and clear the anchor ourselves instead of waiting for the watchdog's poll.
//
// CRITICAL: this MUST NOT acquire any lock. When a signal/stdin-close arrives
// mid-tool-call, the state lock is held by THIS process on the same thread. Any
// attempt to re-acquire it (even via a different code path) will Atomics.wait
// for 30s, block the event loop, prevent the in-flight handler from ever
// releasing, and self-deadlock — leaving clearAnchor unreachable and the
// watchdog unable to detect the session death. Instead, read/write files
// directly (best-effort, no atomicity guarantee — acceptable at exit time).
let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    // Kill registered players/watchdogs without taking the registry lock.
    const reg = readRegistryUnsafe(registryPath());
    for (const p of reg.players) killPid(p.pid);
    for (const w of reg.watchdogs) killPid(w.pid);
    // Orphan sweep (no lock needed — it's a read + kill).
    for (const pid of findOrphanPlayers(sweepHosts())) killPid(pid);
    // Best-effort state save without lock.
    now.state = "stopped";
    now.source = null;
    saveStateUnsafe(getStatePath(), now);
    clearAnchor();
  } catch {
    // Best effort on the way out. The watchdog is our backup.
  }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { cleanup(); process.exit(0); });
}
// Claude Code shuts an MCP server down by closing its stdio, NOT by sending a
// signal. Without this, the process can linger after the session ends — the
// watchdog then sees the anchor PID "alive" and never stops the music. cleanup()
// is idempotent, so double-firing with the signal handlers is fine.
//
// We arm this ONLY after the first tool call. Reason: `node dist/index.js
// < /dev/null` (developer smoke tests) would otherwise see stdin close during
// startup and cleanup+exit before the server ever handled anything.
let stdinArmed = false;
function armStdinClose(): void {
  if (stdinArmed) return;
  stdinArmed = true;
  process.stdin.on("end", () => { cleanup(); process.exit(0); });
  process.stdin.on("close", () => { cleanup(); process.exit(0); });
}

const server = new Server(
  { name: "radiohead", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  armStdinClose();
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  armStdinClose();
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  if (tool.name === "radio_doctor") {
    try {
      const out = await tool.handler(req.params.arguments ?? {});
      return { content: [{ type: "text", text: out }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
  // withState holds the state lock across the whole handler: it fresh-loads on
  // entry (picking up any CLI writes since our last call) and atomically saves
  // on exit. That way concurrent CLI + MCP writers can't lost-update each
  // other's fields.
  try {
    const out = await withState(() => tool.handler(req.params.arguments ?? {}));
    return { content: [{ type: "text", text: out }] };
  } catch (e) {
    // withState now saves state on rejection, so partial mutations (e.g.
    // spotifyVerifier, volume) are persisted. No fallback saveState() needed.
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
