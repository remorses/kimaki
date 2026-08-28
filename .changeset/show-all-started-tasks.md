---
'kimaki': patch
---

Show every started task in Discord, including tasks that wait for an OpenCode subagent slot.

Previously, Kimaki waited for each child session ID before showing its task. Large parallel task batches could show only the first few lines and then appear stuck while the remaining tasks waited.
