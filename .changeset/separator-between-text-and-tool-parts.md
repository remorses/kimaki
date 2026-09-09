---
'kimaki': minor
'discord-digital-twin': patch
---

Remove the diamond prefix from assistant text and put a blank line between text and tools.

Text replies no longer start with `⬥`. Text and tools use classic Discord content so they stay full width. When the kind changes, Kimaki starts the next part with a blank line. Consecutive same-kind parts stay adjacent.

```
I'll inspect the file.

┣ bash ls
┣ edit src/foo.ts

Done.
```
