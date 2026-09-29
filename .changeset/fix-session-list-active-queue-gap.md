---
'kimaki': patch
---

Fix `kimaki session list --active` reporting "No active sessions" while sessions were still working.

- **Shorter idle gap between queued runs.** A `/queue` (or `. queue`) message waited for the "Executing queued prompt" Discord reply (about a second) before it was sent to OpenCode. The session looked idle in that gap. The prompt is now sent right away, and the reply is posted in parallel.
- **Aborted questions no longer hide busy sessions.** OpenCode keeps a question in its pending list after the question tool is aborted. A busy session was then labeled `showing-question` and skipped by `--active`. Only a question whose tool call is still running counts now.
- **Errors never look like "none active".** `--active` exits `0` while sessions are active, `1` when none remain, and `64` on errors. With `--all --active`, a project that fails to connect is an error instead of being skipped.

The wait loop in the agent system prompt now stops only on exit code `1`, and tells agents to check again right before each commit:

```bash
until kimaki session list --active --exclude <session_id>; [ $? -eq 1 ]; do sleep 5; done
```
