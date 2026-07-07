---
description: Finish Spotify login by pasting the authorization code from the redirect URL (usage — /spotify-complete-login <code>)
argument-hint: "<code>"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" spotify_complete_login code=$ARGUMENTS`
