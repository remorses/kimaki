---
'discord-digital-twin': minor
---

Add voice channels. With `voice: true` the twin runs a voice server, so `@discordjs/voice` can join a channel and send audio. The twin decrypts every RTP packet and records the opus frames, so tests can check exactly what a bot played.

```ts
const discord = new DigitalDiscord({
  voice: true,
  guild: { channels: [{ id: VOICE, name: 'talk', type: ChannelType.GuildVoice }] },
})
await discord.start()
// @discordjs/voice always connects with wss://, the twin uses a self-signed certificate
discord.trustVoiceCertificate()

const connection = joinVoiceChannel({ guildId, channelId: VOICE, adapterCreator, daveEncryption: false })
// ...play something
const stream = await discord.waitForVoiceStream({ channelId: VOICE, userId: discord.botUserId })
stream.opusPackets // decrypted opus frames, in order
```

- Gateway op 4 moves the bot and sends `VOICE_STATE_UPDATE` to the guild and `VOICE_SERVER_UPDATE` only to the session that asked. Like Discord, a join to the channel the session is already in sends no new token, only a voice state update if mute or deaf changed.
- The voice server checks the token, guild, user and gateway session ID on Identify. It supports `aead_aes256_gcm_rtpsize` and no DAVE.
- `GUILD_CREATE` includes the current voice states.
- `discord.channel(voiceChannelId).user(userId).joinVoice()` and `.leaveVoice()` move a user in and out of voice.

Needs the `openssl` CLI to make the certificate.
