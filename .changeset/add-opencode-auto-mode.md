---
'@kimaki/automode': minor
---

Add an OpenCode auto-mode plugin that gates tool execution before it runs.

Read-only bash (`ls`, `cat`, `git status`, pipelines of those) and in-project edits skip the model. Recursive deletes of `/` or `$HOME`, shell-profile writes, `authorized_keys` redirects, and `curl | sh` are denied from the bash AST. Command substitutions and unknown commands never skip. Everything else goes to a two-stage classifier (one token `0`/`1`, then exact JSON) that fails closed. Invalid config also fails closed.

Uses [unbash](https://github.com/webpro-nl/unbash) to parse commands. Not the same plugin as injection-guard, which scans tool output after execution.
