---
description: Set volume 0-100 (usage — /volume 60)
argument-hint: "<0-100>"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" radio_volume level=$ARGUMENTS`
