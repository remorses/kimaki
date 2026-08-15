---
'kimaki': minor
---

Add conditional and non-overlapping scheduled tasks.

Use `--pre-run` to run a shell command in the project directory before each scheduled occurrence. Exit code 0 starts the session and adds stdout to its prompt. Any other exit code skips the occurrence, while stdout and stderr remain available in Kimaki logs.

```bash
kimaki send --channel <channel-id> \
  --send-at '*/5 * * * *' \
  --pre-run 'tsx scripts/should-run.ts' \
  --prompt 'Handle the support request from the pre-run output.'
```

Recurring tasks now avoid overlapping sessions by default. Add `--allow-concurrency` to opt into parallel runs from the same task.
