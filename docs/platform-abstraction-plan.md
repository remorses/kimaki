---
title: Platform Abstraction Plan — Discord + Slack
description: |
  Plan for abstracting Discord-specific APIs into a platform-independent
  KimakiAdapter interface that supports both Discord and Slack.
prompt: |
  Explored all 48 files with discord.js imports across discord/src/.
  Read the chat SDK source (opensrc/repos/github.com/vercel/chat/packages/chat)
  including types.ts, chat.ts, thread.ts, channel.ts, and index.ts.
  Compared chat SDK's Adapter interface with Kimaki's needs.
  Designed KimakiAdapter interface modeled after chat SDK patterns
  but extended for Kimaki's Gateway-first, long-running CLI architecture.
  Files referenced:
    - discord/src/**/*.ts (all 48 files with discord.js imports)
    - opensrc/repos/github.com/vercel/chat/packages/chat/src/types.ts
    - opensrc/repos/github.com/vercel/chat/packages/chat/src/chat.ts
    - opensrc/repos/github.com/vercel/chat/packages/chat/src/thread.ts
    - opensrc/repos/github.com/vercel/chat/packages/chat/src/channel.ts
---

# Platform Abstraction Plan — Discord + Slack

## 1. Current State

The codebase has **62 discord.js imports across 48 files** plus `@discordjs/voice`
in 1 file. Discord APIs are used directly throughout the bot — no abstraction layer
exists.

## 2. Reference: chat SDK (vercel/chat)

The `chat` npm package uses an **Adapter pattern** where the core `Chat` class is
platform-agnostic and each platform (Slack, Teams, GChat) implements the `Adapter`
interface. Threads and Channels delegate all platform calls through the adapter.

```
Chat (event routing, dedup, locking, state)
  └── Adapter (postMessage, editMessage, startTyping, reactions, modals, etc.)
       ├── SlackAdapter
       ├── TeamsAdapter
       └── GChatAdapter
```

## 3. Relationship with chat SDK

The chat SDK (vercel/chat) is a multi-platform chat abstraction with adapters for
Slack, Teams, and GChat. It uses a webhook-first, serverless architecture.

Kimaki's Discord adapter uses a Gateway WebSocket (persistent connection), not
webhooks, and needs capabilities chat doesn't provide (thread creation, channel
management, voice, permissions, command registration). So for **Discord**, we write
our own adapter implementation directly with discord.js.

For **Slack**, we plan to run in HTTP webhook mode instead of a long-lived
gateway client. Slack events and interaction payloads arrive over HTTP, then the
Kimaki process receives them through the exposed Hrana-backed bridge. The core
`KimakiAdapter` interface stays the same from the runtime's point of view: the
adapter still emits normalized inbound events and accepts outbound message/UI
requests. Only the transport differs.

```
KimakiAdapter interface
  ├── DiscordAdapter  → discord.js directly (Gateway + REST)
  └── SlackAdapter    → HTTP webhooks + Web API, bridged into Kimaki via Hrana
```

**Decision:** Our own `KimakiAdapter` interface is the abstraction layer. Discord
and Slack use the same runtime-facing interface, but different transports:
Discord is gateway-first, Slack is webhook-first.

## 4. Discord API Surface Area — 13 Capability Domains

| Domain | Discord API | Slack Equivalent | Parity |
|---|---|---|---|
| Messages | `channel.send()`, `message.reply()`, `message.edit()` | `chat.postMessage`, `chat.update` | Full |
| Threads | `message.startThread()`, `threads.create()`, archive | `conversations.open` (thread_ts) | Partial |
| Slash Commands | `SlashCommandBuilder`, guild-scoped registration | Slash commands via manifest | Full |
| Buttons | `ButtonBuilder`, `ActionRowBuilder` | Block Kit buttons | Full |
| Select Menus | `StringSelectMenuBuilder` | Block Kit static_select | Full |
| Modals | `ModalBuilder`, `TextInputBuilder` | `views.open`, input blocks | Full |
| Reactions | REST `channelMessageOwnReaction` | `reactions.add` | Full |
| Typing | `channel.sendTyping()` (7s pulse) | Typing indicator API | Full |
| File Uploads | FormData multipart POST | `files.uploadV2` | Full |
| Embeds | `EmbedBuilder` | Block Kit attachments | Full |
| Permissions | `GuildMember` roles, `PermissionsBitField` | Server roles, user groups | Partial |
| Channel Mgmt | `guild.channels.create()` (text, voice, category) | `conversations.create` | Partial |
| Voice | `@discordjs/voice`, `joinVoiceChannel` | No API equivalent | None |

Slack limitations:
- No categories — channels are flat
- No voice bots — Huddles have no bot API
- Thread model differs — Slack threads are `thread_ts`, not first-class objects
- Slash commands can't be invoked in threads
- 40,000 char limit vs Discord's 2,000

## 5. What Kimaki Actually Uses (audit results)

Before designing the interface, here's exactly what the codebase uses today.
This informed every decision about what to include and what to drop.

**Message sending:** Always markdown strings. The main pipeline is
`sendThreadMessage()` which splits markdown at 2000 chars, extracts GFM tables
into Components V2, and sends each chunk as `thread.send({ content, flags })`.
No AST, no raw text format, no cards, no streaming-through-messages.

**Message flags:** Only 3 patterns used everywhere:
- **silent** (default) — `SuppressEmbeds | SuppressNotifications` — AI output, tool output, status
- **notify** — `SuppressEmbeds` only — permission prompts, action buttons, completion footer
- **ephemeral** — slash command replies visible only to invoker

**Components:** Buttons and select menus, always attached to a message with
`content` text. After user interaction, components are stripped with
`{ components: [] }`. Components V2 tables rendered only for GFM table segments.

**Modals:** Two kinds — `TextInputBuilder` for text entry, `FileUploadBuilder`
for file picker. Both triggered by `interaction.showModal()`.

**Embeds:** Used in exactly 2 places:
1. Invisible YAML metadata in embed footers (`color: 0x2b2d31`) for session routing
2. Rich link preview in `/diff` command (`EmbedBuilder` with title, URL, image)

**Reactions:** `addReaction()` only, never `removeReaction()`.

**Files:** FormData multipart POST for uploads. `fetch(url)` for downloads.

## 6. Design Principle: Intent Over Mechanism

The interface models **what the caller wants** (intent), not **how each platform
does it** (mechanism). All platform-specific complexity lives inside the adapters.
The call site never writes platform-conditional code.

Examples:

**Autocomplete → resolved by adapter before handler runs**

The caller declares "this option has dynamic choices". The adapter figures out
how to collect the user's selection:
- Discord: inline autocomplete as user types
- Slack: shows a select menu after command submission, waits for pick, then
  delivers the resolved value to the handler

The command handler never knows which UX was used — it just receives final values.

**Tables → adapter renders platform-native format**

The caller sends markdown with GFM tables. The adapter owns the rendering:
- Discord: parses tables out, renders as Components V2 containers
- Slack: sends as-is — Slack renders GFM tables natively

No table types in the interface.

**Buttons → adapter translates styles**

The caller specifies `style: 'success'`. The adapter maps it:
- Discord: `ButtonStyle.Success` (green)
- Slack: `"primary"` (green) in Block Kit

**Ephemeral messages → adapter picks the mechanism**

The caller sets `ephemeral: true`. The adapter handles it:
- Discord: `MessageFlags.Ephemeral` on interaction reply
- Slack: `response_type: "ephemeral"` in webhook response

## 7. KimakiAdapter Interface (revised)

The previous draft still leaked too much Discord structure into the base
interface. The main fix is replacing a bare `threadId` with a richer
`ConversationRef`.

### 7.1 Why `ConversationRef` instead of `threadId`

Slack **does** have threads, but they are not first-class channels. A Slack
thread is addressed as:

- parent channel ID
- thread timestamp (`thread_ts`)

Discord threads are also not truly standalone from Kimaki's point of view:

- they always belong to a parent channel
- permissions and channel config often come from the parent channel
- thread creation often starts from a parent-channel message

So the cross-platform identity should be "conversation inside a space", not
"thread object".

```ts
type ConversationRef = {
  spaceId: string
  channelId: string
  threadId?: string
}
```

This keeps Slack threads supported while avoiding a Discord-shaped API.

### 7.2 Keep the base adapter small

The base adapter should only cover shared chat transport and interactive UI.
Do **not** put these in the base interface:

- voice
- forum sync
- categories
- role creation
- Discord-only onboarding
- other platform admin/setup flows

Those belong in optional platform sidecars.

### 7.2.1 Rendering should be intent-level, not Discord-widget-level

The shared API should preserve current Discord UX without forcing the core to
build Discord-specific components.

The core should describe **intent**:

- markdown content
- a few structured UI primitives (buttons, selects, modals)
- optional row/context actions for things like `/worktrees`
- autocomplete intent for command options

The adapter should decide **rendering**:

- Discord: Components V2, action rows, select menus, modals, native autocomplete
- Slack: Block Kit, selects, modal views, webhook/Web API interaction flows

This keeps current Discord features like selects in messages, autocomplete, and
table-adjacent actions, while still allowing Slack to render them differently.

Important constraint: **HTML should not be the canonical shared UI format**.
The shared layer should use typed UI items, not HTML snippets, because typed
items are easier to validate, test, and map cleanly to Discord and Slack.

### 7.2.2 Inbound message handling should be a single `onMessage`

`onThreadMessage` and `onChannelMessage` were removed on purpose.

Why:

- Slack ingress is naturally a single webhook entry that dispatches by payload type
- a Slack thread is still just a message in a channel with a thread reference
- Discord also benefits from a single normalized message event with conversation context
- most core routing logic only needs to know where the message belongs, not which native event family produced it

The adapter should normalize all inbound chat messages to one event shape and
include enough context for the core to branch when needed.

```ts
type MessageContext = {
  conversation: ConversationRef
  kind: 'channel' | 'thread'
  parentChannelId?: string
  isMention: boolean
}
```

So the core still knows whether the message came from a top-level channel or a
thread, but it does not need separate adapter subscriptions for each platform.

This follows the same general direction as Vercel Chat's Slack adapter: one
webhook entry point, one normalized message flow, then internal/core dispatch.

### 7.3 Shared types

```ts
interface ConversationRef {
  spaceId: string
  channelId: string
  threadId?: string
}

interface PlatformUser {
  userId: string
  username: string
  displayName: string
  isBot: boolean
  isMe: boolean
}

interface PlatformAttachment {
  filename: string
  url: string
  contentType?: string
  size: number
}

interface PlatformMessage {
  id: string
  conversation: ConversationRef
  content: string
  author: PlatformUser
  attachments: PlatformAttachment[]
  metadata?: Record<string, unknown>
}

interface OutgoingFile {
  filename: string
  data: Buffer
  contentType?: string
}

interface UiButton {
  id: string
  label: string
  style: 'primary' | 'secondary' | 'success' | 'danger'
}

interface UiSelectMenu {
  id: string
  placeholder: string
  options: Array<{ label: string; value: string; description?: string }>
  maxValues?: number
}

interface UiRowActions {
  rows: Array<{
    key: string
    actions: UiButton[]
  }>
}

interface UiModal {
  id: string
  title: string
  inputs: Array<
    | { type: 'text'; id: string; label: string; placeholder?: string; required?: boolean; style: 'short' | 'paragraph' }
    | { type: 'file'; id: string; label: string; description?: string; maxFiles?: number }
  >
}

interface OutgoingMessage {
  markdown: string
  visibility?: 'normal' | 'silent' | 'ephemeral'
  replyToMessageId?: string
  buttons?: UiButton[]
  selectMenu?: UiSelectMenu
  rowActions?: UiRowActions
  files?: OutgoingFile[]
  metadata?: Record<string, unknown>
}
```

### 7.4 The base adapter

```ts
interface KimakiAdapter {
  readonly name: 'discord' | 'slack'
  readonly botUserId: string
  readonly botUsername: string
  readonly capabilities: {
    threads: boolean
    ephemeralMessages: boolean
    typing: boolean
    adminChannels: boolean
  }

  start(): Promise<void>
  destroy(): Promise<void>

  sendMessage(
    conversation: ConversationRef,
    message: OutgoingMessage,
  ): Promise<{ messageId: string }>

  updateMessage(
    conversation: ConversationRef,
    messageId: string,
    message: OutgoingMessage,
  ): Promise<void>

  deleteMessage(
    conversation: ConversationRef,
    messageId: string,
  ): Promise<void>

  startTyping(conversation: ConversationRef): Promise<void>

  createThread(input: {
    conversation: ConversationRef
    name: string
    messageId?: string
    autoArchiveMinutes?: number
  }): Promise<ConversationRef>

  archiveThread(conversation: ConversationRef): Promise<void>
  renameThread(conversation: ConversationRef, name: string): Promise<void>
  addThreadMember?(conversation: ConversationRef, userId: string): Promise<void>

  fetchMessage(
    conversation: ConversationRef,
    messageId: string,
  ): Promise<PlatformMessage | null>

  fetchMessages(
    conversation: ConversationRef,
    options?: { limit?: number; before?: string },
  ): Promise<PlatformMessage[]>

  resolveMentions(
    content: string,
    conversation: ConversationRef,
  ): Promise<string>

  listSpaces(): Promise<Array<{
    id: string
    name: string
    ownerId?: string
    memberCount?: number
  }>>

  searchMembers(input: {
    spaceId: string
    query: string
  }): Promise<Array<{
    userId: string
    username: string
    displayName: string
    isOwner?: boolean
    isAdmin?: boolean
    roles?: string[]
  }>>

  createChannel?(input: {
    spaceId: string
    name: string
    type: 'text' | 'voice'
    parentId?: string
    topic?: string
  }): Promise<{ channelId: string }>

  encodeConversationRef?(conversation: ConversationRef): string
  decodeConversationRef?(value: string): ConversationRef

  onReady(handler: () => void): void
  onMessage(handler: (event: {
    message: PlatformMessage
    context: MessageContext
  }) => void): void
  onCommand(handler: (event: CommandEvent) => void): void
  onButton(handler: (event: ButtonEvent) => void): void
  onSelectMenu(handler: (event: SelectMenuEvent) => void): void
  onModalSubmit(handler: (event: ModalSubmitEvent) => void): void
  onError(handler: (error: Error) => void): void
}
```

### 7.4.1 Shared command definition should express autocomplete intent

Command definitions should also stay high-level. The core defines whether an
option has static choices or dynamic choice resolution. The adapter chooses the
native mechanism.

```ts
interface CommandOptionDefinition {
  name: string
  description: string
  type: 'string' | 'integer' | 'boolean' | 'number'
  required?: boolean
  choices?: Array<{ name: string; value: string }>
  resolveChoices?: (
    query: string,
  ) => Promise<Array<{ name: string; value: string }>>
}

interface CommandDefinition {
  name: string
  description: string
  options?: CommandOptionDefinition[]
}
```

Rendering examples:

- Discord: native slash autocomplete interactions
- Slack: external select, follow-up select, or equivalent webhook-driven choice UI

This keeps `/resume`, `/model`, `/agent`, and similar flows fully supported.

### 7.5 What stays outside the adapter

These should be separate services, called by the core only when the platform
supports them:

- `DiscordVoiceService`
- `DiscordForumSyncService`
- `DiscordWorkspaceProvisioner`
- `SlackInstallService`

This keeps the base adapter small and lets the runtime keep using the same API in
Discord gateway mode and Slack webhook mode.

## 8. Before / After Examples

### Command with autocomplete (e.g. /resume)

**Before (Discord-specific, 2 separate handlers):**
```ts
// commands/resume.ts — handler
export async function handleResumeCommand(ctx: CommandContext) {
  const sessionId = ctx.interaction.options.getString('session', true)
  // ... resume logic
}

// commands/resume.ts — autocomplete (separate handler, separate event)
export async function handleResumeAutocomplete(ctx: AutocompleteContext) {
  const focused = ctx.interaction.options.getFocused()
  const sessions = await session.list({ directory })
  const filtered = sessions.filter(s => s.id.includes(focused))
  await ctx.interaction.respond(
    filtered.map(s => ({ name: s.id, value: s.id }))
  )
}

// cli.ts — register with autocomplete flag
new SlashCommandBuilder()
  .setName('resume')
  .addStringOption(o => o
    .setName('session')
    .setAutocomplete(true)
    .setRequired(true))
```

**After (platform-agnostic, single declaration):**
```ts
// Command definition — declares intent, not mechanism
const resumeCommand: CommandDefinition = {
  name: 'resume',
  description: 'Resume an existing session',
  options: [{
    name: 'session',
    description: 'Session to resume',
    type: 'string',
    required: true,
    // Adapter calls this to get choices.
    // Discord: inline autocomplete. Slack: external_select menu.
    resolve: async (query) => {
      const sessions = await session.list({ directory })
      return sessions
        .filter(s => s.id.includes(query))
        .map(s => ({ name: `${s.id} (${s.age})`, value: s.id }))
    },
  }],
}

// Command handler — just gets the final value
adapter.onCommand(async (event) => {
  if (event.commandName !== 'resume') { return }
  const sessionId = event.options.session as string
  // ... resume logic — no autocomplete code here
})
```

### Buttons (e.g. permission prompt)

```ts
// Platform-agnostic — identical call site for Discord and Slack
await adapter.sendMessage(conversation, {
  markdown: 'Allow edit to `src/config.ts`?',
  visibility: 'normal',
  buttons: [
    { id: `perm:${hash}:accept`, label: 'Accept', style: 'success' },
    { id: `perm:${hash}:always`, label: 'Accept Always', style: 'primary' },
    { id: `perm:${hash}:deny`, label: 'Deny', style: 'danger' },
  ],
})

// Button handler — same for both platforms
adapter.onButton(async (event) => {
  if (!event.buttonId.startsWith('perm:')) { return }
  const [, hash, action] = event.buttonId.split(':')
  // ... handle permission response
  await event.update({ content: `Permission ${action}ed.` })
})
```

### Select menu (e.g. model picker)

```ts
// Step 1: show provider menu
await event.editReply({
  content: 'Select a provider:',
  ephemeral: true,
  selectMenu: {
    id: `model:${hash}:provider`,
    placeholder: 'Choose provider',
    options: providers.map(p => ({
      label: p.name,
      value: p.id,
    })),
  },
})

// Step 2: on selection, show models for that provider
adapter.onSelectMenu(async (event) => {
  if (!event.menuId.startsWith('model:')) { return }
  const [, hash, step] = event.menuId.split(':')
  if (step === 'provider') {
    const models = await getModels(event.selectedValues[0])
    await event.update({
      content: 'Select a model:',
      selectMenu: {
        id: `model:${hash}:model`,
        placeholder: 'Choose model',
        options: models.map(m => ({ label: m.name, value: m.id })),
      },
    })
  }
})
```

### Modal (e.g. API key entry)

```ts
// Trigger modal from button click
adapter.onButton(async (event) => {
  if (event.buttonId !== 'set-api-key') { return }
  await event.showModal({
    id: 'api-key-modal',
    title: 'Enter API Key',
    inputs: [{
      type: 'text',
      id: 'key',
      label: 'API Key',
      placeholder: 'sk-...',
      style: 'short',
    }],
  })
})

// Handle submission — same for both platforms
adapter.onModalSubmit(async (event) => {
  if (event.modalId !== 'api-key-modal') { return }
  const key = event.values.key
  await saveApiKey(key)
  await event.reply({ content: 'API key saved.', ephemeral: true })
})
```

## 9. Migration Architecture

```
Current:
  discord-bot.ts ──→ discord.js directly
                 ──→ discord-utils.ts (discord.js)
                 ──→ commands/* (discord.js types)

Target:
  discord-bot.ts ──→ KimakiAdapter interface
                      ├── discord-adapter.ts (gateway + REST)
                      └── slack-adapter.ts (HTTP events + Web API via Hrana bridge)
```

The `discord-adapter.ts` wraps all discord.js code currently scattered across
`discord-utils.ts`, `discord-urls.ts`, `channel-management.ts`, and
`interaction-handler.ts` into a single adapter implementation.

The `slack-adapter.ts` receives inbound Slack HTTP webhooks and interaction
payloads through the exposed Hrana-backed bridge, normalizes them into the same
runtime-facing events, and uses Slack Web API methods for outbound sends and
updates.

The adapter boundary should be split like this:

```text
Core runtime / command logic
  -> markdown
  -> typed UI primitives
  -> command definitions with autocomplete intent
  -> row/context actions

Adapter
  -> single webhook/gateway ingress
  -> native message rendering
  -> native buttons/selects/modals
  -> native autocomplete behavior
  -> platform transport details
```

Notes from Vercel Chat Slack adapter research:

- Slack uses one `handleWebhook(request)` entry and internally routes message,
  slash command, action, and modal payloads
- Slack thread identity is channel + thread timestamp, not a standalone thread object
- opaque adapter-owned thread encoding is useful at boundaries; for Kimaki we can
  keep `ConversationRef` in the core and optionally let adapters encode/decode it
  when they need a compact string form

## 10. Files Requiring Updates — By Migration Tier

### Tier 1: Core Infrastructure (must change first)

| File | Discord APIs Used | What Changes |
|---|---|---|
| `discord-bot.ts` | `Client`, `Events.*`, `GatewayIntentBits`, `Partials`, `Message`, `ThreadChannel`, `TextChannel` | Replace with `adapter.onMessage()`, `.onReady()`, `.createThread()`, `.sendMessage()`. Main event loop. Normalize thread and channel events into one inbound message flow. |
| `discord-urls.ts` | `REST` factory, base URL config | Moves inside `DiscordAdapter` |
| `discord-utils.ts` | `sendThreadMessage`, `archiveThread`, `reactToThread`, `hasKimakiBotPermission`, `uploadFilesToDiscord`, `splitMarkdownForDiscord`, `resolveTextChannel`, `resolveWorkingDirectory`, `getKimakiMetadata` | Split: platform-agnostic utils stay, Discord-specific ops move into `DiscordAdapter` |
| `interaction-handler.ts` | `Events.InteractionCreate`, `Interaction`, `MessageFlags` | Replace with `adapter.onCommand()`, `.onButton()`, `.onSelectMenu()`, `.onModalSubmit()` dispatchers. Keep native rendering inside the adapter. |
| `commands/types.ts` | `ChatInputCommandInteraction`, `AutocompleteInteraction`, `StringSelectMenuInteraction` | Replace with `CommandEvent`, `AutocompleteEvent`, `SelectMenuEvent` |
| `format-tables.ts` | `APIContainerComponent`, `APITextDisplayComponent`, `APISeparatorComponent`, `SeparatorSpacingSize` | Move to Discord adapter; core emits markdown plus optional row actions |
| `channel-management.ts` | `Guild`, `CategoryChannel`, `ChannelType`, `TextChannel` | Split into optional workspace/admin provisioner. Keep categories out of the base adapter. |

### Tier 2: Session Handler

| File | Discord APIs Used | What Changes |
|---|---|---|
| `session-handler/thread-session-runtime.ts` | `ThreadChannel`, `ChannelType`, `thread.sendTyping()` | Replace `ThreadChannel` with `ConversationRef` + `adapter.*` methods |

### Tier 3: Command Handlers (30+ files)

Every command file uses Discord interaction types. They all switch from
`ChatInputCommandInteraction` → `CommandEvent`, `ButtonInteraction` → `ButtonEvent`, etc.

| File | Key Discord APIs | What Changes |
|---|---|---|
| `commands/permissions.ts` | `ButtonBuilder`, `ButtonStyle`, `ButtonInteraction` | Emit typed button intents; adapter renders native buttons |
| `commands/action-buttons.ts` | `ButtonBuilder`, `ButtonStyle`, `ActionRowBuilder` | Emit typed button intents |
| `commands/ask-question.ts` | `StringSelectMenuBuilder`, `StringSelectMenuInteraction` | Emit typed select intents |
| `commands/file-upload.ts` | `ModalBuilder`, `FileUploadBuilder`, `ButtonBuilder` | Emit typed modal + file-upload intents |
| `commands/model.ts` | `StringSelectMenuBuilder` (4-step chained flow) | Typed select intents + command autocomplete intent |
| `commands/agent.ts` | `StringSelectMenuBuilder` | Typed select intents + command autocomplete intent |
| `commands/login.ts` | `ModalBuilder`, `TextInputBuilder`, `StringSelectMenuBuilder` | Typed modal + select intents |
| `commands/gemini-apikey.ts` | `ModalBuilder`, `TextInputBuilder` | Typed modal intents |
| `commands/fork.ts` | `StringSelectMenuBuilder`, `ThreadAutoArchiveDuration` | Select menu + `.createThread()` returning `ConversationRef` |
| `commands/worktree.ts` | `REST`, `TextChannel`, `ThreadChannel`, `Message` | Adapter methods + `ConversationRef` |
| `commands/resume.ts` | `ThreadAutoArchiveDuration`, `TextChannel` | `.createThread()` with channel + optional thread identity |
| `commands/session.ts` | `ChannelType`, `TextChannel` | `.createThread()` with channel + optional thread identity |
| `commands/create-new-project.ts` | `Guild`, `TextChannel` | `.createChannel()` |
| `commands/diff.ts` | `EmbedBuilder` | Render as markdown + optional actions; avoid embed-specific core types |
| `commands/verbosity.ts` | `StringSelectMenuBuilder` | Platform select menu |
| `commands/merge-worktree.ts` | `ThreadChannel` | Thread ID + `.postMessage()` |
| `commands/queue.ts` | `ChannelType`, `ThreadChannel` | Thread/channel ID checks |
| `commands/abort.ts` | `ChannelType`, `TextChannel`, `ThreadChannel` | Channel/thread ID |
| `commands/compact.ts` | Same pattern | Same |
| `commands/share.ts` | Same pattern | Same |
| `commands/context-usage.ts` | Same pattern | Same |
| `commands/session-id.ts` | Same pattern | Same |
| `commands/undo-redo.ts` | Same pattern | Same |
| `commands/run-command.ts` | Same pattern | Same |
| `commands/stop-opencode-server.ts` | Same pattern | Same |
| `commands/restart-opencode-server.ts` | Same pattern | Same |
| `commands/upgrade.ts` | Same pattern | Same |
| `commands/user-command.ts` | `TextChannel`, `ThreadChannel` | Same |
| `commands/mention-mode.ts` | `ChatInputCommandInteraction` | `CommandEvent` |
| `commands/worktree-settings.ts` | `ChatInputCommandInteraction` | `CommandEvent` |
| `commands/unset-model.ts` | `ChatInputCommandInteraction` | `CommandEvent` |

### Tier 4: Voice (Discord-only, optional adapter method)

| File | Discord APIs Used | What Changes |
|---|---|---|
| `voice-handler.ts` | `@discordjs/voice`, `VoiceState`, `VoiceChannel`, `Events.VoiceStateUpdate` | Keep as Discord-specific. Guard with `if (adapter.joinVoice)`. Slack has no voice bot API. |

### Tier 5: Forum Sync (Discord-specific feature)

| File | Discord APIs Used | What Changes |
|---|---|---|
| `forum-sync/discord-operations.ts` | `ForumChannel`, `Client`, `ChannelType` | Keep as Discord-only module |
| `forum-sync/sync-to-discord.ts` | `ForumChannel`, `Client`, `MessageFlags` | Same |
| `forum-sync/sync-to-files.ts` | `ForumChannel`, `ThreadChannel` | Same |
| `forum-sync/watchers.ts` | `Events.*`, `Client`, `Message`, `ChannelType` | Same |
| `forum-sync/markdown.ts` | `Message` type-only | Same |
| `forum-sync/types.ts` | `Client` type-only | Same |

### Tier 6: Supporting Files

| File | Discord APIs Used | What Changes |
|---|---|---|
| `cli.ts` | `SlashCommandBuilder`, `REST`, `Routes`, `Events`, `Client`, `AttachmentBuilder`, `Guild` | Command registration → adapter command-definition registration. OAuth stays platform-specific. |
| `opencode-plugin.ts` | `Routes.guildMembersSearch`, `REST` | Replace with `adapter.searchMembers()` |
| `task-runner.ts` | `REST`, `Routes.channelMessages`, `Routes.threads` | Replace with `adapter.sendMessage()`, `adapter.createThread()` |
| `message-formatting.ts` | `Message` type, `TextChannel` | Replace with `PlatformMessage` |
| `utils.ts` | `PermissionsBitField` | Move to Discord adapter |
| `ipc-polling.ts` | `Client` | Replace with `KimakiAdapter` |
| `test-utils.ts` | `APIMessage` | Replace with `PlatformMessage` |

### Tier 7: E2E Tests (7 files)

All test files create discord.js `Client` instances — need a
`createTestAdapter()` factory.

## 11. Implementation Order

1. Create `ConversationRef`, `OutgoingMessage`, and the smaller `KimakiAdapter` interface in `discord/src/platform/types.ts`
2. Create `DiscordAdapter` in `discord/src/platform/discord-adapter.ts` wrapping existing discord.js code
3. Update `discord-bot.ts` and `thread-session-runtime.ts` to speak `ConversationRef`
4. Update `commands/types.ts` to use platform-agnostic event types
5. Move interactive UI building out of command handlers and into typed UI primitives rendered by adapters
6. Split Discord-only sidecars (`voice`, `forum-sync`, workspace provisioning`) from the base adapter
7. Create `SlackAdapter` in `discord/src/platform/slack-adapter.ts` using HTTP webhooks + Web API through the Hrana bridge
8. Add platform selection to `cli.ts` startup
