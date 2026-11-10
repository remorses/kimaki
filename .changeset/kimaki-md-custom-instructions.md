---
'kimaki': minor
'website': patch
---

Add your own instructions to Kimaki sessions with two files in the Kimaki data dir (`~/.kimaki` by default, or `--data-dir`):

| File | Reaches |
| --- | --- |
| `KIMAKI.md` | every Kimaki session: coordinators, worker threads, plain threads |
| `KIMAKI_COORDINATOR.md` | only coordinator sessions |

```bash
echo 'Always reply in Italian.' > ~/.kimaki/KIMAKI.md
echo 'Start every worker in a worktree.' > ~/.kimaki/KIMAKI_COORDINATOR.md
```

Edits reach running sessions at their next message, also long coordinators, without breaking the prompt cache. Deleting a file tells the session that its instructions no longer apply. Sessions you open in the OpenCode TUI never get them.
