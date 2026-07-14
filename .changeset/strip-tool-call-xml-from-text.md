---
'kimaki': patch
---

Strip tool-call XML tags from assistant text parts in Discord rendering.

When the model emits tool invocations as raw XML (e.g. `<skill name="obsidian-plugin" />`,
`<todowrite>`, `<todos>`) instead of structured tool-call parts, these tags now get
stripped before rendering in Discord instead of appearing as ugly raw XML.
`<callout>` and other intentional formatting tags are preserved.