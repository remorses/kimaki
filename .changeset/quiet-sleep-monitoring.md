---
'kimaki': patch
---

Make `kimaki sleep` monitoring quiet.

- The footer of a turn that runs `kimaki sleep` is now posted silently, so checking for an email reply every few hours does not send a Discord notification each time. The next turn notifies as usual.
- The system prompt and the `kimaki sleep` help text and output tell agents to wait 2h or more when they monitor slow events, such as email replies or PR reviews. They must not poll every few minutes or post status reports when nothing changed.
- The system prompt tells agents not to use `--agent plan` when they send a task to another project, unless the user explicitly asks for it. The agent can plan first because of how the prompt is written, and it can still edit files after the user approves.
