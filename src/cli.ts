#!/usr/bin/env node
// pirate-radio argv entry. Invoked by each slash command as `node dist/cli.js <tool> [json-args]`.
// This replaces the MCP stdio server for slash-command use: no protocol handshake,
// no LLM tool selection — deterministic mapping from argv to a tool handler.
import { tools } from "./tools.js";
import { saveState, withState } from "./state.js";
import { parseArgs } from "./argparse.js";
import { doctor } from "./doctor.js";

async function main(): Promise<void> {
  const [, , toolName, ...rest] = process.argv;
  if (!toolName) {
    console.error("Usage: cli.js <tool-name> [json-args]");
    console.error("Available tools: " + tools.map((t) => t.name).join(", "));
    process.exit(1);
  }

  // `doctor` / `radio_doctor` is a read-only environment probe: no state
  // mutation, so it skips withState (and its lock) entirely. It also owns the
  // process exit code so a blocking problem is scriptable (e.g. in CI / a shell
  // `&&` chain). Keep the short alias for humans and the registered tool name
  // for generated command prompts.
  if (toolName === "doctor" || toolName === "radio_doctor") {
    const report = await doctor();
    process.stdout.write(report + "\n");
    process.exit(report.includes("✗") ? 1 : 0);
  }

  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    console.error(`Unknown tool: ${toolName}`);
    console.error("Available: " + tools.map((t) => t.name).join(", "));
    process.exit(1);
  }

  let args: Record<string, unknown>;
  try {
    args = parseArgs(rest, tool.schema);
  } catch {
    // Malformed JSON blob — report it like any other usage error instead of
    // letting the raw SyntaxError stack trace hit the user.
    console.error(`Error: could not parse arguments: ${rest.join(" ")}`);
    process.exit(1);
  }

  try {
    const out = await withState(() => tool.handler(args));
    process.stdout.write(out + "\n");
  } catch (e) {
    // Persist any partial state changes (e.g. verifier written before a failed
    // fetch) — withState released the lock without saving on throw.
    try { saveState(); } catch { /* ignore */ }
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
