---
'kimaki': minor
---

Add Claude Code as an agent backend via the Claude Agent SDK.

Pick any `claude-code/*` model in `/model` (Claude Code shows up as a regular provider) and new sessions in that channel run on Claude Code instead of OpenCode — using your existing Claude Code login (Pro/Max subscription or `ANTHROPIC_API_KEY`), your `CLAUDE.md`, settings, and `.claude` project configuration.

Everything works the same as OpenCode threads: streaming replies and tool calls, permission Accept/Always/Deny buttons (including persisted "always" rules), AskUserQuestion dropdowns, the queue, interrupts, `/model` with effort-level variants (low/medium/high/xhigh/max), `/compact`, `/fork`, `/abort`, session resume after bot restarts (transcripts persist under `~/.claude`), images and PDFs, per-turn diff summaries, cost/token footers, and worktrees. Claude sessions also get the `kimaki_file_upload` and `kimaki_action_buttons` tools through an in-process MCP server.

Under the hood kimaki now routes all OpenCode SDK calls through a local backend router that serves Claude Code sessions in-process (translating Agent SDK messages onto the OpenCode wire protocol) and transparently proxies everything else to the opencode server.
