---
'kimaki': patch
---

Mark Discord system lines with `-# `, Discord subtext, instead of a quote or diamond.

The new-session model banner, turn footer, queue notices, context usage, retries, and sleep wake now start with `-# `. Assistant text quotes stay as `> `. Worktree thread titles still use `⬦`. Web fetch tool lines are unchanged.

```
-# *using openai/gpt-5.6-sol ⋅ gpt5*

I'll inspect the file.

-# *kimakivoice ⋅ main ⋅ 2m 30s ⋅ 71% ⋅ gpt-5.6-sol*
```
