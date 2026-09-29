---
'kimaki': minor
---

Add shell command action buttons.

The agent can now show an action button that runs a shell command:

```
kimaki_action_buttons({ buttons: [{ label: 'Build', command: 'pnpm build' }] })
```

Clicking it runs `pnpm build` in the project directory right away and streams the output to Discord, the same as sending a `!pnpm build` message. No model turn starts, so rebuild and retest loops are much faster. The label is only display text, and the button message shows each command so you see what runs before you click.

Button labels over 80 chars, and commands too long to fit in one Discord message, now return an error to the model. Before, labels were cut to 80 chars without a warning.
