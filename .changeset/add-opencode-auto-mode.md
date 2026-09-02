---
'opencode-auto-mode': minor
---

Add an OpenCode auto-mode plugin that gates tool execution before it runs.

Read-only bash (`ls`, `cat`, `git status`, pipelines of those) and in-project edits skip the model. Recursive deletes of `/` or `$HOME`, shell-profile writes, and `curl | sh` are denied from the bash AST. Everything else goes to a two-stage classifier (one token `0`/`1`, then exact JSON) that fails closed.

Uses [unbash](https://github.com/webpro-nl/unbash) to parse commands. Not the same plugin as injection-guard, which scans tool output after execution.
