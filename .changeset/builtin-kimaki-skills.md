---
'kimaki': minor
---

Move the Kimaki debugging and tunnel docs of the agent prompt into built-in skills, and add `--disable-skills`.

`kimaki-debug` (logs, profiling, `kimaki login`, bug reports) and `kimaki-tunnel` (`kimaki tunnel` with tuistory) load on demand. The rest of the agent prompt is unchanged.

```bash
kimaki --disable-skills kimaki-tunnel   # turn off one
kimaki --disable-skills all             # turn off all
```

Disabled skills are denied in new sessions. The flag is saved for autostart. Built-in skills do not show as Discord slash commands.
