---
'kimaki': minor
---

Allow messages that mention a registered project channel like `#website` to automatically grant the active OpenCode session access to that channel's project directory.

This works when starting a new Discord thread and on later messages in an existing thread, so cross-project requests can inspect referenced project folders without requiring a manual `/add-dir` step first.
