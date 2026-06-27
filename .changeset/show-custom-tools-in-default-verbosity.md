---
'kimaki': patch
---

Show custom tools, MCP tools, and plugin tools in default verbosity mode.

Previously, the default `text_and_essential_tools` verbosity used a whitelist of known tool names. Any tool not in that list (like custom `read-video`, MCP tools, etc.) was hidden. Now the logic is flipped: only known read-only built-in tools (`read`, `glob`, `grep`, `describe-media`, `todoread`) are hidden. Everything else is shown by default.
