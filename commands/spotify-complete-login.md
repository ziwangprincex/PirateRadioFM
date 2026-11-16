---
description: Finish Spotify login by pasting the redirect URL or its code (usage — /spotify-complete-login <redirect-url-or-code>)
argument-hint: "<redirect-url-or-code>"
allowed-tools: Bash(node:*)
---
```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" spotify_complete_login --stdin=code <<'PIRATE_RADIO_ARGS'
$ARGUMENTS
PIRATE_RADIO_ARGS
```
