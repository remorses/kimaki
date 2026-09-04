---
'kimaki': minor
---

Add `kimaki session search --all` to search past sessions across every locally registered project.

The command still defaults to the current project. Pass `--all` when you do not know which project a thread belongs to:

```bash
kimaki session search "auth timeout"
kimaki session search "auth timeout" --all
kimaki session search "/panic|crash/i" --all --json
```

`--all` cannot be combined with `--project` or `--channel`. Missing or unreachable projects are skipped, and `--limit` still caps the newest matching sessions across all projects.
