---
'kimaki': minor
'discord-digital-twin': patch
---

Remove the diamond prefix from assistant text and put a Separator between text and tools.

Text replies no longer start with `⬥`. Text and tools use classic Discord content so they stay full width. When the kind changes, Kimaki sends a Components V2 message that is only a Separator, then the new part as content.

```
I'll inspect the file.
────────────────
┣ bash ls
┣ edit src/foo.ts
────────────────
Done.
```
