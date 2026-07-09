#!/usr/bin/env node
// Multi-agent installer. Claude Code installs via its plugin marketplace; every
// other host gets wired up here from the SAME source of truth (commands/*.md +
// dist/), so command coverage can't drift between agents.
//
//   node install.mjs                 # detect installed agents, configure each
//   node install.mjs codex opencode  # configure specific agents
//   node install.mjs --uninstall     # remove everything we wrote
//
// Per agent:
//   codex     ~/.codex/config.toml  [mcp_servers.radiohead]  + ~/.codex/prompts/*.md
//   opencode  ~/.config/opencode/opencode.json mcp.radiohead + ~/.config/opencode/commands/*.md
//   hermes    ~/.hermes/config.yaml mcp_servers.radiohead    (tools only — no custom slash commands)
//   pi        ~/.pi/agent/prompts/*.md + ~/.pi/agent/skills/radiohead/SKILL.md
//             (pi has no MCP: commands shell out to dist/cli.js. No session anchor
//              means no auto-stop on session end — /stop is the off switch.)
//
// Session auto-stop works unchanged on MCP hosts: the stdio server is a child of
// the agent process, so when the agent exits the anchor dies and the watchdog
// kills playback. Nothing here needs to re-implement that.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
// Use forward slashes even on Windows. Node accepts them everywhere, and it
// avoids backslashes being interpreted as escape sequences when these paths are
// embedded in TOML (codex) or YAML (hermes) double-quoted strings — e.g. the
// `\U` in `C:\Users` would otherwise be read as a broken unicode escape.
const toPosix = (p) => p.replace(/\\/g, "/");
const serverJs = toPosix(join(root, "dist", "index.js"));
const cliJs = toPosix(join(root, "dist", "cli.js"));
const home = homedir();

// --- source of truth: parse commands/*.md ----------------------------------
// Each file is Claude-flavored: frontmatter (description) + optional prose +
// one !`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" <tool> [args]` line.
function parseCommand(file) {
  // Normalize CRLF → LF. On Windows, git checks these files out with CRLF
  // endings, which would break the \n-anchored frontmatter/invocation regexes
  // below and silently yield zero commands (leaving every host with only the
  // MCP server and no slash commands).
  const raw = readFileSync(join(root, "commands", file), "utf8").replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const description = (m[1].match(/^description:\s*(.+)$/m) ?? [])[1]?.trim() ?? "";
  const body = m[2].trim();
  const inv = body.match(/!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/cli\.js" ([a-z_]+)((?: \S+)*)`/);
  if (!inv) return null;
  const prose = body.replace(inv[0], "").trim();
  return { name: file.replace(/\.md$/, ""), description, tool: inv[1], args: inv[2].trim(), prose };
}
const commands = readdirSync(join(root, "commands"))
  .filter((f) => f.endsWith(".md"))
  .map(parseCommand)
  .filter(Boolean);

// Rebuild the concrete CLI invocation with an absolute path for hosts that run
// it via their own shell-injection or bash tool.
const cliCall = (c) => `node "${cliJs}" ${c.tool}${c.args ? " " + c.args : ""}`;

// Natural-language phrasing of a command for prompt-style hosts (codex, pi)
// where the file body is a prompt to the model, not an executed template.
function promptText(c, how) {
  const lines = [];
  if (c.prose) lines.push(c.prose, "");
  lines.push(`${c.description}. ${how}`, "", "Then tell the user the result in one short line.");
  return lines.join("\n") + "\n";
}

function report(action, path) {
  process.stdout.write(`  ${action}  ${path.replace(home, "~")}\n`);
}

function writeGenerated(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  report("write", path);
}
function removeIfOurs(path) {
  if (!existsSync(path)) return;
  unlinkSync(path);
  report("remove", path);
}

// --- codex ------------------------------------------------------------------
const codexDir = join(home, ".codex");
function installCodex(un) {
  const cfg = join(codexDir, "config.toml");
  const header = "[mcp_servers.radiohead]";
  let toml = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  if (un) {
    // Drop our table: from the header up to (not including) the next table
    // header at start-of-line, or end of file. `[` inside a value (e.g. an
    // args array) must not terminate the match.
    const next = toml.replace(/\n?\[mcp_servers\.radiohead\][\s\S]*?(?=\n\[|$)/, "");
    if (next !== toml) { writeFileSync(cfg, next); report("edit ", cfg); }
    for (const c of commands) removeIfOurs(join(codexDir, "prompts", `${c.name}.md`));
    return;
  }
  if (!toml.includes(header)) {
    const block = `${toml.endsWith("\n") || toml === "" ? "" : "\n"}\n${header}\ncommand = "node"\nargs = ["${serverJs}"]\n`;
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(cfg, toml + block);
    report("edit ", cfg);
  }
  for (const c of commands) {
    const how = c.args.includes("$ARGUMENTS")
      ? `Call the \`${c.tool}\` tool from the radiohead MCP server with \`${c.args.replace("$ARGUMENTS", "<value>")}\`, where <value> is: $ARGUMENTS`
      : `Call the \`${c.tool}\` tool from the radiohead MCP server${c.args ? ` with \`${c.args}\`` : ""}`;
    writeGenerated(join(codexDir, "prompts", `${c.name}.md`), promptText(c, how));
  }
}

// --- opencode ----------------------------------------------------------------
const opencodeDir = join(home, ".config", "opencode");
function installOpencode(un) {
  const cfg = join(opencodeDir, "opencode.json");
  let json = {};
  if (existsSync(cfg)) {
    try { json = JSON.parse(readFileSync(cfg, "utf8")); }
    catch {
      process.stdout.write(`  skip  ${cfg} is not valid JSON — add this yourself:\n` +
        `        "mcp": { "radiohead": { "type": "local", "command": ["node", "${serverJs}"], "enabled": true } }\n`);
      json = null;
    }
  }
  if (un) {
    if (json?.mcp?.radiohead) {
      delete json.mcp.radiohead;
      if (Object.keys(json.mcp).length === 0) delete json.mcp;
      writeFileSync(cfg, JSON.stringify(json, null, 2) + "\n");
      report("edit ", cfg);
    }
    for (const c of commands) removeIfOurs(join(opencodeDir, "commands", `${c.name}.md`));
    return;
  }
  if (json) {
    json.$schema ??= "https://opencode.ai/config.json";
    json.mcp = { ...json.mcp, radiohead: { type: "local", command: ["node", serverJs], enabled: true } };
    mkdirSync(opencodeDir, { recursive: true });
    writeFileSync(cfg, JSON.stringify(json, null, 2) + "\n");
    report("edit ", cfg);
  }
  // opencode supports the same !`cmd` shell injection as Claude Code, so the
  // command bodies stay deterministic instead of prompting the model.
  for (const c of commands) {
    const body = `---\ndescription: ${c.description}\n---\n${c.prose ? c.prose + "\n\n" : ""}!\`${cliCall(c)}\`\n`;
    writeGenerated(join(opencodeDir, "commands", `${c.name}.md`), body);
  }
}

// --- hermes -------------------------------------------------------------------
const hermesDir = join(home, ".hermes");
function installHermes(un) {
  const cfg = join(hermesDir, "config.yaml");
  const ours = `  radiohead:\n    command: "node"\n    args: ["${serverJs}"]\n`;
  let yaml = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  if (un) {
    const next = yaml.replace(ours, "");
    if (next !== yaml) { writeFileSync(cfg, next); report("edit ", cfg); }
    return;
  }
  if (yaml.match(/^\s{2}radiohead:/m)) return; // already configured
  if (yaml.match(/^mcp_servers:/m)) {
    // Insert our entry directly under the existing top-level key. Anything more
    // surgical needs a YAML parser; if the file uses a layout this misses,
    // hermes will complain on startup and the snippet below still applies.
    yaml = yaml.replace(/^mcp_servers:\s*\n/m, (s) => s + ours);
  } else {
    yaml += `${yaml.endsWith("\n") || yaml === "" ? "" : "\n"}mcp_servers:\n${ours}`;
  }
  mkdirSync(hermesDir, { recursive: true });
  writeFileSync(cfg, yaml);
  report("edit ", cfg);
}

// --- pi -----------------------------------------------------------------------
const piDir = join(home, ".pi", "agent");
function installPi(un) {
  const skillDir = join(piDir, "skills", "radiohead");
  if (un) {
    for (const c of commands) removeIfOurs(join(piDir, "prompts", `${c.name}.md`));
    if (existsSync(skillDir)) { rmSync(skillDir, { recursive: true }); report("remove", skillDir); }
    return;
  }
  for (const c of commands) {
    const how = `Run this with the bash tool:\n\n\`\`\`\n${cliCall(c)}\n\`\`\`` +
      (c.args.includes("$ARGUMENTS")
        ? "\n\nReplace $ARGUMENTS with the value from my message (ask me if it's missing)."
        : "");
    writeGenerated(join(piDir, "prompts", `${c.name}.md`), promptText(c, how));
  }
  const toolLines = commands
    .map((c) => `| \`${c.tool}${c.args ? " " + c.args : ""}\` | ${c.description} |`)
    .join("\n");
  writeGenerated(join(skillDir, "SKILL.md"), `---
name: radiohead
description: Play internet radio (jazz, lofi, techno, KEXP, NTS…) and control Spotify from the terminal. Use when the user asks to play, pause, stop, or switch music.
---

# radiohead

Every action is one CLI call (no server needed):

\`\`\`
node "${cliJs}" <tool> [key=value ...]
\`\`\`

| Tool | Does |
|---|---|
${toolLines}

Notes:
- Genres for \`radio_play\`: jazz, classical, indie, rock, country, pop, ambient, lofi, soul, eighties, world, house, techno, kexp, kcrw, wfmu, nts, wwoz, paradise.
- pi has no session anchor, so music does NOT stop when the session ends — run \`radio_stop\` when the user is done.
- Spotify tools need SPOTIFY_CLIENT_ID exported and a Premium account.
`);
}

// --- main -----------------------------------------------------------------------
const agents = {
  codex: { dir: codexDir, run: installCodex },
  opencode: { dir: opencodeDir, run: installOpencode },
  hermes: { dir: hermesDir, run: installHermes },
  pi: { dir: join(home, ".pi"), run: installPi },
};

const argv = process.argv.slice(2);
const un = argv.includes("--uninstall");
const named = argv.filter((a) => !a.startsWith("--"));
for (const a of named) {
  if (!agents[a]) {
    console.error(`Unknown agent: ${a}. Choose from: ${Object.keys(agents).join(", ")}`);
    process.exit(1);
  }
}
if (!existsSync(serverJs) && !un) {
  console.error("dist/ is missing — run `npm install && npm run build` first.");
  process.exit(1);
}

// No agents named → configure every agent whose config dir already exists.
const targets = named.length > 0 ? named : Object.keys(agents).filter((a) => existsSync(agents[a].dir));
if (targets.length === 0) {
  console.error("No supported agents detected (looked for ~/.codex, ~/.config/opencode, ~/.hermes, ~/.pi).");
  console.error("Run `node install.mjs <codex|opencode|hermes|pi>` to force one.");
  process.exit(1);
}
for (const t of targets) {
  process.stdout.write(`${un ? "Removing from" : "Configuring"} ${t}:\n`);
  agents[t].run(un);
}
process.stdout.write(un ? "Done.\n" : "Done. Restart the agent(s) to pick up the changes.\n");
