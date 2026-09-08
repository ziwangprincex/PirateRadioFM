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
import { readFileSync, readdirSync, existsSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { managedFiles } from "./install-files.mjs";

const root = dirname(fileURLToPath(import.meta.url));
// Use forward slashes even on Windows. Node accepts them everywhere, and it
// avoids backslashes being interpreted as escape sequences when these paths are
// embedded in TOML (codex) or YAML (hermes) double-quoted strings — e.g. the
// `\U` in `C:\Users` would otherwise be read as a broken unicode escape.
const toPosix = (p) => p.replace(/\\/g, "/");
const serverJs = toPosix(join(root, "dist", "index.js"));
const cliJs = toPosix(join(root, "dist", "cli.js"));
// Absolute interpreter path, not a bare "node". An agent launched from
// Finder/Dock inherits the default PATH (/usr/bin:/bin:...), which does not
// include nvm, homebrew, fnm or volta — so a bare "node" fails with ENOENT and
// the MCP server silently never starts, with nothing to explain why. We already
// write absolute paths for serverJs/cliJs; the interpreter deserves the same.
const nodeBin = toPosix(process.execPath);
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

// Genre list for radio_play, derived from the SAME station data the runtime
// uses — so it never drifts out of sync when a station is added (the previous
// hand-typed list had silently dropped "npr"). Falls back to empty on a missing
// or corrupt file rather than aborting the install.
let radioGenres = "";
try {
  const catalog = JSON.parse(readFileSync(join(root, "data", "stations.json"), "utf8"));
  radioGenres = [...Object.keys(catalog.genres ?? {}), ...Object.keys(catalog.aliases ?? {})].join(", ");
} catch {
  /* leave empty — the note just omits the explicit list */
}

// Rebuild the concrete CLI invocation with an absolute path for hosts that run
// it via their own shell-injection or bash tool.
const cliCall = (c) => `"${nodeBin}" "${cliJs}" ${c.tool}${c.args ? " " + c.args : ""}`;

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

const managed = managedFiles(home, report);
const writeGenerated = managed.write;
const removeIfOurs = managed.remove;

// --- codex ------------------------------------------------------------------
const codexDir = join(home, ".codex");
function installCodex(un) {
  const cfg = join(codexDir, "config.toml");
  const toml = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  const pattern = /^\[mcp_servers\.radiohead\][^\S\r\n]*\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/m;
  const current = toml.match(pattern)?.[0];
  const unsupported = current === undefined && /^[ \t]*\[[^\r\n]*radiohead/m.test(toml);
  const key = `${cfg}#mcp_servers.radiohead`;
  const desired = `[mcp_servers.radiohead]\ncommand = ${JSON.stringify(nodeBin)}\nargs = [${JSON.stringify(serverJs)}]\n`;
  if (un) {
    if (current !== undefined && managed.mayChange(key, current)) {
      managed.writeConfig(cfg, toml.replace(pattern, ""));
      managed.remember(key, undefined);
    }
    for (const c of commands) removeIfOurs(join(codexDir, "prompts", `${c.name}.md`));
    return;
  }
  if (unsupported) report("skip (unsupported TOML layout)", cfg);
  else if (managed.mayChange(key, current)) {
    managed.writeConfig(cfg, current === undefined
      ? toml + (toml.endsWith("\n") || !toml ? "" : "\n") + desired
      : toml.replace(pattern, () => desired));
    managed.remember(key, desired);
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
        `        "mcp": { "radiohead": { "type": "local", "command": ["${nodeBin}", "${serverJs}"], "enabled": true } }\n`);
      json = null;
    }
  }
  const key = `${cfg}#mcp.radiohead`;
  const current = json?.mcp?.radiohead;
  const encoded = current === undefined ? undefined : JSON.stringify(current);
  if (un) {
    if (current !== undefined && managed.mayChange(key, encoded)) {
      delete json.mcp.radiohead;
      if (Object.keys(json.mcp).length === 0) delete json.mcp;
      managed.writeConfig(cfg, JSON.stringify(json, null, 2) + "\n");
      managed.remember(key, undefined);
    }
    for (const c of commands) removeIfOurs(join(opencodeDir, "commands", `${c.name}.md`));
    return;
  }
  if (json && managed.mayChange(key, encoded)) {
    const entry = { type: "local", command: [nodeBin, serverJs], enabled: true };
    json.$schema ??= "https://opencode.ai/config.json";
    json.mcp = { ...json.mcp, radiohead: entry };
    managed.writeConfig(cfg, JSON.stringify(json, null, 2) + "\n");
    managed.remember(key, JSON.stringify(entry));
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
  const ours = `  radiohead:\n    command: ${JSON.stringify(nodeBin)}\n    args: [${JSON.stringify(serverJs)}]\n`;
  let yaml = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
  const key = `${cfg}#mcp_servers.radiohead`;
  const section = yaml.match(/^mcp_servers:[^\S\r\n]*\r?\n[\s\S]*?(?=^[^\s#]|(?![\s\S]))/m)?.[0];
  const pattern = /^  radiohead:[^\S\r\n]*\r?\n[\s\S]*?(?=^  [^\s#]|(?![\s\S]))/m;
  const current = section?.match(pattern)?.[0];
  const unsupported = /^mcp_servers:/m.test(yaml) && section === undefined
    || current === undefined && /^[ \t]+[^\r\n]*radiohead/m.test(section ?? "");
  if (un) {
    if (current !== undefined && managed.mayChange(key, current)) {
      managed.writeConfig(cfg, yaml.replace(section, () => section.replace(pattern, "")));
      managed.remember(key, undefined);
    }
    return;
  }
  if (unsupported) { report("skip (unsupported YAML layout)", cfg); return; }
  if (!managed.mayChange(key, current)) return;
  if (current !== undefined) yaml = yaml.replace(section, () => section.replace(pattern, () => ours));
  else if (/^mcp_servers:/m.test(yaml)) {
    if (!/^mcp_servers:[^\S\r\n]*\r?\n/m.test(yaml)) {
      report("skip (unsupported YAML layout)", cfg);
      return;
    }
    yaml = yaml.replace(/^mcp_servers:[^\S\r\n]*\r?\n/m, (line) => line + ours);
  } else {
    yaml += `${yaml.endsWith("\n") || !yaml ? "" : "\n"}mcp_servers:\n${ours}`;
  }
  managed.writeConfig(cfg, yaml);
  managed.remember(key, ours);
}

// --- pi -----------------------------------------------------------------------
const piDir = join(home, ".pi", "agent");
function installPi(un) {
  const skillDir = join(piDir, "skills", "radiohead");
  if (un) {
    for (const c of commands) removeIfOurs(join(piDir, "prompts", `${c.name}.md`));
    removeIfOurs(join(skillDir, "SKILL.md"));
    try { rmdirSync(skillDir); } catch { /* preserve extra user files */ }
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
"${nodeBin}" "${cliJs}" <tool> [key=value ...]
\`\`\`

| Tool | Does |
|---|---|
${toolLines}

Notes:
${radioGenres ? `- Genres for \`radio_play\`: ${radioGenres}.` : "- Genres for `radio_play`: run `radio_list` to see available genres."}
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
