---
'kimaki': minor
---

Add `/accounts`, which shows every saved OAuth login: its email, which one is active, and why the others cannot serve requests. The reply is only visible to you, and only the server owner or an administrator can run it.

```
**OpenAI**
- OpenAI 2 ⋅ you@example.com ⋅ plus ⋅ **active**
- OpenAI ⋅ email unknown, same user as OpenAI 3 ⋅ usage limit until 20:15
- OpenAI 3 ⋅ email unknown, same user as OpenAI
**Anthropic**
- Anthropic 4 ⋅ you@example.com ⋅ claude_max ⋅ **active**
- Anthropic 2 ⋅ email unknown ⋅ token expired 3 days ago
```

- **Email** comes from the token, or from the Claude profile API for Claude Pro/Max logins. "Sign in with ChatGPT" tokens have no email, so the list shows which logins belong to the same user.
- **Blocks** come from `@kimaki/plugin-fallback` (usage limit, rate limit, failed login) when that plugin is loaded.
- **Expired** tokens usually refresh on next use, unless the login was revoked.
