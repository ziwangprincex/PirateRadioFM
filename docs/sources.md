# Podcast, Spotify, and Apple Music sources

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
| `src/dynhosts.ts` | podcast CDN host registry for the orphan sweep |
| `src/tools.ts` | dispatches pause/resume/next/prev/volume/stop on `now.source` |
