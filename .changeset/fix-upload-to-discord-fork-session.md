---
'kimaki': patch
---

Fix `kimaki upload-to-discord` posting into the parent Discord thread from `/btw` and `/fork` sessions.

Forked sessions copy the parent system prompt, so `--session` still names the parent. Bash now injects the live OpenCode session ID, and upload prefers that over the stale flag. Each turn also repeats the live session ID and Discord thread ID in synthetic user context, so `/btw` and `/fork` still see the current thread.

```bash
# still write --session; bash uploads to the current thread anyway
kimaki upload-to-discord --session ses_parent /tmp/shot.png
```
