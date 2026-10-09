---
'kimaki': patch
---

`kimaki buttons` now tells the agent to explain its choices. After the buttons show, the command output reminds the model that the user cannot see tool calls, command outputs, or subagent results. If its text did not already explain what was done in the session and what each button does, the agent writes that explanation right away.

The system prompt asks for the same explanation before the buttons, so users no longer get a row of short labels with no context.
