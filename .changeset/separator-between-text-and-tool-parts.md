---
'kimaki': minor
'discord-digital-twin': patch
---

Replace the diamond prefix on assistant text with a Discord Separator before tool output.

Text replies no longer start with `⬥`. Text and tools use classic Discord content so they stay full width. When a tool follows text, Kimaki sends a Components V2 message that is only a Separator, then the tool as content. Consecutive tools have no extra divider. Text after a tool has no separator.

```
I'll inspect the file.
────────────────
┣ bash ls
┣ edit src/foo.ts
Done.
```
