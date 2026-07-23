---
'kimaki': patch
---

Remove Anthropic OAuth accounts whose refresh token is permanently dead (`invalid_grant` / refresh token expired) instead of hard-failing the session.

When multiple Anthropic accounts are in the rotation pool and refresh fails permanently, Kimaki drops that account, switches to the next one, and retries. If it was the last account, auth is cleared so you can re-login.

Rate limits still rotate without removing the account.
