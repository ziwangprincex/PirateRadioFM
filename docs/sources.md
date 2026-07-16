# Podcast, Spotify, Apple Music, and HÖR sources

v0.2.0 adds three sources next to the built-in radio stations. This page covers
how each works, what it needs, and its known limits.

[中文文档](./sources.zh-CN.md)

## Overview

| Source | Audio comes from | Needs | Platforms |
|---|---|---|---|
| Radio (existing) | local mpv/ffplay | nothing | all |
| **Podcast** | local mpv/ffplay | nothing (no login) | all |
| **Spotify** | remote-controls the Spotify client | Premium + dev app + login | all |
| **Apple Music** | remote-controls the local Music.app | track already in your library | macOS only |
| **HÖR** | local mpv/ffplay via yt-dlp | yt-dlp + YouTube cookies | all |

`/pause` `/resume` `/next` `/prev` `/volume` `/stop` `/now-playing` work for all
four sources — they dispatch on whatever is currently playing. Switching sources
silences the previous one automatically; you never get two audio streams at once.

## Podcast

Zero setup. Podcast names are searched on the iTunes Search API (free, no auth),
the newest episode's audio URL is pulled from the RSS feed, and playback goes
through the same local player pipeline as radio.

```
/podcast 99% Invisible        # search by name, play the newest episode
/podcast https://…/feed.xml   # or give an RSS URL directly
/next                         # one episode older
/prev                         # one episode newer
```

- Episode order: newest = 1, `/next` walks toward older episodes.
- **Resume after pause restarts the episode from the top** — pause kills the
  local player, so position is lost. A v1 trade-off; seeking needs mpv IPC.
- Session-end auto-stop and the `/stop` orphan sweep work exactly like radio.
  Podcast CDN hosts are recorded in `~/.pirate-radio/dynamic-hosts.json`
  (capped at 20) so the sweep can match them.

## Spotify

The Web API only **remote-controls** a running Spotify client (a Spotify
Connect device) — it produces no audio itself, and playback control requires
**Premium**.

### One-time setup

1. Create an app at <https://developer.spotify.com/dashboard> with Redirect URI
   `http://127.0.0.1:8888/callback`.
2. `export SPOTIFY_CLIENT_ID=...` (the app's Client ID).
3. `/spotify-login` → open the URL, approve → copy the `code` query param from
   the redirect → `/spotify-complete-login <code>`.

Tokens live in `~/.pirate-radio/spotify.json` (mode 0600) and refresh
automatically.

### Commands

```
/spotify-play <anything>      # URI, open.spotify.com link, your playlist name,
                              # or free text (catalog search: track > album > playlist > show)
/spotify-search <query>       # search the catalog, returns URIs
/spotify-list                 # your playlists
/spotify-devices              # online Connect devices (> marks the active one)
/spotify-device <name-or-id>  # move playback to another device
```

- `/spotify-play` plays anything: `spotify:track:…`, `spotify:album:…`,
  `spotify:show:…` (podcasts), `open.spotify.com` links, playlist names, or
  free text.
- `/now-playing` on the Spotify source queries the API live: real track,
  progress, and device.
- **No-active-device self-heal** (macOS only): a 404 on play triggers
  `open -a Spotify`, waits for the client to register as a Connect device
  (up to ~12s), transfers playback, and retries once. Elsewhere you get a hint
  to open the client or use `/spotify-devices`.

### Limits

- Premium required; free accounts get a 403.
- Spotify closed the recommendations / audio-features endpoints to new apps,
  so no "play me something I'd like" features.

## Apple Music (macOS only)

Drives the local Music.app via `osascript` (AppleScript). No developer account,
no tokens.

```
/music <playlist, song, or album name>
```

- Match order: playlist name → track name (contains) → album name (contains).
- **Library only.** AppleScript cannot search the Apple Music catalog — that's
  a MusicKit (web/app) capability. Add things to your library in Music.app
  first.
- First use triggers macOS's one-time Automation permission prompt.
- Session-end auto-stop only covers the local player; Music.app and Spotify are
  external apps and keep playing when the session dies (same as Spotify always
  behaved). Use `/stop`.

## Where things live

| File | Role |
|---|---|
| `src/sources/podcast.ts` | iTunes search, dependency-free RSS parse, per-episode playback |
| `src/sources/applemusic.ts` | osascript wrappers, 3-tier library match |
| `src/sources/spotify.ts` | catalog search, devices/transfer, now-playing, 404 self-heal |
| `src/sources/hoer.ts` | HÖR homepage scrape, yt-dlp resolution, cookie auth |
| `src/dynhosts.ts` | podcast CDN host registry for the orphan sweep |
| `src/tools.ts` | dispatches pause/resume/next/prev/volume/stop on `now.source` |

## HÖR Berlin

HÖR (hoer.live) is a Berlin-based DJ live-streaming platform. It has no audio
endpoint of its own — the "radio" is a YouTube live embed on its homepage.
PirateRadioFM scrapes the current video ID, uses `yt-dlp` to resolve the direct
audio URL, and plays it through the local player (mpv/ffplay).

### Prerequisites

1. **yt-dlp** installed and on PATH:
   - Windows: `winget install yt-dlp`
   - macOS: `brew install yt-dlp`
   - Linux: `pipx install yt-dlp`

2. **YouTube cookies** — YouTube requires login cookies to serve streams to
   non-browser clients (bot detection). You must provide cookies via one of:

### Setup (cookies.txt — recommended)

This method works on all platforms and never locks the browser's database.

1. Open Chrome (or any browser), go to youtube.com, make sure you're signed in.
2. Install a cookies export extension — e.g. **"Get cookies.txt LOCALLY"**
   (Chrome Web Store). Choose one that does NOT upload cookies to a server.
3. On youtube.com, click the extension → export → save to:
   - Windows: `C:\Users\<username>\.pirate-radio\cookies.txt`
   - macOS/Linux: `~/.pirate-radio/cookies.txt`
4. Set the environment variable:
   ```bash
   export HOER_COOKIES_FILE="$HOME/.pirate-radio/cookies.txt"
   ```
   For Claude Code, add to `~/.claude/settings.json`:
   ```json
   { "env": { "HOER_COOKIES_FILE": "C:/Users/<username>/.pirate-radio/cookies.txt" } }
   ```
5. `/hoer` should now work.

### Alternative: cookies-from-browser

If you prefer not to export a file, yt-dlp can read cookies directly from a
browser's cookie store:

```bash
export HOER_COOKIES_FROM_BROWSER=firefox    # Firefox works even while open
export HOER_COOKIES_FROM_BROWSER=chrome     # Chrome/Edge must be fully closed (Windows)
```

**Windows caveat:** Chrome v127+ uses App-Bound Encryption. yt-dlp often cannot
decrypt Chrome cookies on Windows even when Chrome is closed (yt-dlp #10927).
The cookies.txt method is more reliable.

### Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| "Sign in to confirm you're not a bot" | No cookies configured, or cookies expired | Export fresh cookies.txt |
| "Could not copy cookie database" | `COOKIES_FROM_BROWSER` set but browser is running (locks the DB) | Close the browser, or switch to `COOKIES_FILE` |
| "Failed to decrypt with DPAPI" | Chrome's App-Bound Encryption (Windows, Chrome v127+) | Use `COOKIES_FILE` instead of `COOKIES_FROM_BROWSER` |
| Cookies expire (every few months) | YouTube session cookies have a TTL | Re-export cookies.txt and overwrite the old file |

### How it works

1. Fetches `hoer.live`, regex-extracts the embedded YouTube `videoId`.
2. Calls `yt-dlp -g -f bestaudio/best --cookies <file> <youtube-url>` to
   resolve the direct audio stream URL (HLS manifest or direct link).
3. Plays the resolved URL through mpv/ffplay at the current volume.
4. The resolved `googlevideo.com` host is registered with `rememberHost()` so
   the orphan-sweep (session-end auto-stop) can still kill the player.
