---
'kimaki': patch
---

Fix `-cmd`, `-skill`, and `-mcp-prompt` slash commands not creating worktrees in channels with worktrees enabled.

Previously, running a command like `/review-cmd` in a channel with worktrees toggled on would create a plain thread without a worktree. Regular messages and `/agent` commands already respected the per-channel worktree setting, but user-defined commands skipped the check entirely.

Now `user-command.ts` mirrors the same worktree logic from `discord-bot.ts` and `agent.ts`:

1. Check `useWorktrees` CLI flag and `getChannelWorktreesEnabled()` channel setting
2. Verify the project directory is a git repository root
3. Prefix thread name with `WORKTREE_PREFIX`
4. Create worktree in background via `createWorktreeInBackground()`
5. Pass the worktree path as `sdkDirectory` to the runtime
