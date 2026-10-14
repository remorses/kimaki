---
'kimaki': patch
---

Kimaki installs one plugin less in your OpenCode config folder. The `OpenCode session ID: ses_...` system line now comes from the `kimaki` plugin, still in every session. On start the bot removes the old `~/.config/opencode/plugins/kimaki-session-id` shim. If you listed `kimaki/dist/plugin/session-id` in `opencode.json`, remove that entry.
