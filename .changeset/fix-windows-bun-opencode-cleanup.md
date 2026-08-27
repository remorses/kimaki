---
'kimaki': patch
---

Stop leaving orphaned OpenCode servers on Windows when OpenCode is installed through Bun.

Kimaki now resolves Bun's native launcher target before spawning the server, so normal shutdown terminates the server process it owns while preserving unknown and custom launcher behavior.

Fixes #144
