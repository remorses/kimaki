---
'kimaki': patch
---

Reject OpenCode 2.x at bot start and before the OpenCode server spawn.

Kimaki still talks to OpenCode 1.x. If `opencode --version` reports `2.x.x`, Kimaki now exits with:

```
Kimaki is not compatible with OpenCode version 2.0.0. Install an OpenCode 1.x release.
```

Other majors still work. After the v2 port, this gate will flip from major `2` to major `1`.
