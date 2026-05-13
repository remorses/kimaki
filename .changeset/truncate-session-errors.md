---
'kimaki': patch
---

Truncate OpenCode session error messages shown in Discord to 400 characters.

Provider error payloads can include enormous response bodies, which made a single
`✗ opencode session error` reply flood the thread. Kimaki now keeps the visible
error concise while still showing the important prefix and provider status.
