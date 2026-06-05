---
'kimaki': minor
---

Add per-project emoji prefixes for new Discord channels and threads.

`kimaki project emoji add <name> <emoji>` stores a prefix in `<dataDir>/project-emojis.json`. New channels and threads created for that project are then named like `<emoji> <original name>` automatically. `kimaki project emoji list` and `kimaki project emoji remove <name>` manage the map. `kimaki project apply-prefixes` retroactively renames existing channels and active threads so the prefixes land on already-created Discord resources too.
