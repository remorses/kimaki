---
'kimaki': minor
'website': patch
---

Rename scheduled tasks to **routines**. A routine is a prompt that Kimaki runs on a schedule with `kimaki send --send-at`.

```bash
kimaki routine list
kimaki routine edit <id> --send-at '0 9,18 * * *'
kimaki routine run <id>
kimaki routine delete <id>
```

- The Discord slash command `/tasks` is now `/routines`.
- Routine runs show as `» routine #N: prompt` in the thread.
- The docs page moved to https://kimaki.dev/docs/features/routines. The old `scheduled-tasks` URL redirects there.

Existing tasks keep working, including tasks created by Kimaki V1. They stay in the same `scheduled_tasks` table and show up as routines. The V1 commands `kimaki task list [--all]`, `task edit` and `task delete` still work, hidden from `--help`. `routine list --all` also shows finished and cancelled V1 tasks.
