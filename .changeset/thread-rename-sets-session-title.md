---
'discord-digital-twin': minor
---

`discord-digital-twin` adds `discord.thread(id).user(userId).renameThread({ name })`, which sends THREAD_UPDATE and the CHANNEL_NAME_CHANGE system message like real Discord. `thread(id).text()` shows it as `[renamed thread to: <name>]`.
