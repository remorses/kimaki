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

Before, `kimaki send --channel` sent the literal `queue` word to the model. The same happened for any message with an embed, poll, or forward: the serialized embed was appended before the suffix check, so the suffix was no longer at the end. Editing a queued message now also keeps its text attachments.
