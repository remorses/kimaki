---
'kimaki': patch
---

Fix `/plan-agent <prompt>`, `/build-agent <prompt>` and other quick agent slash commands not creating worktrees when used from a project channel with worktree mode enabled.

Previously, sending a prompt via a quick agent command (e.g. `/build-agent fix the auth bug`) in a channel with worktrees toggled on would create a plain thread without a worktree. Normal messages in the same channel correctly created worktrees.

Now the agent command's channel path checks both the `--worktrees` CLI flag and the per-channel `/toggle-worktrees` setting, creates the worktree in background, and prefixes the thread name with `⬦` like normal messages do.
