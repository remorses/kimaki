---
'kimaki': minor
---

Add `--disable-sync` flag to turn off background mirroring of external OpenCode sessions into Discord.

```bash
kimaki --disable-sync
```

When enabled (default), sessions started from the OpenCode CLI or TUI automatically appear as Discord threads in the matching project channel. Use `--disable-sync` if you only use Kimaki through Discord and don't need the mirroring.

The background sync loop also now uses per-directory timeouts with proper cancellation, so one slow or unresponsive OpenCode server cannot block syncing for other projects.
