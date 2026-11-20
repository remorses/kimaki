---
'@kimaki/plugin-fallback': patch
---

Fall back when a "Sign in with ChatGPT" account reaches its usage limit. OpenCode 2.3 reports this limit as a new error type, `provider.chatgpt-limit`, inside an HTTP 200 stream. The plugin did not know the type, so the session failed with `ChatGPT usage limit reached` and the account was never blocked.

Now these errors block the account and the session moves to the next account or model:

| OpenCode error | Block |
| --- | --- |
| `provider.chatgpt-limit`, ChatGPT workspace usage limit | quota, whole account |
| `provider.go-limit`, `provider.free-limit`, `provider.budget-limit` | quota, whole account |
| `provider.model-budget-limit` | quota, that model only |
| ChatGPT `subscription_sharing_invalid_user`, `user_not_eligible` | failed login |

A block now also covers other saved logins of the same user. If you signed in with ChatGPT twice, both credentials share one usage limit, so fallback no longer switches to the second copy of a limited account. When an error has no reset headers, OpenCode's `retryAfterMs` sets the block length.
