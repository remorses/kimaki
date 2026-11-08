# Changelog

## 0.2.0

1. **Voice channels.** The twin runs a Discord voice server. Users join, leave and talk in voice channels, and tests can read what the bot sends:

   ```ts
   await discord.channel(voiceChannelId).user(userId).joinVoice()
   await discord.channel(voiceChannelId).user(userId).speak({ opusPackets })
   const stream = await discord.waitForVoiceStream({ channelId, userId: botUserId })
   ```

2. **Thread renames.** `discord.thread(id).user(userId).renameThread({ name })` sends THREAD_UPDATE and the CHANNEL_NAME_CHANGE system message like real Discord. `thread(id).text()` shows it as `[renamed thread to: <name>]`.

3. **Registered slash commands and autocomplete.** `getRegisteredCommands()` returns the commands a bot registered, and `channel(id).user(id).autocomplete(...)` sends an autocomplete interaction and returns the choices.

4. **Voice messages, modal file uploads and multipart messages** for attachment flows: `channel(id).user(id).sendVoiceMessage(...)` and file inputs in modals.

5. **Gateway proxy mode.** `authorizeGatewayClient({ token, guildIds })` and `revokeGatewayClient()` emulate gateway-proxy client auth, with the same route scoping (`resolveRouteScope`) for guild-scoped and read-only global REST routes.

6. **More snapshot options.** `text()` accepts `showReplies` and `showInteractions`, and `thread(id).getMemberIds()` lists thread members.

## 0.1.2

1. **Include Components V2 text in message snapshots.** `getMessageVisibleText()` walks nested components, including `Separator` as `---`, so e2e snapshots show Discord layout that lives in components instead of `content`.

## 0.1.1

1. **`deleteMessage()` on user actors** — simulates real Discord `MESSAGE_DELETE` gateway events in e2e tests, enabling tests for queue-on-delete and similar message lifecycle flows.

## 0.1.0

- Added scoped actor API accessors for clearer test ergonomics (`channel(...)`, `thread(...)`, `user(...)`).
- Added richer deterministic text snapshots: typing markers, footer placeholders, and stable message ordering.
- Expanded gateway compatibility (Twilight `/gateway/` path support, multi-guild behavior, and configurable gateway URL).
- Improved interaction + wait flows for e2e reliability, including deterministic footer/typing tracking and better parallel test stability.
- Upgraded Prisma toolchain to `7.4.2`.
- Updated published package layout to ship built `dist` output, include `schema.prisma`, and run `generate + build` in `prepublishOnly`.

## 0.0.1

Initial release.

- Local Discord API twin (REST + Gateway WebSocket) for testing discord.js bots
- In-memory state with Prisma + libsql
- Full message lifecycle: create, edit, delete, reactions
- Thread management: create, archive, unarchive, thread members
- Interaction flows: slash commands, buttons, select menus, modals
- Guild management: channels, roles, members, active threads
- Playwright-style actor API: `discord.user(id).sendMessage(...)`, `.runSlashCommand(...)`, etc.
- Wait helpers: `waitForThread`, `waitForMessage`, `waitForBotReply`, `waitForInteractionAck`
