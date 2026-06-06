---
'kimaki': patch
---

Fix automatic permission rejection for task subagents whose child session is created before the parent task tool reports metadata. Subagent permission prompts now fail fast instead of hanging until the manual approval timeout, and the behavior is covered by an e2e test.
