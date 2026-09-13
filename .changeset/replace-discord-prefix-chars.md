---
'kimaki': minor
'website': minor
---

Replace Discord line prefixes with wider CJK radicals and drop the extra space after them.

Tool lines now start with `▏`, file edits/writes/patches with `▎`, thinking with `⺪`, status/context/worktree notices with `⻟`, and queued user input with `⺩`.

```
▏bash pnpm test
▎edit _cli/src/foo.ts_
⺪thinking
⻟context usage 40%
⺩**Tommy:** also add docs
```

Active todos use a plain number instead of `⒈`-style glyphs: `5.  **run the tests**`.
