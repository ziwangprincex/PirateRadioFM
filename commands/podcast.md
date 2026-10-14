---
description: Play a podcast's newest episode by name or RSS URL; /next & /prev step through episodes (usage — /podcast <name-or-rss-url>)
argument-hint: "<name-or-rss-url>"
allowed-tools: Bash(node:*)
---
```!
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" podcast_play --stdin=target <<'PIRATE_RADIO_ARGS'
$ARGUMENTS
PIRATE_RADIO_ARGS
```
