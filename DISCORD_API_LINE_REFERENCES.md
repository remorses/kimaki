# Discord.js API Usage - Exact Line References

## channel-management.ts (Lines 5-10: Imports)

```typescript
import {
  ChannelType,           // ← Line 6
  type CategoryChannel,  // ← Line 7
  type Guild,            // ← Line 8
  type TextChannel,      // ← Line 9
} from 'discord.js'
```

**Usage Sites:**
- **ChannelType.GuildCategory** → Line 34
- **CategoryChannel** → Line 27 (return type), Line 40 (cast)
- **Guild** → Line 25 (parameter), Line 46, 104, 122, etc.
- **TextChannel** → Line 161 (cast), Line 97 (parameter type)

**Critical Functions:**
- `ensureKimakiCategory(guild: Guild)` → Lines 24-50
  - guild.channels.cache.find() at line 32
  - guild.channels.create() at line 46
- `ensureKimakiAudioCategory(guild: Guild)` → Lines 52-79
  - guild.channels.create() at line 75
- `createProjectChannels({guild, ...})` → Lines 81-142
  - guild.channels.create() at lines 104, 122
- `getChannelsWithDescriptions(guild: Guild)` → Lines 151-176
  - guild.channels.cache.filter() at line 156
  - TextChannel cast at line 161

---

## html-actions.ts (Lines 6-10: Imports)

```typescript
import {
  ComponentType,        // ← Line 7
  MessageFlags,         // ← Line 8
  type ButtonInteraction, // ← Line 9
} from 'discord.js'
```

**Usage Sites:**
- **ComponentType.TextDisplay** → Line 141
- **ComponentType.Button** → Line 227 (indirectly via format-tables)
- **MessageFlags.Ephemeral** → Line 112
- **MessageFlags.IsComponentsV2** → Line 145
- **ButtonInteraction** → Line 23 (type in callback signature)

**Key Functions:**
- `handleHtmlActionButton(interaction: ButtonInteraction)` → Lines 100-151
  - interaction.customId at line 103
  - interaction.reply() at lines 110, 119
  - interaction.deferUpdate() at line 126
  - interaction.editReply() at line 138

---

## format-tables.ts (Lines 6-17: Imports)

```typescript
import { Lexer, type Token, type Tokens } from 'marked'
import {
  ButtonStyle,               // ← Line 8
  ComponentType,             // ← Line 9
  SeparatorSpacingSize,      // ← Line 10
  type APIActionRowComponent, // ← Line 11
  type APIButtonComponent,    // ← Line 12
  type APIContainerComponent, // ← Line 13
  type APITextDisplayComponent, // ← Line 14
  type APISeparatorComponent, // ← Line 15
  type APIMessageTopLevelComponent, // ← Line 16
} from 'discord.js'
```

**Usage Sites:**
- **ButtonStyle.Primary/Secondary/Success/Danger** → Lines 389-407 (toButtonStyle function)
- **ComponentType.TextDisplay** → Lines 191, 243
- **ComponentType.Button** → Line 227
- **ComponentType.Separator** → Line 126
- **ComponentType.ActionRow** → Line 236
- **ComponentType.Container** → Line 135
- **SeparatorSpacingSize.Small** → Line 128
- **API component types** → Used as return types throughout

**Key Functions:**
- `buildTableComponents(table, options)` → Lines 99-144
- `toButtonStyle(variant)` → Lines 389-408
- Return type `APIMessageTopLevelComponent[]` used in ContentSegment

---

## task-runner.ts (Line 3: Imports)

```typescript
import { type REST, Routes } from 'discord.js'
// ← Line 3
```

**Usage Sites:**
- **REST** (type) → Line 54 (parameter), Line 233 (local var)
- **Routes.channelMessages(id)** → Lines 78, 131
- **Routes.threads(channelId, messageId)** → Line 159
- **Routes.threadMembers(threadId, userId)** → Line 187

**Key Functions:**
- `executeThreadScheduledTask({rest, ...})` → Lines 49-93
  - rest.post(Routes.channelMessages(...)) at line 78
- `executeChannelScheduledTask({rest, ...})` → Lines 95-197
  - rest.post(Routes.channelMessages(...)) at line 131
  - rest.post(Routes.threads(...)) at line 159
  - rest.put(Routes.threadMembers(...)) at line 187

---

## discord-urls.ts (Line 11: Imports)

```typescript
import { REST } from 'discord.js'
// ← Line 11
```

**Usage Sites:**
- **REST** constructor → Line 56
  - `new REST({ api: getDiscordRestApiUrl() }).setToken(token)`

**Key Function:**
- `createDiscordRest(token: string): REST` → Lines 55-57

**Callers:**
- task-runner.ts:4 - `import { createDiscordRest }`
- cli.ts:85 - `import { createDiscordRest, ...`

---

## message-formatting.ts (Lines 5-6: Imports)

```typescript
import type { Part, FilePartInput } from '@opencode-ai/sdk/v2'
import type { Message, TextChannel } from 'discord.js'
// ← Line 6
```

**Usage Sites:**
- **Message** (type) → Line 29 (function parameter: `resolveMentions(message: Message)`)
- **TextChannel** (type) → Line 49 (type cast: `channel as TextChannel`)

**Problem Functions:**
- `resolveMentions(message: Message): string` → Lines 29-54
  - Accesses `message.mentions.users` at line 33
  - Accesses `message.mentions.roles` at line 43
  - Accesses `message.mentions.channels` at line 48
  - Accesses `message.guild?.members.cache` at line 34
  - Type cast `channel as TextChannel` at line 49

---

## onboarding-welcome.ts (Lines 8: Imports)

```typescript
import { ThreadAutoArchiveDuration, type TextChannel } from 'discord.js'
// ← Line 8
```

**Usage Sites:**
- **ThreadAutoArchiveDuration.OneDay** → Line 39
- **TextChannel** (type) → Line 32 (parameter type)

**Problem Function:**
- `sendWelcomeMessage({channel, mentionUserId})` → Lines 28-49
  - `channel: TextChannel` parameter at line 32
  - `channel.send(text)` at line 36
  - `message.startThread({...})` at line 37
  - `thread.send(text)` at line 42

---

## ipc-polling.ts (Line 8: Imports)

```typescript
import type { Client } from 'discord.js'
// ← Line 8
```

**Usage Sites:**
- **Client** (type) → Line 76 (parameter type in dispatchRequest)

**Problem Code:**
- `startIpcPolling({discordClient}: {discordClient: Client})` → Lines 259-319
  - `discordClient.channels.fetch(req.thread_id)` at line 102
  - `thread?.isThread()` at line 119 (and line 209)

**Dispatch Function:**
- `dispatchRequest({req, discordClient})` → Lines 71-242
  - Uses discordClient.channels.fetch() in both 'file_upload' and 'action_buttons' cases

---

## utils.ts (Line 6: Imports)

```typescript
import { PermissionsBitField } from 'discord.js'
// ← Line 6
```

**Usage Sites:**
- **PermissionsBitField.Flags.ViewChannel** → Line 24
- **PermissionsBitField.Flags.ManageChannels** → Line 25
- **PermissionsBitField.Flags.SendMessages** → Line 26
- **PermissionsBitField.Flags.SendMessagesInThreads** → Line 27
- **PermissionsBitField.Flags.CreatePublicThreads** → Line 28
- **PermissionsBitField.Flags.ManageThreads** → Line 29
- **PermissionsBitField.Flags.ReadMessageHistory** → Line 30
- **PermissionsBitField.Flags.AddReactions** → Line 31
- **PermissionsBitField.Flags.ManageMessages** → Line 32
- **PermissionsBitField.Flags.UseExternalEmojis** → Line 33
- **PermissionsBitField.Flags.AttachFiles** → Line 34
- **PermissionsBitField.Flags.Connect** → Line 35
- **PermissionsBitField.Flags.Speak** → Line 36
- **PermissionsBitField.Flags.ManageRoles** → Line 37
- **PermissionsBitField.Flags.ManageEvents** → Line 38
- **PermissionsBitField.Flags.CreateEvents** → Line 39
- **PermissionsBitField constructor** → Line 48

**Key Function:**
- `generateBotInstallUrl({clientId, permissions, ...})` → Lines 21-77
  - Default permissions array at lines 23-40
  - Constructor usage at line 48
  - `.bitfield.toString()` at line 49

---

## commands/queue.ts (Line 3: Imports)

```typescript
import { MessageFlags } from 'discord.js'
// ← Line 3
```

**Usage Sites:**
- **MessageFlags.Ephemeral** → Line 32 (and other reply locations)

**Usage Pattern:**
- Used in `command.reply({flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS})`

---

## commands/merge-worktree.ts

No discord.js imports. Uses `PlatformThread` from adapter types only.

---

## cli.ts (Lines 74-84: Key Imports)

```typescript
import {
  Events,                 // ← Line 74
  ChannelType,            // ← Line 75
  ActivityType,           // ← Line 76
  type PresenceStatusData, // ← Line 77
  type CategoryChannel,    // ← Line 78
  type Guild,              // ← Line 79
  type REST,               // ← Line 80
  Routes,                  // ← Line 81
  SlashCommandBuilder,     // ← Line 82
  AttachmentBuilder,       // ← Line 83
} from 'discord.js'
```

**Usage Sites:**
- **REST** → Line 80 (parameter type)
- **Routes.applicationCommands(appId)** → Line 696
- **Routes.applicationCommand(appId, id)** → Line 716
- **SlashCommandBuilder** → Lines 757, 771, 803, 831, etc. (many command definitions)
- **AttachmentBuilder** → Not found in first 150 lines (search from line 150+)
- **CategoryChannel** → Line 78 (type)
- **Guild** → Line 79 (type)
- **ChannelType** → Line 75 (type)

---

## discord-bot.ts (Lines 97-99: Key Imports)

```typescript
import {
  Client,                    // ← Line 97
  Events,                    // ← Line 98
  ThreadAutoArchiveDuration, // ← Line 99
} from 'discord.js'
```

**Usage Sites:**
- **Client** (type) → Line 235 (parameter), Line 280 (type)
- **Client.isReady()** → Line 329
- **Client.once()** → Line 332
- **Client.on()** → Lines 335, 339, 347, 357, etc.
- **Events.ClientReady** → Line 332
- **Events.Error** → Line 335
- **Events.ShardError** → Line 339
- **Events.ShardDisconnect** → Line 347
- **Events.ShardReconnecting** → Line 357
- **Events.ShardResume** → Line 375
- **Events.ShardReady** → Line 392
- **Events.Invalidated** → Line 402
- **ThreadAutoArchiveDuration.OneDay** → Line 762

