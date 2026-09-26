---
'kimaki': patch
---

Shorten the instructions Kimaki sends to coding agents in Discord by removing duplicated rules and repeated examples. A typical thread session prompt drops from about 10.7k to 8.7k tokens, and every command form, flag, and safety rule stays in it.

- **`kimaki send`** rules (`--parent-session`, `--agent`, `--user`, quoting, destination choice) are listed once instead of three times. Examples for `--notify-only`, `--file`, `--agent plan`, `/command` prompts, agent switching, and handoff are kept.
- **Remote and local routing** (thread IDs work on every computer, session IDs only on the one that created them) is in one "sending to an existing thread" section that the cross-project section links to.
- **Scheduling** keeps UTC rules, `--pre-run`, `--allow-concurrency`, the `tasks/*.md` pattern with frontmatter, the notification strategy, and `kimaki task edit` examples.
- **Worktrees and `--cwd`** keep the explicit-request rule, base-branch behavior, and recursion guard in one place.
- **Diffs and tunnels** keep every critique and `kimaki tunnel` command form without repeated examples.
- **Copyable commands.** The archive and thread-reminder commands no longer include `(or --session ...)` inside the shell command.

Existing sessions keep their pinned prompt. Start a new session to use the shorter instructions.
