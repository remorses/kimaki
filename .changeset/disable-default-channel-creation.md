---
'kimaki': minor
---

Allow managed and headless deployments to disable automatic default Kimaki channel creation:

```bash
KIMAKI_NO_DEFAULT_CHANNEL=1 kimaki
```

This prevents Kimaki from creating its general-purpose channel, welcome message, and tutorial thread when the deployment provisions project channels itself.

Fixes #175
