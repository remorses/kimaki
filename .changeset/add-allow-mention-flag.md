---
'kimaki': minor
---

Add `--allow-mention` CLI flag to control which Discord mention types the bot can trigger.

Default is `users` only, which prevents the bot from pinging `@everyone`, `@here`, or roles. Repeatable flag to allow additional types:

```bash
kimaki --allow-mention users --allow-mention roles
```

Valid values: `users`, `roles`, `everyone`.
