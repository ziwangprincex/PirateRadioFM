# PirateRadioFM

> Music radio for CLI coding agents

[中文文档](./README.zh-CN.md)

---

## Install


**Prerequisites:** Node.js ≥ 20, and `mpv` (recommended) or `ffplay`:

- Windows: `winget install mpv` (or `scoop install mpv`)
- macOS: `brew install mpv`
- Linux: `sudo apt install mpv`

Then add the marketplace and install:

```bash
claude plugin marketplace add nanawanzii/PirateRadioFM
claude plugin install radiohead@radiohead
```
Or
```bash
/plugin marketplace add nanawanzii/PirateRadioFM
/plugin install radiohead@radiohead
```

**Restart Claude Code.** In a new session, type `/` — you should see `/jazz`,
`/classical`, `/next`, etc.

Uninstall:

```bash
claude plugin uninstall radiohead
claude plugin marketplace remove radiohead
```

---

## Commands


### Genre stations

| Command | Plays |
|---|---|
| `/jazz` | Jazz |
| `/classical` | Classical |
| `/indie` | Indie |
| `/rock` | Rock |
| `/country` | Country |
| `/pop` | Pop |
| `/ambient` | Ambient |
| `/lofi` | Lo-fi beats |
| `/soul` | Soul |
| `/eighties` | 80s |
| `/world` | World |
| `/house` | House |
| `/techno` | Techno / IDM |

### DJ / public stations

| Command | Station |
|---|---|
| `/kexp` | KEXP 90.3 Seattle (DJ indie / alternative) |
| `/kcrw` | KCRW Eclectic24 (Los Angeles) |
| `/wfmu` | WFMU freeform (New Jersey) |
| `/nts` | NTS London (underground / club) |
| `/wwoz` | WWOZ New Orleans (jazz & blues) |
| `/paradise` | Radio Paradise (curated eclectic) |

### Playback control

| Command | What it does |
|---|---|
| `/play` | Play jazz radio (default), or resume if paused |
| `/pause` | Pause playback (resumable) |
| `/resume` | Resume paused playback |
| `/stop` | Stop playback entirely |
| `/next` | Next station / channel / track |
| `/prev` | Previous station / channel / track |
| `/volume <0-100>` | Set volume, e.g. `/volume 60` |
| `/now-playing` | Show what's currently playing |

Stations with more than one stream (`/nts`, `/paradise`) rotate between their
channels with `/next`.

### Spotify

Remote-controls a running Spotify client (requires Spotify Premium).

| Command | What it does |
|---|---|
| `/spotify-login` | Start the Spotify OAuth login flow |
| `/spotify-complete-login <code>` | Finish login by pasting the code from the redirect URL |
| `/spotify-list` | List your playlists |
| `/spotify-play <name-or-uri>` | Play a playlist by name or URI |

Once Spotify is playing, `/pause`, `/resume`, `/next`, `/prev` and `/volume`
control it too.

You can also just talk to the agent: *"play some jazz"*, *"switch station"*,
*"set volume to 60"*, *"stop the music"*.
