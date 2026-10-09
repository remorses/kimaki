---
'kimaki': minor
---

Kimaki now starts by itself when OpenCode starts. After you reboot and open OpenCode, the bot comes back without running `kimaki` by hand.

```
kimaki (first start) ──writes──▶ ~/.kimaki/autostart.command
OpenCode starts ──Kimaki plugin──▶ no bot on the lock port? ──▶ opens it in your default terminal
```

- Only for installs that already finished setup: the script is written after onboarding succeeds, and only for the default lock port.
- An autostarted bot never stops a bot that already runs. If another bot took the port first, it exits.
- On macOS the script opens in your default terminal app in the background, so you can read the logs without losing focus. On Linux the bot starts without a terminal and logs to `~/.kimaki/kimaki.log`.
- The flags `--worktrees`, `--no-analytics` and `--machine-name` of the last start are kept.
- It runs once per OpenCode process: if you stop the bot, it does not come back until OpenCode restarts.
