---
'kimaki-cli2': patch
---

Fix small security gaps in the OpenCode V2 rewrite:

- Separate Anthropic OAuth state from the PKCE verifier, validate pasted state, and fail login when the callback port is occupied. Remove unauthenticated callback cancellation.
- Keep the data directory private to its owner, including existing directories and V1 credential imports.
- Restrict session forks to the current thread's root or its direct subagents, and reject verbosity selections for another channel.
- Refresh Discord member permissions and reject queued-message edits after access is revoked. The original accepted prompt stays queued.
- Reject permission overrides on existing-session sends, notifications, and imported thread tasks instead of silently ignoring them.
- Bind newly started OpenCode services to loopback.
- Fail startup when the lock port is occupied instead of terminating a PID supplied by an unauthenticated HTTP endpoint. Stop the other process or use a different `KIMAKI_LOCK_PORT`.
