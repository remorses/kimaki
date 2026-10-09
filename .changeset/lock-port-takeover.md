---
'kimaki': patch
---

Starting `kimaki` while another Kimaki bot runs now stops the old bot and takes over, like Kimaki V1 did.

```
new kimaki ─GET :29988/health─▶ old bot { pid, wrapperPid }
           ─SIGTERM─▶ old bot shuts down (SIGKILL after 20s) ─▶ new bot binds the port
```

This also works when the running bot is Kimaki V1, so upgrading does not need a manual stop.

The lock port is now taken **first**, before the database migration and onboarding. Before, a second `kimaki` went through the full onboarding and only then failed with `port is in use`.

To run two bots at once, give the second one its own port and data dir:

```bash
KIMAKI_LOCK_PORT=31001 kimaki --data-dir ~/.kimaki-test
```
