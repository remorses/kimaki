---
'kimaki-cli2': patch
---

`kimaki` subcommands start about 8x faster and use about 5x less memory (0.46s and 330 MB down to 0.06s and 70 MB per call). SQLite, discord.js and voice modules now load only in the commands that need them. Agents call `kimaki` many times per session, so this adds up.
