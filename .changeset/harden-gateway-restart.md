---
'kimaki': patch
---

Harden gateway reconnect restart so kimaki recovers from sustained network outages instead of crashing permanently.

Previously, when the gateway proxy was unreachable (DNS down, network outage), kimaki would:
1. Hit the 50-reconnect limit and trigger self-restart
2. Crash during cleanup from uncaught discord.js shard errors racing with shutdown
3. Restart into a process that immediately fails to connect and exits with `EXIT_NO_RESTART`, killing the bot permanently

Now:
- **Uncaught exceptions during shutdown are suppressed** instead of crashing the restart flow. Discord.js fires shard errors from pending DNS lookups even after the client is destroyed; these are now caught and logged.
- **Client listeners are removed before destroy** to prevent late-arriving events from becoming uncaught exceptions.
- **Transient network errors on initial connection** (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, etc.) exit with code 1 instead of EXIT_NO_RESTART, allowing the wrapper to retry.
- **Progressive restart backoff** (2s, 4s, 8s, 16s, capped at 30s) prevents hammering DNS during sustained outages. The existing crash loop detector (5 crashes in 60s) still acts as the ultimate circuit breaker.
