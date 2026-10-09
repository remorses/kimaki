---
'kimaki': major
---

Kimaki 1.0 runs only on **OpenCode v2**. OpenCode v1 is no longer supported. Kimaki now runs on OpenCode 2.0.19, and it installs OpenCode v2 when it is missing.

The Discord sessions, commands, worktrees, and plugins use the native OpenCode v2 APIs. Kimaki keeps chronological message history, project-scoped session lists, context-only messages, queued files, OAuth attempts, worktree cleanup, model selection, token analytics, native subagents, pending forms, and durable SSE reconnect recovery. The built v2 plugin keeps file-edit tracking and strict Discord tool inputs.

## Breaking changes

- **OpenCode v1 is not supported.** To stay on OpenCode v1, pin `kimaki@0.31`.
- **Subrouter is not bundled.** To switch accounts and models on rate limits, add the new `@kimaki/plugin-fallback` OpenCode v2 plugin.
- **The prompt injection guard is not bundled.** `opencode-injection-guard` is an OpenCode v1 plugin. The `--injection-guard` flag of `kimaki send` is removed.
- **The `/share` command is removed.** OpenCode v2 has no public session-sharing API. Use `/diff` when you need a shareable code diff.
- **`@kimaki/opencode-plugin` is removed.** It was a v1 plugin.

Fixes #220
