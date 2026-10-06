---
'kimaki-cli2': patch
---

Show what OpenCode 2 Code Mode `execute` calls do in Discord. Before, every call showed only `┣ execute`, so tools like `opencode.session_move`, `opencode.models` and MCP tools were not visible.

The model now gives `execute` a short `description`, like `shell`. Each tool that the code calls gets its own line with the `execute.` prefix:

```
-# ┣ execute _Move session to the new worktree_
-# ┣ execute.opencode.session_move _/repo-wt_
-# Working directory changed to /repo-wt
```

Resumed and forked sessions replay these lines too. At `text` verbosity they stay hidden, like other tool lines.
