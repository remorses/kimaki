---
'kimaki': minor
---

Stream `!` shell command output live in Discord.

`!command` messages and `/run-shell-command` no longer wait for the command to finish. Output now appears in a single message that is edited about once per second while the command runs:

````
```
 ✓ src/utils.test.ts (12 tests)
 ✓ src/cli.test.ts (8 tests)
```
-# exit 0 ⋅ 4.2s
````

- stdout and stderr are interleaved in the order the command prints them
- the exit code and duration are shown as a subtext footer, not as a header
- colors are stripped and `\r` progress bars show only their latest state
- long output continues in up to 5 messages, then shows the tail with a hidden line count
- the timeout is now 10 minutes instead of 10 seconds, so `!pnpm test` and builds work
