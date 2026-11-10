---
'kimaki': minor
---

Bring back **`/mcp`** to turn MCP servers on and off from Discord, also from the phone app. Run it in a project channel or a session thread: it shows a table of the configured servers with their status and one button per row.

| Status           | Button     |
| ---------------- | ---------- |
| Connected        | Disconnect |
| Disabled         | Connect    |
| Failed           | Retry      |
| Sign in required | Retry      |

The buttons call OpenCode's MCP connect and disconnect endpoints for the folder the session runs in (the project, or the thread's worktree). `opencode.json` is not changed, so servers start from their config again when OpenCode reloads that folder. See https://kimaki.dev/docs/configuration/mcp

Fixes #259
