---
'kimaki': patch
---

Add `--no-auto-upgrade` CLI flag to disable the background auto-upgrade check on startup.

By default kimaki checks npm for a newer version and installs it silently in the background every time the bot starts. Pass `--no-auto-upgrade` to skip this behavior, useful for pinned deployments or air-gapped environments.

```bash
kimaki --no-auto-upgrade
```
