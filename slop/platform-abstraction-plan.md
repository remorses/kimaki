---
title: Platform Abstraction Plan — Discord + Slack
description: |
  Plan for abstracting Discord-specific APIs into a platform-independent
  KimakiAdapter interface that supports both Discord and Slack.
prompt: |
  Explored all 48 files with discord.js imports across cli/src/.
  Read the chat SDK source (opensrc/repos/github.com/vercel/chat/packages/chat)
  including types.ts, chat.ts, thread.ts, channel.ts, and index.ts.
  Compared chat SDK's Adapter interface with Kimaki's needs.
  Designed KimakiAdapter interface modeled after chat SDK patterns
  but extended for Kimaki's Gateway-first, long-running CLI architecture.
  Files referenced:
    - cli/src/**/*.ts (all 48 files with discord.js imports)
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

For **Slack**, we plan to use chat SDK as a dependency. The `SlackAdapter`
implementation will wrap chat's Slack adapter internally, translating between
Kimaki's `KimakiAdapter` interface and chat's `Adapter` interface. This gives us
battle-tested Slack support (Block Kit rendering, event parsing, OAuth) without
reimplementing it.

```
KimakiAdapter interface
  ├── DiscordAdapter  → discord.js directly (Gateway + REST)
  └── SlackAdapter    → chat SDK's Slack adapter under the hood (webhooks)
```

**Decision:** Our own `KimakiAdapter` interface as the abstraction layer. Discord
adapter is standalone. Slack adapter wraps chat SDK. Method naming follows chat's
conventions where they overlap for consistency.

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

## 7. KimakiAdapter Interface (simplified)

Removed from chat SDK patterns: `{ raw: string }` format, `{ ast: Root }`,
cards/JSX, streaming-through-messages, StateAdapter, dedup/locking,
subscription model, `SentMessage.edit()/.delete()` on returned objects.

```ts
// ─── Shared Types ─────────────────────────────────────────
// These are referenced across multiple methods and events.

interface PlatformMessage {
  id: string
  channelId: string
  threadId?: string
  content: string
  author: {
    userId: string
    username: string
    displayName: string
    isBot: boolean
    isMe: boolean
  }
  attachments: Array<{
    filename: string
    url: string
    contentType?: string
    size: number
  }>
  /**
   * Invisible metadata attached to this message.
   * Discord: parsed from embed footer YAML (ThreadStartMarker etc.)
   * Slack: parsed from message metadata event payload.
   */
  metadata?: Record<string, unknown>
}

// ─── The Adapter ──────────────────────────────────────────

interface KimakiAdapter {
  readonly name: string         // 'discord' | 'slack'
  readonly botUserId: string
  readonly botUsername: string   // for channel naming, mention detection

  // ── Lifecycle ──
  login(token: string): Promise<void>
  destroy(): Promise<void>

  // ── Messages ──
  // Content is always markdown. The adapter owns the full rendering
  // pipeline for its platform:
  //
  // DiscordAdapter.send():
  //   1. splitTablesFromMarkdown(content) → segments
  //   2. Table segments → Components V2 (ContainerBuilder, TextDisplay)
  //   3. Text segments → escapeBackticks, limitHeadingDepth, splitAt2000
  //   4. Each chunk → thread.send({ content, flags })
  //
  // SlackAdapter.send():
  //   1. Convert markdown to Slack mrkdwn (bold, links, code blocks)
  //   2. GFM tables render natively in Slack — no conversion needed
  //   3. Split at 40,000 chars if needed (rare)
  //   4. Each chunk → chat.postMessage({ channel, text, thread_ts })
  //
  // This means no table/CV2 types leak into the interface. The caller
  // just passes markdown and the adapter decides how to render it.
  send(threadId: string, options: {
    /** Markdown content. Adapter handles splitting and formatting. */
    content: string
    /** Suppress notifications. Default: true (silent). */
    silent?: boolean
    /** Reply to a specific message (shows reference). */
    replyTo?: string
    /** Buttons to attach. Adapter wraps in ActionRow / Block Kit. */
    buttons?: Array<{
      id: string
      label: string
      style: 'primary' | 'secondary' | 'success' | 'danger'
    }>
    /** Select menu to attach. One per message. */
    selectMenu?: {
      id: string
      placeholder: string
      options: Array<{ label: string; value: string; description?: string }>
      maxValues?: number
    }
    /** Invisible metadata. Discord: embed footer YAML. Slack: message metadata. */
    metadata?: Record<string, unknown>
    /** File attachments to upload with the message. */
    files?: Array<{ filename: string; data: Buffer; contentType?: string }>
  }): Promise<{ id: string; threadId: string }>

  edit(threadId: string, messageId: string, content: string): Promise<void>
  delete(threadId: string, messageId: string): Promise<void>

  // ── Typing ──
  startTyping(threadId: string): Promise<void>

  // ── Reactions ──
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>

  // ── Threads ──
  createThread(options: {
    channelId: string
    name: string
    /** Create from existing message (Discord: message thread). */
    messageId?: string
    autoArchiveMinutes?: number
  }): Promise<{ threadId: string }>
  archiveThread(threadId: string): Promise<void>
  renameThread(threadId: string, name: string): Promise<void>
  addThreadMember(threadId: string, userId: string): Promise<void>

  // ── Servers ──
  // Used at startup to discover servers, create project channels,
  // and display server info in CLI onboarding.
  listServers(): Promise<Array<{
    id: string
    name: string
    ownerId: string
    memberCount: number
  }>>
  getServer(serverId: string): Promise<{
    id: string
    name: string
    ownerId: string
    memberCount: number
  } | null>

  // ── Channels ──
  createChannel(options: {
    serverId: string
    name: string
    type: 'text' | 'voice'
    parentId?: string
    topic?: string
  }): Promise<{ channelId: string }>
  createCategory?(options: {
    serverId: string
    name: string
  }): Promise<{ channelId: string }>
  getChannel(channelId: string): Promise<{
    id: string
    name: string
    type: 'text' | 'voice' | 'forum' | 'category'
    parentId?: string
    topic?: string
  } | null>
  listChannels(serverId: string): Promise<Array<{
    id: string
    name: string
    type: 'text' | 'voice' | 'forum' | 'category'
    parentId?: string
    topic?: string
  }>>

  // ── Thread Data ──
  getThread(threadId: string): Promise<{
    id: string
    name: string
    parentChannelId: string
    serverId: string
    archived: boolean
  } | null>
  fetchStarterMessage(threadId: string): Promise<PlatformMessage | null>

  // ── Message Data ──
  /** Fetch a single message by ID (for editing buttons, reading markers). */
  fetchMessage(channelOrThread: string, messageId: string): Promise<PlatformMessage | null>
  /** Paginated message history (for forum sync, thread context). */
  fetchMessages(channelOrThread: string, options?: {
    limit?: number
    before?: string
  }): Promise<PlatformMessage[]>
  /**
   * Convert platform mention syntax to display names.
   * Discord: `<@123>` → `@Tommy`, `<#456>` → `#general`
   * Slack: `<@U123>` → `@Tommy`, `<#C456|general>` → `#general`
   * Called automatically on incoming messages by the adapter,
   * so handlers receive human-readable content.
   */
  resolveMentions(content: string, serverId: string): Promise<string>

  // ── Commands ──
  // Commands declare intent (what options they need, whether choices
  // are static or dynamic). The adapter decides the mechanism:
  //   Static choices:  Discord → autocomplete list. Slack → select menu.
  //   Dynamic resolve: Discord → autocomplete on keystroke. Slack → external_select.
  //   No choices:      Discord → free text. Slack → free text.
  // The handler always receives resolved final values in event.options.
  registerCommands(serverId: string, commands: Array<{
    name: string
    description: string
    options?: Array<{
      name: string
      description: string
      type: 'string' | 'integer' | 'boolean' | 'number'
      required?: boolean
      /** Static choices. Discord: autocomplete list. Slack: select menu. */
      choices?: Array<{ name: string; value: string }>
      /**
       * Dynamic choice resolver. Called with the user's current input.
       * Discord: called on each keystroke via autocomplete interaction.
       * Slack: called via external_select typeahead, or once with ''
       *        to populate initial menu options.
       */
      resolve?: (query: string) => Promise<Array<{ name: string; value: string }>>
    }>
  }>): Promise<void>
  deleteCommands?(serverId: string): Promise<void>

  // ── Permissions ──
  getMember(serverId: string, userId: string): Promise<{
    userId: string
    username: string
    displayName: string
    roles: string[]
    isOwner: boolean
    isAdmin: boolean
  } | null>
  searchMembers(serverId: string, query: string): Promise<Array<{
    userId: string
    username: string
    displayName: string
    roles: string[]
    isOwner: boolean
    isAdmin: boolean
  }>>
  hasPermission(member: {
    roles: string[]
    isOwner: boolean
    isAdmin: boolean
  }): boolean
  createRole?(serverId: string, name: string): Promise<void>

  // ── Files ──
  uploadFiles(channelOrThread: string, files: Array<{
    filename: string
    data: Buffer
    contentType?: string
  }>): Promise<string>
  downloadAttachment(url: string): Promise<Buffer>

  // ── Voice (optional — Discord only, Slack has no API) ──
  joinVoice?(options: {
    channelId: string
    serverId: string
    guild: unknown
  }): Promise<{
    channelId: string
    serverId: string
    /** Subscribe to a user's audio stream. Returns unsubscribe fn. */
    onUserAudio: (
      userId: string,
      handler: (pcmData: Buffer) => void,
    ) => () => void
    disconnect: () => void
  }>

  // ── Events ──
  onReady(handler: () => void): void

  // Channel messages (not in threads). Handler decides whether to act
  // based on isMention and channel config (dedicated vs mention-only).
  //   Discord default: fires for every message (dedicated channel mode).
  //   Slack default: fires only for @mentions (shared channel mode).
  onChannelMessage(handler: (event: {
    message: PlatformMessage
    serverId: string
    /** True if the bot was @mentioned in this message. */
    isMention: boolean
  }) => void): void

  // Thread messages. Always fires — threads are implicitly subscribed.
  onThreadMessage(handler: (event: {
    message: PlatformMessage
    serverId: string
    parentChannelId: string
    /** True if the bot was @mentioned in this message. */
    isMention: boolean
  }) => void): void

  // No onAutocomplete — the adapter resolves dynamic choices internally
  // using CommandOption.resolve() and delivers final values to onCommand.
  onCommand(handler: (event: {
    commandName: string
    serverId: string
    channelId: string
    threadId?: string
    userId: string
    /** Final resolved option values. */
    options: Record<string, string | number | boolean>
    /** Reply to the command. Markdown content. */
    reply(response: {
      content: string
      /** Only the invoker sees this message. */
      ephemeral?: boolean
      buttons?: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'success' | 'danger' }>
      selectMenu?: { id: string; placeholder: string; options: Array<{ label: string; value: string; description?: string }>; maxValues?: number }
    }): Promise<void>
    /** Show "thinking..." indicator while processing. */
    defer(options?: { ephemeral?: boolean }): Promise<void>
    /** Edit the deferred reply. */
    editReply(response: {
      content: string
      ephemeral?: boolean
      buttons?: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'success' | 'danger' }>
      selectMenu?: { id: string; placeholder: string; options: Array<{ label: string; value: string; description?: string }>; maxValues?: number }
    }): Promise<void>
    /** Open a modal dialog. */
    showModal(modal: {
      id: string
      title: string
      inputs: Array<
        | { type: 'text'; id: string; label: string; placeholder?: string; required?: boolean; style: 'short' | 'paragraph' }
        | { type: 'file'; id: string; label: string; description?: string; maxFiles?: number }
      >
    }): Promise<void>
  }) => void): void

  onButton(handler: (event: {
    buttonId: string
    userId: string
    serverId: string
    channelId: string
    threadId?: string
    messageId: string
    /** Reply to the button click. */
    reply(response: {
      content: string
      ephemeral?: boolean
      buttons?: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'success' | 'danger' }>
      selectMenu?: { id: string; placeholder: string; options: Array<{ label: string; value: string; description?: string }>; maxValues?: number }
    }): Promise<void>
    /** Replace the message that contains the button. */
    update(response: {
      content: string
      buttons?: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'success' | 'danger' }>
      selectMenu?: { id: string; placeholder: string; options: Array<{ label: string; value: string; description?: string }>; maxValues?: number }
    }): Promise<void>
    defer(options?: { ephemeral?: boolean }): Promise<void>
    editReply(response: {
      content: string
      ephemeral?: boolean
      buttons?: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'success' | 'danger' }>
      selectMenu?: { id: string; placeholder: string; options: Array<{ label: string; value: string; description?: string }>; maxValues?: number }
    }): Promise<void>
    /** Open a modal from button click. */
    showModal(modal: {
      id: string
      title: string
      inputs: Array<
        | { type: 'text'; id: string; label: string; placeholder?: string; required?: boolean; style: 'short' | 'paragraph' }
        | { type: 'file'; id: string; label: string; description?: string; maxFiles?: number }
      >
    }): Promise<void>
  }) => void): void

  onSelectMenu(handler: (event: {
    menuId: string
    selectedValues: string[]
    userId: string
    serverId: string
    channelId: string
    threadId?: string
    messageId: string
    reply(response: {
      content: string
      ephemeral?: boolean
      buttons?: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'success' | 'danger' }>
      selectMenu?: { id: string; placeholder: string; options: Array<{ label: string; value: string; description?: string }>; maxValues?: number }
    }): Promise<void>
    /** Replace the message that contains the select menu. */
    update(response: {
      content: string
      buttons?: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'success' | 'danger' }>
      selectMenu?: { id: string; placeholder: string; options: Array<{ label: string; value: string; description?: string }>; maxValues?: number }
    }): Promise<void>
    defer(options?: { ephemeral?: boolean }): Promise<void>
    editReply(response: {
      content: string
      ephemeral?: boolean
      buttons?: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'success' | 'danger' }>
      selectMenu?: { id: string; placeholder: string; options: Array<{ label: string; value: string; description?: string }>; maxValues?: number }
    }): Promise<void>
  }) => void): void

  onModalSubmit(handler: (event: {
    modalId: string
    userId: string
    serverId: string
    channelId: string
    threadId?: string
    /** Map of input ID → submitted value. */
    values: Record<string, string>
    /** File attachments from file upload inputs. */
    files?: Array<{ filename: string; url: string; contentType?: string; size: number }>
    reply(response: {
      content: string
      ephemeral?: boolean
    }): Promise<void>
    defer(options?: { ephemeral?: boolean }): Promise<void>
    editReply(response: {
      content: string
      ephemeral?: boolean
    }): Promise<void>
  }) => void): void

  onVoiceState?(handler: (event: {
    userId: string
    serverId: string
    channelId: string | null
    previousChannelId: string | null
  }) => void): void

  onThreadCreate?(handler: (event: {
    threadId: string
    channelId: string
    serverId: string
  }) => void): void

  onConnectionState?(handler: (state:
    'connecting' | 'ready' | 'reconnecting' | 'disconnected'
  ) => void): void

  onError(handler: (error: Error) => void): void
}
```

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
await adapter.send(threadId, {
  content: 'Allow edit to `src/config.ts`?',
  silent: false,  // notify user
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
                      ├── discord-adapter.ts (wraps discord.js)
                      └── slack-adapter.ts (wraps @slack/web-api)
```

The `discord-adapter.ts` wraps all discord.js code currently scattered across
`discord-utils.ts`, `discord-urls.ts`, `channel-management.ts`, and
`interaction-handler.ts` into a single Adapter implementation.

## 10. Files Requiring Updates — By Migration Tier

### Tier 1: Core Infrastructure (must change first)

| File | Discord APIs Used | What Changes |
|---|---|---|
| `discord-bot.ts` | `Client`, `Events.*`, `GatewayIntentBits`, `Partials`, `Message`, `ThreadChannel`, `TextChannel` | Replace with `adapter.onMessage()`, `.onReady()`, `.createThread()`, `.postMessage()`. Main event loop. |
| `discord-urls.ts` | `REST` factory, base URL config | Moves inside `DiscordAdapter` |
| `discord-utils.ts` | `sendThreadMessage`, `archiveThread`, `reactToThread`, `hasKimakiBotPermission`, `uploadFilesToDiscord`, `splitMarkdownForDiscord`, `resolveTextChannel`, `resolveWorkingDirectory`, `getKimakiMetadata` | Split: platform-agnostic utils stay, Discord-specific ops move into `DiscordAdapter` |
| `interaction-handler.ts` | `Events.InteractionCreate`, `Interaction`, `MessageFlags` | Replace with `adapter.onCommand()`, `.onButton()`, `.onSelectMenu()`, `.onModalSubmit()` dispatchers |
| `commands/types.ts` | `ChatInputCommandInteraction`, `AutocompleteInteraction`, `StringSelectMenuInteraction` | Replace with `CommandEvent`, `AutocompleteEvent`, `SelectMenuEvent` |
| `format-tables.ts` | `APIContainerComponent`, `APITextDisplayComponent`, `APISeparatorComponent`, `SeparatorSpacingSize` | Move to Discord adapter; Slack renders tables as mrkdwn |
| `channel-management.ts` | `Guild`, `CategoryChannel`, `ChannelType`, `TextChannel` | Replace with `adapter.createChannel()`, `.createCategory()`, `.listChannels()` |

### Tier 2: Session Handler

| File | Discord APIs Used | What Changes |
|---|---|---|
| `session-handler/thread-session-runtime.ts` | `ThreadChannel`, `ChannelType`, `thread.sendTyping()` | Replace `ThreadChannel` with thread ID + `adapter.*` methods |

### Tier 3: Command Handlers (30+ files)

Every command file uses Discord interaction types. They all switch from
`ChatInputCommandInteraction` → `CommandEvent`, `ButtonInteraction` → `ButtonEvent`, etc.

| File | Key Discord APIs | What Changes |
|---|---|---|
| `commands/permissions.ts` | `ButtonBuilder`, `ButtonStyle`, `ButtonInteraction` | Use `PostableMessage` with buttons + `adapter.onButton()` |
| `commands/action-buttons.ts` | `ButtonBuilder`, `ButtonStyle`, `ActionRowBuilder` | Same |
| `commands/ask-question.ts` | `StringSelectMenuBuilder`, `StringSelectMenuInteraction` | Use select menus in `PostableMessage` + `adapter.onSelectMenu()` |
| `commands/file-upload.ts` | `ModalBuilder`, `FileUploadBuilder`, `ButtonBuilder` | Use `adapter.onModalSubmit()` + modal API |
| `commands/model.ts` | `StringSelectMenuBuilder` (4-step chained flow) | Platform select menus + events |
| `commands/agent.ts` | `StringSelectMenuBuilder` | Platform select menus |
| `commands/login.ts` | `ModalBuilder`, `TextInputBuilder`, `StringSelectMenuBuilder` | Platform modals + select menus |
| `commands/gemini-apikey.ts` | `ModalBuilder`, `TextInputBuilder` | Platform modal |
| `commands/fork.ts` | `StringSelectMenuBuilder`, `ThreadAutoArchiveDuration` | Select menu + `.createThread()` |
| `commands/worktree.ts` | `REST`, `TextChannel`, `ThreadChannel`, `Message` | Adapter methods |
| `commands/resume.ts` | `ThreadAutoArchiveDuration`, `TextChannel` | `.createThread()` |
| `commands/session.ts` | `ChannelType`, `TextChannel` | `.createThread()` |
| `commands/create-new-project.ts` | `Guild`, `TextChannel` | `.createChannel()` |
| `commands/diff.ts` | `EmbedBuilder` | Embed component in `PostableMessage` |
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
| `cli.ts` | `SlashCommandBuilder`, `REST`, `Routes`, `Events`, `Client`, `AttachmentBuilder`, `Guild` | Command registration → `adapter.registerCommands()`. OAuth stays platform-specific. |
| `opencode-plugin.ts` | `Routes.guildMembersSearch`, `REST` | Replace with `adapter.searchMembers()` |
| `task-runner.ts` | `REST`, `Routes.channelMessages`, `Routes.threads` | Replace with `adapter.postMessage()`, `adapter.createThread()` |
| `message-formatting.ts` | `Message` type, `TextChannel` | Replace with `PlatformMessage` |
| `utils.ts` | `PermissionsBitField` | Move to Discord adapter |
| `ipc-polling.ts` | `Client` | Replace with `KimakiAdapter` |
| `test-utils.ts` | `APIMessage` | Replace with `PlatformMessage` |

### Tier 7: E2E Tests (7 files)

All test files create discord.js `Client` instances — need a
`createTestAdapter()` factory.

## 11. Implementation Order

1. Create `KimakiAdapter` interface in `cli/src/platform/types.ts`
2. Create `DiscordAdapter` in `cli/src/platform/discord-adapter.ts`
   wrapping existing discord.js code
3. Update `discord-bot.ts` to use adapter (Tier 1)
4. Update `commands/types.ts` to use platform-agnostic event types
5. Update commands one by one (Tier 3 — all follow the same pattern)
6. Create `SlackAdapter` in `cli/src/platform/slack-adapter.ts`
7. Add platform selection to `cli.ts` startup
