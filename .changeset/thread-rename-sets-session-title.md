---
'kimaki': patch
'discord-digital-twin': minor
---

Renaming a session thread in Discord no longer prompts the agent. The rename now sets the OpenCode session title to the new thread name.

Discord posts a system message when a thread is renamed, and its content is only the new name. Kimaki took it as user text and sent it to the agent as a prompt. Now system messages (renames, pins, member joins, boosts) never become prompts:

```
rename thread in Discord ─▶ CHANNEL_NAME_CHANGE message ─▶ session.update({ title })   (no prompt)
```

Agents still rename a thread and its session together with `kimaki session title`.

`discord-digital-twin` adds `discord.thread(id).user(userId).renameThread({ name })`, which sends THREAD_UPDATE and the CHANNEL_NAME_CHANGE system message like real Discord. `thread(id).text()` shows it as `[renamed thread to: <name>]`.

Fixes #258
