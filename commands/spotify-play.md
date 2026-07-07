---
description: Play a Spotify playlist by name or URI (usage — /spotify-play <name-or-uri>)
argument-hint: "<name-or-uri>"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" spotify_play_playlist target=$ARGUMENTS`
