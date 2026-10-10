---
'kimaki': patch
---

Messages sent from Discord no longer show Kimaki's `<discord-user ... />` and `<local-files>` blocks in the OpenCode TUI and other clients. The stored prompt is now exactly what you wrote:

```
before: fix the tests\n\n<discord-user name="tommy" user-id="..." message-id="..." ... />
after:  fix the tests
```

The Discord user, thread and attachment paths are saved in the prompt metadata instead. The Kimaki OpenCode plugin adds them to the model request, so the agent still sees the same block at the end of each message. The text is the same on every request, so the prompt cache keeps hitting.
