---
'@kimaki/plugin-fallback': patch
---

Keep the session model when the provider has an outage. A `503` or `529 Overloaded` response no longer switches the session to another model: OpenCode retries the same model with its normal backoff (about 10 attempts over 1.5 minutes).

Before, a single bare `HTTP 503` from Anthropic moved a Claude Opus session to `openai/gpt-6.1-sol` for the rest of the session, while the Claude account still had usage left:

```
503 on opus ──▶ "overloaded" block for 30s ──▶ session switched to gpt-6.1-sol (permanent)
```

Now only failures of the account itself switch: rate limits, usage limits (quota) and failed logins. Provider outages are temporary, but a model switch lasts for the whole session and drops its prompt cache.
