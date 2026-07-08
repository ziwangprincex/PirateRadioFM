---
description: Play from your Apple Music library via Music.app — playlist, song, or album name (macOS only; usage — /music <name>)
argument-hint: "<playlist-song-or-album>"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" music_play target=$ARGUMENTS`
