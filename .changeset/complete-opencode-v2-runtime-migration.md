---
'kimaki': patch
---

Complete the native OpenCode v2 migration across Discord sessions, commands, worktrees, and plugins.

Kimaki now preserves chronological message history, project-scoped session lists, context-only messages, queued files, OAuth attempts, worktree cleanup, model selection, token analytics, native subagents, pending forms, and durable SSE reconnect recovery. The built v2 plugin restores Subrouter, injection protection, file-edit tracking, and strict Discord tool inputs. Dead v1 runtime handlers and plugins are removed.

The unsupported `/share` command is removed because OpenCode v2 has no public session-sharing API. Use `/diff` when you need a shareable code diff.

Fixes #220
