---
'kimaki': patch
---

Fix bash tool rendering when the `description` field is missing from tool input.

Newer opencode versions removed the `description` field from the bash tool schema. Previously, when a bash command was multiline or longer than 100 chars, the display fell back to `description`. Without it, the tool part rendered as just `┣ bash` with no context about what was running.

Now the first line of the command is shown truncated with `…` when no description is available:

```
# before (missing description)
┣ bash

# after (truncated first line)
┣ bash _git diff HEAD~1 --stat && git log --oneline -5…_
```
