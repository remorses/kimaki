---
'kimaki': patch
---

Show tool calls, thinking, and task lines as Discord subtext so they look dimmer than assistant text. Bot status lines (banner, footer, context usage, queue notices, retries) are plain subtext with no glyph. Only tool-related status lines like `bash returned N tokens` keep the `⬦` glyph, so it lines up with the `┣` and `◼︎` tool prefixes.

```
-# *using openai/gpt-5.6-sol ⋅ build*
-# ┣ skill _changesets_
-# ◼︎ apply_patch *thread-session-runtime.ts* (+14-10)
-# ⬦ bash returned 12k tokens
-# Queued message (position 1)
-# *kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ gpt-5.6-sol*
```
