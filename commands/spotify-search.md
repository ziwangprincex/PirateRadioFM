---
description: Search the Spotify catalog for tracks, albums, playlists, and shows (usage — /spotify-search <query>)
argument-hint: "<query>"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" spotify_search query=$ARGUMENTS`
