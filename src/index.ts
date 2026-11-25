#!/usr/bin/env node
// radiohead MCP server. stdio transport — works with Claude Code, Codex, OpenCode, Hermes.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, runTool } from "./tools.js";
import { loadState, saveState, clearAnchor, readAnchor, now } from "./state.js";
import { stopSync } from "./player.js";
import { killPid, killSameProcess, findOrphanPlayers } from "./proc.js";
import { claimAnchor, playerMarker, type Anchor } from "./session.js";
import { readRegistryUnsafe } from "./lock.js";
import { registryPath, owned } from "./registry.js";

// This server process is a child of the Claude Code session. Record its PID +
// start-token as the "anchor": the detached watchdog spawned by the player polls
// it, so when this process dies (session closed / terminal shut / hard kill) the
// music is stopped even though a SessionEnd hook is not guaranteed to fire.
loadState();

// Startup orphan sweep: if a PREVIOUS session's anchor is dead (crash, hard kill,
// watchdog also killed) any music it started may still be playing. Clear it out
// before we take over, so a new session never inherits a stuck stream.
let ourAnchor: Anchor;
try {
  ourAnchor = claimAnchor((old) => {
    stopSync(old?.sessionId ?? "legacy");
    now.state = "stopped";
    now.source = null;
    now.spotifyVerifier = null;
    now.revision++;
    saveState();
  });
} catch (e) {
  process.stderr.write(`radiohead: ${(e as Error).message}. Refusing to start.\n`);
  process.exit(2);
}

// Clean-exit fast path: when the server shuts down gracefully, stop the music
// and clear the anchor ourselves instead of waiting for the watchdog's poll.
//
// Exit callbacks cannot await effect/session locks. Check ownership and use
// lock-free registry reads; leave persisted state to the next atomic startup.
let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    // Kill registered players/watchdogs without taking the registry lock.
    const current = readAnchor();
    if (current?.sessionId !== ourAnchor.sessionId || current?.pid !== process.pid) return;
    const raw = readRegistryUnsafe(registryPath());
    const reg = { players: raw.players.filter((p) => owned(p, ourAnchor.sessionId)), watchdogs: raw.watchdogs.filter((w) => owned(w, ourAnchor.sessionId)) };
    for (const p of reg.players) killSameProcess(p.pid, p.token);
    for (const w of reg.watchdogs) killSameProcess(w.pid, w.token);
    // Orphan sweep (no lock needed — it's a read + kill).
    for (const pid of findOrphanPlayers(playerMarker(ourAnchor.sessionId))) killPid(pid);
    clearAnchor(ourAnchor);
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
  { name: "radiohead", version: "0.2.3" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  armStdinClose();
  return {
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
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
  // Requests resolve outside the state lock, then validate and commit their intent.
  try {
    const out = await runTool(tool.name, req.params.arguments ?? {}, extra.signal);
    return { content: [{ type: "text", text: out }] };
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
