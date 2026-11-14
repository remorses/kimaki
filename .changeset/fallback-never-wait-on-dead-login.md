---
'@kimaki/plugin-fallback': patch
---

Never switch to a saved login whose token refresh failed. When every account was blocked, fallback picked the one that recovers first, and a dead login (blocked for a day) often won over an account at its weekly limit. It was then activated for every session, so all sessions failed with `Refresh token expired` until someone signed in again:

```
account A at its weekly limit, idle account B dead ──▶ B activated, every session fails
```

Now a dead login is skipped when choosing an account to wait for. The session waits for A, or, when only dead logins are left, fails with the normal error.

Fixes #262
