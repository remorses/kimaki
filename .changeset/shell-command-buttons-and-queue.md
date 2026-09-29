---
'kimaki': minor
---

Add `!` shell command action buttons and `!cmd. queue`.

The agent can now show an action button that runs a shell command:

```
kimaki_action_buttons({ buttons: [{ label: 'Build', command: 'pnpm build' }] })
```

Clicking it runs `pnpm build` in the project directory right away and streams the output to Discord, the same as sending a `!pnpm build` message. No model turn starts, so rebuild and retest loops are much faster. The label is only display text, and the button message shows each command so you see what runs before you click.

Button labels over 80 chars, and commands too long to fit in one Discord message, now return an error to the model. Before, labels were cut to 80 chars without a warning.

`!` commands also support the queue suffix. `!pnpm test --run. queue` (or `/queue !pnpm test --run`) waits until the current turn and earlier queued messages finish, then runs and streams its output as a reply to your message. Before, the suffix was passed to the shell as part of the command.

Shell commands do not add anything to the session. To show the output to the model, reply to the output message.

Also fixes context-only messages (for example a reply to another user in a thread) that aborted the running turn and were replayed as a real prompt. They also no longer cancel a pending `kimaki_sleep`.
