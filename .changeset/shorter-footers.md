---
'kimaki': patch
'website': patch
---

Shorter footers. The footer at the end of a turn no longer repeats what the channel already says: the folder shows only when the session works outside the channel's project folder (a worktree or another cwd), and the agent shows only when it differs from the channel's default agent.

```
-# *kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ claude-opus-5-5 ⋅ opus*   <- before, in a channel whose agent is opus
-# *main ⋅ 2m 30s ⋅ 71% ⋅ claude-opus-5-5*                        <- now
-# *kimaki-fix-login ⋅ fix-login ⋅ 40s ⋅ 12% ⋅ claude-opus-5-5 ⋅ plan*   <- worktree session on another agent
```

The default agent is the one set with `/agent` for the channel, else OpenCode's default agent (`default_agent` in the OpenCode config, else `build`). Before, only `build` was hidden, so channels set to another agent showed it on every footer.
