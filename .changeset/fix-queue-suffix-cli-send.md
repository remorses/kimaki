---
'kimaki': patch
---

Fix the `queue` suffix for `kimaki send --channel` prompts and for messages with embeds.

A prompt that ends with `. queue` now takes the same path everywhere: Kimaki strips the suffix and puts the message in its local queue, so it runs after the current turn ends.

```bash
# waits for the running turn in that thread, like a Discord message ending in ". queue"
kimaki send --thread 123456789 --prompt 'Run the tests again. queue'
```

This also works for long prompts. When a prompt is over 2000 characters, `kimaki send` uploads it as `prompt.md`. It now removes the `queue` suffix from the file and adds `queue` to the visible message, so the bot still queues the send.

The `/new-session` prompt option also accepts the suffix. `/queue` strips it, because `/queue` always queues.

Before, `kimaki send --channel` sent the literal `queue` word to the model. The same happened for any message with an embed, poll, or forward: the serialized embed was appended before the suffix check, so the suffix was no longer at the end. Editing a queued message now also keeps its text attachments.

The `. btw` suffix now also works for long `kimaki send --thread` prompts. Before, the suffix stayed inside `prompt.md`, so the prompt went to the busy session and interrupted it instead of forking. A `. btw` fork now also receives the message's text and image attachments, and adds the `--user` from `kimaki send` to the fork thread.

`kimaki send --help` and the agent system prompt now document the suffixes, so agents that send follow-ups to a busy thread append `. queue` instead of interrupting it:

```bash
kimaki send --thread 123456789 --prompt 'What does this error mean? btw'        # fork now
kimaki send --thread 123456789 --prompt 'Summarize what you changed. btw queue' # fork after the current run
```
