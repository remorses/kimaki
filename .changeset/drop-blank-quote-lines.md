---
'kimaki': patch
---

Remove blank lines inside quotes in Discord messages. Discord shows an empty `>` line as a literal `>` that breaks the quote, so a multi-paragraph quote now renders as one quote block, with its paragraphs on separate lines. This applies to model output and to prompts Kimaki posts in a thread (`kimaki send`, routines, TUI prompts).

```md
> first paragraph
>
> second paragraph
```

now posts as:

```md
> first paragraph
> second paragraph
```
