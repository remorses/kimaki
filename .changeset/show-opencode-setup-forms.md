---
'kimaki': patch
---

Show every OpenCode V2 form in Discord, not only `question` tool forms.

OpenCode itself asks with forms too. The first `websearch` call asks which search provider to use. Kimaki ignored that form, so nothing showed in Discord, OpenCode cancelled it after 1 minute, and every search failed with `Web search cancelled`.

Now these forms show as dropdowns, like OpenCode Mini:

```
**Web Search**
Allow OpenCode to search the web for up-to-date information?
[ Allow search via Exa, Firecrawl, ... | Choose another provider | Disable web search ]
```

- Fields without a title use the form title.
- Yes/no fields show a Yes / No dropdown and send a boolean.
- Text fields without options open the text modal.
- Answers show the option label (`Disable web search`), not the raw value.

Forms with number, external, conditional or pattern fields are still not shown.
