---
'kimaki': patch
---

<!-- Release notes for removing the subagent rate-limit abort plugin. -->

Stop aborting task subagents when they hit a provider rate limit.

Kimaki used to cancel child sessions (for example `explore`) as soon as OpenCode reported a usage limit, then show a toast like:

```text
Aborting explore after rate limit so the parent task can recover: The usage limit has been reached
```

That abort ran before Subrouter could rotate accounts or fail over to another provider. Rate-limited subagents now keep running so retry and failover can finish.
