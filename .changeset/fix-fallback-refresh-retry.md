---
'@kimaki/plugin-fallback': patch
---

Skip saved accounts whose login can no longer refresh. Before switching to another account, fallback now refreshes its token if needed. When the refresh fails (for example `invalid_grant: Refresh token expired` on an old Claude Pro/Max login), that account is blocked for 24 hours and the next account or model is tried, in the same turn.

Before, fallback could activate an old login after a rate limit, and the session then ended with `Claude Pro/Max login failed: token endpoint returned 400`.

A refresh that fails on the account that is already active, at the start of a turn or between steps, still ends the turn: OpenCode 2.2.5 fails there before plugins can react. That case needs https://github.com/anomalyco/opencode/pull/61757.
