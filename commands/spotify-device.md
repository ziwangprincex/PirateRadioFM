---
description: Move Spotify playback to another device by name or id (usage — /spotify-device <name-or-id>)
argument-hint: "<name-or-id>"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" spotify_transfer device=$ARGUMENTS`
