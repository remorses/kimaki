---
'kimaki': minor
---

Add `kimaki session editors <file>` so you can see which sessions last edited a file.

Kimaki now records `edit`, `write`, and `apply_patch` tool calls, then lists those sessions newest first with titles and how long ago they edited the file. Use this when committing in a different session so the `Session:` line points at the session that actually changed the file.

```bash
kimaki session editors src/cli.ts
kimaki session editors src/cli.ts --json
```
