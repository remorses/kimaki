---
'kimaki': minor
---

Add the queue suffix to `!` shell commands.

Action button labels over 80 chars now return an error to the model. Before, labels were cut to 80 chars without a warning.

`!pnpm test --run. queue` (or `/queue !pnpm test --run`) waits until the current turn and earlier queued messages finish, then runs and streams its output as a reply to your message. Before, the suffix was passed to the shell as part of the command.

Shell commands do not add anything to the session. To show the output to the model, reply to the output message.

Also fixes context-only messages (for example a reply to another user in a thread) that aborted the running turn and were replayed as a real prompt. They also no longer cancel a pending `kimaki_sleep`.
