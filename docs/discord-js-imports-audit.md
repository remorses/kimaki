# Discord.js Import Audit Report

This report lists all discord.js imports in `discord/src/` files that are NOT in allowed/excluded files.

**Excluded (allowed to use discord.js):**
- discord/src/platform/discord-adapter.ts
- discord/src/voice-handler.ts
- discord/src/forum-sync/*

---

## Summary

**Total files with discord.js imports (excluding allowed):** 35 files
**Total import types:** ~38+ discord.js symbols imported

### Import Categories:

1. **MessageFlags** - Used in 12 command files
2. **REST & Routes** - Used in 4 utility/task files
3. **Type imports** - Message, ThreadChannel, TextChannel, Client, APIMessage
4. **Enums** - MessageFlags, PermissionsBitField, ChannelType, ThreadAutoArchiveDuration
5. **Classes** - REST, GuildMember, PermissionsBitField

---

## Detailed Breakdown by File

### 📦 Commands (12 files) - MessageFlags only

All these files import `MessageFlags` from discord.js:

1. `/discord/src/commands/abort.ts`
   - Line 3: `import { MessageFlags } from 'discord.js'`
   - Usage: Likely for message flag constants

2. `/discord/src/commands/action-buttons.ts`
   - Line 5: `import { MessageFlags, type ThreadChannel } from 'discord.js'`
   - Usage: MessageFlags + ThreadChannel type

3. `/discord/src/commands/agent.ts`
   - Line 4: `import { MessageFlags } from 'discord.js'`

4. `/discord/src/commands/compact.ts`
   - Line 3: `import { MessageFlags } from 'discord.js'`

5. `/discord/src/commands/context-usage.ts`
   - Line 3: `import { MessageFlags } from 'discord.js'`

6. `/discord/src/commands/mcp.ts`
   - Line 7: `import { MessageFlags } from 'discord.js'`

7. `/discord/src/commands/mention-mode.ts`
   - Line 6: `import { MessageFlags } from 'discord.js'`

8. `/discord/src/commands/permissions.ts`
   - Line 5: `import { MessageFlags, type ThreadChannel } from 'discord.js'`
   - Usage: MessageFlags + ThreadChannel type

9. `/discord/src/commands/queue.ts`
   - Line 3: `import { MessageFlags } from 'discord.js'`

10. `/discord/src/commands/restart-opencode-server.ts`
    - Line 7: `import { MessageFlags } from 'discord.js'`

11. `/discord/src/commands/run-command.ts`
    - Line 6: `import { MessageFlags } from 'discord.js'`

12. `/discord/src/commands/session-id.ts`
    - Line 3: `import { MessageFlags } from 'discord.js'`

13. `/discord/src/commands/share.ts`
    - Line 3: `import { MessageFlags } from 'discord.js'`

14. `/discord/src/commands/undo-redo.ts`
    - Line 3: `import { MessageFlags } from 'discord.js'`

15. `/discord/src/commands/worktree-settings.ts`
    - Line 5: `import { MessageFlags } from 'discord.js'`

### 📄 Core Utility Files

1. `/discord/src/discord-utils.ts` - Lines 5-16
   - Imports: `APIInteractionGuildMember, ChannelType, GuildMember, MessageFlags, PermissionsBitField, Guild, Message, TextChannel, ThreadChannel, REST, Routes`
   - Usage:
     - Line 40-41: `GuildMember | APIInteractionGuildMember | null` parameter
     - Line 51: `member instanceof GuildMember`
     - Line 53: `new PermissionsBitField(BigInt(member.permissions))`
     - Line 57-58: `PermissionsBitField.Flags.Administrator` + `.ManageGuild`
     - Line 71: `member.roles.cache` (discord.js cache pattern)
     - Line 111: `REST` type parameter
     - Line 124: `Routes.channel(threadId)`
     - Line 149: `Routes.channelMessageOwnReaction(...)`
     - Line 229: `Routes.channel(threadId)` 
     - Line 533: `ThreadChannel` type
     - Line 536: `Message` return type
     - Line 549: `MessageFlags.IsComponentsV2`
     - Line 598: `TextChannel | ThreadChannel` parameter
     - Line 604: `ChannelType.GuildText`
     - Line 608-611: `ChannelType.PublicThread`, `ChannelType.PrivateThread`, `ChannelType.AnnouncementThread`

2. `/discord/src/discord-urls.ts` - Line 11
   - Imports: `REST`
   - Usage:
     - Line 55: `new REST({ api: ... })`
     - Line 56: `.setToken(token)`

3. `/discord/src/utils.ts` - Line 6
   - Imports: `PermissionsBitField`
   - Usage:
     - Lines 24-39: `PermissionsBitField.Flags.*` (ViewChannel, ManageChannels, SendMessages, etc.)
     - Line 48: `new PermissionsBitField(permissions)`

4. `/discord/src/interaction-handler.ts` - Line 4
   - Imports: `MessageFlags`
   - (File is 470 lines, showing only import section)

5. `/discord/src/ipc-polling.ts` - Line 8
   - Imports: `type Client from 'discord.js'`
   - Usage: Type annotation parameter (Discord bot Client type)

6. `/discord/src/message-formatting.ts` - Line 6
   - Imports: `type Message, TextChannel from 'discord.js'`
   - Usage:
     - Line 29: `message: Message` parameter
     - Line 30: `message.content`
     - Line 33-34: `message.mentions.users` (discord.js collection)
     - Line 43: `message.mentions.roles`
     - Line 49: `channel as TextChannel` cast

7. `/discord/src/onboarding-welcome.ts` - Line 8
   - Imports: `ThreadAutoArchiveDuration, type TextChannel`
   - Usage:
     - Line 32: `channel: TextChannel` parameter
     - Line 39: `ThreadAutoArchiveDuration.OneDay`

8. `/discord/src/task-runner.ts` - Line 3
   - Imports: `type REST, Routes from 'discord.js'`
   - Usage:
     - Line 50+: `rest` parameter of type REST
     - REST methods: `.get()`, `.post()`, `.patch()`
     - Routes: `Routes.channel()`, etc.

9. `/discord/src/test-utils.ts` - Line 10
   - Imports: `type APIMessage from 'discord.js'`
   - Usage: Type annotation for message shapes from Discord API

10. `/discord/src/platform/platform-value.ts` - Line 5
    - Imports: `type Message, ThreadChannel from 'discord.js'`
    - Usage:
      - Line 9: `message: Message` parameter
      - Line 10-32: Accessing message properties (id, content, author, attachments, embeds)
      - Line 36: `thread: ThreadChannel` parameter
      - Line 39-45: Accessing thread properties (id, name, parentId, guildId, createdTimestamp)

11. `/discord/src/discord-utils.test.ts` - Line 1
    - Imports: `PermissionsBitField`
    - Usage: Test for `hasKimakiBotPermission` function

### 📋 Command Files - Type Imports

1. `/discord/src/commands/create-new-project.ts` - Line 4
   - Imports: `type TextChannel, type ThreadChannel`
   - Usage: Type parameters in function signature

### 🧪 E2E Test Files

These are test files that use discord.js test infrastructure:

1. `/discord/src/agent-model.e2e.test.ts` - Line 24
   - Imports: `ChannelType, Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder`

2. `/discord/src/event-stream-real-capture.e2e.test.ts` - Line 9
   - Imports: `ChannelType, Client, GatewayIntentBits, Partials, type APIMessage`

3. `/discord/src/kimaki-digital-twin.e2e.test.ts` - Line 8
   - Imports: `ChannelType, Client, GatewayIntentBits, Partials`

4. `/discord/src/queue-advanced-e2e-setup.ts` - Line 8
   - Imports: `ChannelType, Client, GatewayIntentBits, Partials`

5. `/discord/src/runtime-lifecycle.e2e.test.ts` - Line 14
   - Imports: `ChannelType, Client, GatewayIntentBits, Partials`

6. `/discord/src/thread-message-queue.e2e.test.ts` - Line 17
   - Imports: `ChannelType, Client, GatewayIntentBits, Partials`

7. `/discord/src/voice-message.e2e.test.ts` - Line 16
   - Imports: `ChannelType, Client, GatewayIntentBits, Partials`

---

## Symbol Usage Summary

### Most Frequently Imported:
- **MessageFlags** - 12 command files
- **REST** - 4 files (discord-utils, discord-urls, task-runner, agent-model.e2e.test)
- **Routes** - 3 files (discord-utils, task-runner, agent-model.e2e.test)
- **Type annotations** (Message, ThreadChannel, TextChannel, Client) - 7 files
- **PermissionsBitField** - 3 files (discord-utils, utils, discord-utils.test)
- **ChannelType** - 6 test files
- **Client, GatewayIntentBits, Partials** - 6 test files (Discord.js client setup)

### Direct discord.js Object Usage:
- `member instanceof GuildMember` - discord-utils.ts
- `message.mentions.users`, `message.mentions.roles` - message-formatting.ts
- `message.guild?.members.cache.get(userId)` - message-formatting.ts
- `member.roles.cache.some()` - discord-utils.ts
- `guild.roles.cache.get(roleId)` - discord-utils.ts
- `channel.guild.channels.fetch(parentId)` - discord-utils.ts
- `thread.send()`, `thread.startThread()` - onboarding-welcome.ts
- `message.startThread()` - onboarding-welcome.ts

### REST/API Usage:
- `REST` instantiation and `.get()`, `.put()`, `.patch()` calls
- `Routes` constants for Discord API endpoints
- Routes used: `Routes.channel()`, `Routes.channelMessageOwnReaction()`, etc.

---

## Files Needing Refactoring

### High Priority (Core utilities):
1. `discord-utils.ts` - 16 imports + extensive usage of discord.js internals
2. `utils.ts` - PermissionsBitField usage
3. `discord-urls.ts` - REST class instantiation

### Medium Priority (Message/Thread handling):
4. `message-formatting.ts` - Message mentions and properties
5. `onboarding-welcome.ts` - ThreadChannel and autoarchive enum
6. `task-runner.ts` - REST type + Routes

### Low Priority (Command handlers):
7-21. All 12+ command files - MessageFlags constants only
22. `interaction-handler.ts` - MessageFlags

### Test Files (May not need refactoring if staying on discord.js):
23-29. E2E test files - Use discord.js Client setup and ChannelType enums

---

## Key Refactoring Challenges

1. **PermissionsBitField.Flags.* constants** - Need replacement constants or enum
2. **MessageFlags.IsComponentsV2** - Need hardcoded constant replacement
3. **Routes constants** - Need string constant replacements
4. **instanceof GuildMember checks** - Need alternative type narrowing
5. **Discord cache patterns** (.roles.cache, .members.cache) - Need API alternative
6. **ThreadChannel.send(), startThread() methods** - Need wrapper functions
7. **APIInteractionGuildMember type** - Need platform-agnostic type

