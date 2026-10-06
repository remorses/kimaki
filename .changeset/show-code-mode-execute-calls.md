---
'kimaki': patch
---

Show what OpenCode 2 Code Mode `execute` calls do in Discord. Before, every call showed only `┣ execute`, so tools like `opencode.session_move`, `opencode.models` and MCP tools were not visible.

The model now gives `execute` a short `description`, like `shell`. Each tool that the code calls gets its own line with the `execute.` prefix:

```
-# ┣ execute _Move session to the new worktree_
-# ┣ execute.opencode.session_move _/repo-wt_
-# Working directory changed to /repo-wt
```

Failures are visible too. A failed inner call and an error thrown by the code each get a `⨯` line, also when `execute` itself ends without a tool error:

```
-# ┣ execute.opencode.session_rename _x_
-# ⨯ execute.opencode.session_rename _failed_
-# ⨯ execute _Error: broken on purpose_
```

If the bot misses some progress updates, the final result still shows every inner call. Resumed and forked sessions replay these lines too. At `text` verbosity the inner call lines stay hidden, like other tool lines; failure lines always show.
