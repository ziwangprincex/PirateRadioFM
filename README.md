<p align="center"><img src="assets/banner.png" alt="PirateRadioFM — internet radio in your CLI" width="100%"></p>

# PirateRadioFM

Play internet radio, podcasts, Spotify, and Apple Music from a CLI coding agent.

[中文文档](./README.zh-CN.md)

## Install (Claude Code)

Requires Node.js 20+ and `mpv` (or `ffplay`):

- Windows: `winget install mpv`
- macOS: `brew install mpv`
- Linux: `sudo apt install mpv`

```bash
claude plugin marketplace add ziwangprincex/PirateRadioFM
claude plugin install radiohead@radiohead
```

Restart Claude Code. Type `/` in a new session to see the commands.

Uninstall:

```bash
claude plugin uninstall radiohead
claude plugin marketplace remove radiohead
```

## Install (Codex / OpenCode / Hermes / pi)

```bash
git clone https://github.com/ziwangprincex/PirateRadioFM
cd PirateRadioFM
node install.mjs
```

With no arguments it configures every agent found on the machine. To pick one:
`node install.mjs codex` (or `opencode`, `hermes`, `pi`). To remove everything
it wrote: `node install.mjs --uninstall`. Restart the agent after installing.

What it writes:

- Codex: MCP server in `~/.codex/config.toml`, prompts in `~/.codex/prompts/`
- OpenCode: MCP server in `~/.config/opencode/opencode.json`, commands in `~/.config/opencode/commands/`
- Hermes: MCP server in `~/.hermes/config.yaml`
- pi: prompt templates in `~/.pi/agent/prompts/`, skill in `~/.pi/agent/skills/radiohead/`

pi does not support MCP, so its commands call `dist/cli.js` directly.

## Commands

### Genre stations

| Command | Plays |
|---|---|
| `/jazz` | Jazz |
| `/classical` | Classical |
| `/indie` | Indie pop / alternative |
| `/covers` | Cover versions |
| `/rock` | Classic / album rock |
| `/metal` | Metal |
| `/country` | Country / Americana |
| `/pop` | Pop / electropop |
| `/ambient` | Ambient / drone / space music |
| `/chill` | Chill / downtempo (`/lofi` remains as an alias) |
| `/soul` | Vintage soul |
| `/lounge` | Lounge / exotica |
| `/eighties` | 80s synthpop / new wave |
| `/world` | Celtic and South Asian-influenced world music |
| `/folk` | Indie / alternative folk |
| `/house` | Progressive / deep house |
| `/techno` | Techno / IDM |
| `/bass` | Dubstep / dub / deep bass |

### DJ / public stations

| Command | Station |
|---|---|
| `/kexp` | KEXP 90.3 Seattle |
| `/kcrw` | KCRW Eclectic24, Los Angeles |
| `/wfmu` | WFMU freeform, New Jersey |
| `/nts` | NTS London |
| `/wwoz` | WWOZ New Orleans, jazz & blues |
| `/paradise` | Radio Paradise |
| `/public` | US public music radio — The Current, WXPN, KUTX, WFUV (`/next` cycles; `/npr` remains as an alias) |
| `/hoer` | HÖR Berlin — live DJ stream when on air, latest set otherwise ([setup](./docs/sources.md#hör-berlin)) |

### Playback control

| Command | What it does |
|---|---|
| `/play` | Play jazz radio, or resume if paused |
| `/pause` | Pause |
| `/resume` | Resume |
| `/stop` | Stop. Unlike pause, this can't be resumed |
| `/next` | Next station / channel / track |
| `/prev` | Previous station / channel / track |
| `/volume <0-100>` | Set volume |
| `/now-playing` | Show what's playing |
| `/doctor` | Diagnose playback problems (player, yt-dlp, Spotify, streams) |

`/nts`, `/paradise`, and `/public` have several channels; `/next` cycles through them.

### Podcasts & streaming

| Command | What it does |
|---|---|
| `/podcast <name-or-rss-url>` | Play a podcast's newest episode (searched on iTunes, no login); `/next`/`/prev` step through episodes |
| `/music <name>` | Play a playlist/song/album from your Apple Music library (macOS only) |
| `/spotify-play <anything>` | Play a track/album/playlist/show on your Spotify client (Premium + setup) |
| `/spotify-search <query>` | Search the Spotify catalog |
| `/spotify-devices` / `/spotify-device <name>` | List Spotify devices / move playback |

Spotify needs a one-time setup (developer app + login); details and limits for
all sources are in [docs/sources.md](./docs/sources.md).

Plain language also works: "play some jazz", "switch station", "stop the music".

To audit every bundled stream URL manually, run `npm run check:stations`. This network check is intentionally separate from the normal test suite.
