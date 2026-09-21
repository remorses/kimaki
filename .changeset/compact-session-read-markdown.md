---
'kimaki': minor
---

Make `kimaki session read` cheaper to load, then cheaper to grep.

Thinking is omitted unless you pass `--thinking`. Compact tool lines truncate input to 80 characters (`--tool-input-max-chars` changes the cap). `--verbose` still dumps full tool YAML.

Agents should read the full compressed transcript when it is under 100 KB.

Headings and tool lines use stable prefixes with no emoji: `### user`, `### assistant`, `tool:`, `tool-error:`.

Compact `read` lines show the file base name. Compact `task` lines keep the description and child `ses_` id. Compact `bash` lines show the command when it fits, otherwise the description.
