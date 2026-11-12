---
'kimaki': minor
'discord-digital-twin': minor
---

Add **`kimaki --sort-channels`** to keep the channels you use most recently at the top. A message, slash command or button click in a project channel, or in one of its threads, moves that channel to the top of this machine's `Kimaki <machine>` category.

```bash
kimaki --sort-channels
```

It is off by default and is kept for autostart. Kimaki waits about 10 seconds after an interaction, then sends one reorder request, and only if the order changed. Channels in other categories, and channels of other machines, are never moved. Discord stores the order, so it survives restarts.

discord-digital-twin adds `PATCH /guilds/{guild.id}/channels` (Modify Guild Channel Positions) and `DigitalDiscord.getGuildChannels()`.
