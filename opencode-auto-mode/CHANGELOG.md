# Changelog

## 0.1.1

1. **Tighten skip and hard-deny paths.** Command substitutions, assignment prefixes, PATH-qualified binaries, sudo wrappers, and mutating forms of `git` / `rg` / `sed` / `find` / `awk` / `sort` / `printf` no longer auto-allow. Recursive `rm` of `/.` and `$HOME`, profile redirects, and `curl | cat | sh` hard-deny. Invalid config JSON fails closed. Only the latest user message counts as authorization.

## 0.1.0

1. **Gate tool execution before it runs.** Read-only bash (`ls`, `cat`, `git status`, pipelines of those) and in-project edits skip the model. Recursive deletes of `/` or `$HOME`, shell-profile writes, `authorized_keys` redirects, and `curl | sh` are denied from the bash AST. Everything else goes to a two-stage classifier that fails closed.

   Uses [unbash](https://github.com/webpro-nl/unbash) to parse commands. Not the same plugin as injection-guard, which scans tool output after execution.
