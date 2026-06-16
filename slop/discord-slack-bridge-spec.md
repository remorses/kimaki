---
title: discord-slack-bridge Spec
description: |
  Full specification for a discord.js-to-Slack adapter that lets any discord.js
  bot (like kimaki) control a Slack workspace without code changes. The adapter
  translates Discord REST calls to Slack Web API calls and Slack webhook events
  to Discord Gateway dispatches.
prompt: |
  Create a full spec for a discord.js to Slack converter service. We use
  discord-digital-twin as architectural base (REST + Gateway WS pattern).
  The adapter should be stateless — no database for ID mapping, use
  deterministic prefix encoding instead. Reference vercel/chat slack-adapter
  (opensrc) for Slack event/action patterns. Reference @slack/web-api types
  for method signatures. Reference discord-digital-twin/src for the REST +
  Gateway server pattern.
  Files read:
  - discord-digital-twin/src/index.ts
  - discord-digital-twin/src/server.ts
  - discord-digital-twin/src/gateway.ts
  - discord-digital-twin/src/serializers.ts
  - opensrc/repos/github.com/vercel/chat/packages/adapter-slack/src/index.ts
  - opensrc/repos/github.com/vercel/chat/packages/adapter-slack/src/markdown.ts
  - opensrc/repos/github.com/vercel/chat/packages/adapter-slack/src/cards.ts
  - opensrc/repos/github.com/slackapi/node-slack-sdk (types)
---

# discord-slack-bridge

A standalone package that lets any **discord.js** bot control a **Slack
workspace** without code changes. The bot connects to the adapter's local
REST + Gateway server exactly like it connects to `discord-digital-twin`.
The adapter translates all Discord API calls to Slack Web API calls and all
Slack webhook events to Discord Gateway dispatches.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  discord.js Client (kimaki, any bot)                     │
│  rest.api = http://localhost:PORT/api/v10                │
│  gateway  = ws://localhost:PORT/gateway                  │
└──────────┬───────────────────────────┬───────────────────┘
           │ HTTP (REST)               │ WebSocket (Gateway)
           ▼                           ▼
┌──────────────────────────────────────────────────────────┐
│  discord-slack-bridge                                    │
│                                                          │
│  ┌─────────────────────┐    ┌──────────────────────────┐ │
│  │  REST Translator     │    │  Gateway Emulator        │ │
│  │  /api/v10/*          │    │  /gateway                │ │
│  │                      │    │                          │ │
│  │  discord.js REST     │    │  Receives Slack webhook  │ │
│  │  calls translated    │    │  events (HTTP POST),     │ │
│  │  to Slack Web API    │    │  converts to Discord     │ │
│  │  calls; responses    │    │  Gateway dispatches,     │ │
│  │  returned as Discord │    │  sends to discord.js     │ │
│  │  API shapes          │    │  over WebSocket          │ │
│  └──────────┬───────────┘    └─────────────┬────────────┘ │
│             │                              │              │
│  ┌──────────▼──────────────────────────────▼────────────┐ │
│  │  ID Converter (stateless)                            │ │
│  │  Discord ID <-> Slack ID via deterministic encoding  │ │
│  │  No database needed                                  │ │
│  └──────────┬───────────────────────────────────────────┘ │
│             │                                             │
│  ┌──────────▼───────────────────────────────────────────┐ │
│  │  Slack Web API Client (@slack/web-api)                │ │
│  │  Real Slack API calls                                 │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  Webhook Receiver (HTTP POST)                        │ │
│  │  /slack/events - Slack sends events here             │ │
│  │  Signature verification, event parsing               │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
           │
           ▼
     ┌──────────┐
     │ Slack API │
     └──────────┘
```

## Stateless ID Mapping

**No database. No SQLite. No Prisma.** Unlike discord-digital-twin which
stores state in-memory, this adapter is a pure translator. All IDs are
derived deterministically from Slack IDs using prefix encoding.

### Encoding Scheme

| Discord concept | Slack source           | Encoded format                    | Example                              |
|-----------------|------------------------|-----------------------------------|--------------------------------------|
| Guild ID        | Workspace ID           | Slack `T` prefix as-is            | `T04ABC123`                          |
| Channel ID      | Channel ID             | Slack `C`/`G`/`D` prefix as-is    | `C04ABC123`                          |
| Thread ID       | `channel:thread_ts`    | `THR_{channel}_{ts_no_dots}`      | `THR_C04ABC123_1503435956000247`     |
| Message ID      | `channel:ts`           | `MSG_{channel}_{ts_no_dots}`      | `MSG_C04ABC123_1503435956000247`     |
| User ID         | User ID                | Slack `U`/`W` prefix as-is        | `U04ABC123`                          |
| Role ID         | Usergroup ID           | Slack `S` prefix as-is            | `S04ABC123`                          |
| Reaction emoji  | Emoji name             | Name string                       | `thumbsup`                           |

**Thread IDs as channels**: Discord threads are channels. When discord.js
sends a message to a thread channel ID like `THR_C04ABC123_1503435956000247`,
the adapter decodes this to
`chat.postMessage({ channel: "C04ABC123", thread_ts: "1503435956.000247" })`.

The `ts_no_dots` encoding removes the `.` from Slack's `ts` format
(`1503435956.000247` -> `1503435956000247`). Slack timestamps always have
exactly 6 decimal digits, so this is reversible: insert `.` before the last
6 chars.

**Why this works**: Slack IDs (`C...`, `U...`, `T...`) are already globally
unique strings. discord.js doesn't validate that IDs are numeric snowflakes
-- it just needs unique string IDs.

### Decode Functions

```typescript
function decodeThreadId(threadChannelId: string): {
  channel: string
  threadTs: string
} {
  // THR_C04ABC123_1503435956000247 -> { channel, threadTs }
  const match = threadChannelId.match(/^THR_([^_]+)_(\d+)$/)
  if (!match) {
    throw new Error(`Invalid thread channel ID: ${threadChannelId}`)
  }
  const raw = match[2]!
  const ts = raw.slice(0, -6) + '.' + raw.slice(-6)
  return { channel: match[1]!, threadTs: ts }
}

function decodeMessageId(messageId: string): {
  channel: string
  ts: string
} {
  // MSG_C04ABC123_1503435956000247 -> { channel, ts }
  const match = messageId.match(/^MSG_([^_]+)_(\d+)$/)
  if (!match) {
    throw new Error(`Invalid message ID: ${messageId}`)
  }
  const raw = match[2]!
  const ts = raw.slice(0, -6) + '.' + raw.slice(-6)
  return { channel: match[1]!, ts }
}

function encodeThreadId(channel: string, threadTs: string): string {
  return `THR_${channel}_${threadTs.replace('.', '')}`
}

function encodeMessageId(channel: string, ts: string): string {
  return `MSG_${channel}_${ts.replace('.', '')}`
}

function isThreadChannelId(id: string): boolean {
  return id.startsWith('THR_')
}
```

## Event Flow: Slack -> Discord Gateway

Slack sends events via HTTP POST webhook to `/slack/events`. The adapter
verifies the signature, translates the event, and broadcasts it as a
Discord Gateway dispatch to the connected discord.js client.

### Event Mapping

| Slack Event                      | Discord Dispatch            | Notes                                    |
|----------------------------------|-----------------------------|------------------------------------------|
| `message` (new)                  | `MESSAGE_CREATE`            | Convert mrkdwn -> markdown               |
| `message` (`message_changed`)    | `MESSAGE_UPDATE`            |                                          |
| `message` (`message_deleted`)    | `MESSAGE_DELETE`            |                                          |
| `reaction_added`                 | `MESSAGE_REACTION_ADD`      |                                          |
| `reaction_removed`               | `MESSAGE_REACTION_REMOVE`   |                                          |
| `channel_created`                | `CHANNEL_CREATE`            |                                          |
| `channel_deleted`                | `CHANNEL_DELETE`            |                                          |
| `channel_rename`                 | `CHANNEL_UPDATE`            |                                          |
| `member_joined_channel`          | `GUILD_MEMBER_ADD`          | If needed                                |
| `app_mention`                    | `MESSAGE_CREATE`            | With mention flag                        |
| `block_actions`                  | `INTERACTION_CREATE`        | Button/select clicks                     |
| `view_submission`                | `INTERACTION_CREATE`        | Modal submit                             |
| Slash command (form-urlencoded)  | `INTERACTION_CREATE`        | Application command                      |

### Event Payload Translation Example

**Slack `message` -> Discord `MESSAGE_CREATE`**:

```typescript
// Slack event:
{
  type: "message",
  channel: "C04ABC123",
  user: "U04USER1",
  text: "Hello *world*",
  ts: "1503435956.000247",
  thread_ts: "1503435900.000100"  // optional
}

// Discord dispatch:
{
  op: 0,
  t: "MESSAGE_CREATE",
  d: {
    id: "MSG_C04ABC123_1503435956000247",
    channel_id: "THR_C04ABC123_1503435900000100",  // thread
    // or "C04ABC123" if no thread_ts
    author: {
      id: "U04USER1",
      username: "tommy",  // looked up via users.info
      discriminator: "0",
      avatar: null,
      bot: false
    },
    content: "Hello **world**",  // mrkdwn -> markdown
    timestamp: "2017-08-23T02:12:36.000Z",
    embeds: [],
    components: [],
    attachments: [],
    guild_id: "T04WORKSPACE"
  }
}
```

### Webhook Signature Verification

Uses HMAC-SHA256 with the Slack signing secret, same as vercel/chat:

```typescript
const sigBasestring = `v0:${timestamp}:${body}`
const expected = 'v0=' + createHmac('sha256', signingSecret)
  .update(sigBasestring)
  .digest('hex')
timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
```

## REST Flow: Discord -> Slack

### Route Mapping

| Discord REST Route                                    | Slack Web API Method                                         | Notes                                                           |
|-------------------------------------------------------|--------------------------------------------------------------|-----------------------------------------------------------------|
| `GET /gateway/bot`                                    | --                                                           | Returns local gateway URL                                       |
| `GET /users/@me`                                      | `auth.test` + `users.info`                                   | Bot user info                                                   |
| `GET /users/:id`                                      | `users.info`                                                 | User lookup                                                     |
| `POST /channels/:id/messages`                         | `chat.postMessage`                                           | If `:id` is `THR_*`, decode and add `thread_ts`                 |
| `PATCH /channels/:id/messages/:mid`                   | `chat.update`                                                | Decode message ID to get `ts`                                   |
| `DELETE /channels/:id/messages/:mid`                  | `chat.delete`                                                | Decode message ID to get `ts`                                   |
| `GET /channels/:id/messages`                          | `conversations.history` or `conversations.replies`           | Use `replies` if channel is a thread (`THR_*`)                  |
| `GET /channels/:id/messages/:mid`                     | `conversations.history` with `latest`/`oldest`/`inclusive`   | Single message fetch                                            |
| `POST /channels/:id/typing`                           | No-op                                                        | Slack has no typing API. Return 204                             |
| `PUT /channels/:id/messages/:mid/reactions/:emoji/@me` | `reactions.add`                                             |                                                                 |
| `DELETE /channels/:id/messages/:mid/reactions/:emoji/@me` | `reactions.remove`                                       |                                                                 |
| `GET /channels/:id`                                   | `conversations.info`                                         | Serialize as Discord channel                                    |
| `PATCH /channels/:id`                                 | `conversations.rename` / `setTopic` / `archive`             |                                                                 |
| `POST /channels/:id/threads`                          | `chat.postMessage` with reply                                | Create thread = post first message. Return synthetic thread ID  |
| `GET /guilds/:id`                                     | `team.info`                                                  | Serialize as Discord guild                                      |
| `GET /guilds/:id/channels`                            | `conversations.list`                                         | Filter by workspace                                             |
| `POST /guilds/:id/channels`                           | `conversations.create`                                       |                                                                 |
| `GET /guilds/:id/members`                             | `users.list`                                                 | Serialize as Discord members                                    |
| `GET /guilds/:id/members/:uid`                        | `users.info`                                                 |                                                                 |
| `GET /guilds/:id/roles`                               | `usergroups.list`                                            |                                                                 |
| `GET /applications/@me`                               | `auth.test`                                                  |                                                                 |
| `POST /interactions/:id/:token/callback`              | Depends on type                                              | See interactions section                                        |
| `POST /webhooks/:id/:token`                           | `chat.postMessage` (follow-up)                               |                                                                 |
| `PATCH /webhooks/:id/:token/messages/:id`             | `chat.update`                                                |                                                                 |

### Thread Creation (Discord -> Slack)

Discord creates threads with `POST /channels/:parent_id/threads`
(body: `{ name: "thread name" }`). Slack threads don't have names -- they
are just replies.

**Strategy**: When discord.js creates a thread:
1. Post a message to the parent channel with the thread name as content
   (or use the `starterMessage` if provided)
2. The message's `ts` becomes the `thread_ts`
3. Return a Discord channel object with
   `id: THR_{channel}_{ts_no_dots}`, `type: PublicThread`,
   `parent_id: channel`

## Format Conversion

### Markdown <-> mrkdwn

**Discord markdown -> Slack mrkdwn** (outbound, REST):
- `**bold**` -> `*bold*`
- `~~strike~~` -> `~strike~`
- `[text](url)` -> `<url|text>`
- Code blocks and inline code: same

**Slack mrkdwn -> Discord markdown** (inbound, events):
- `*bold*` -> `**bold**`
- `~strike~` -> `~~strike~~`
- `<url|text>` -> `[text](url)`
- `<@U123>` -> `<@U123>` (same format)

### Embed -> Block Kit (outbound)

| Discord Embed field | Slack Block                         |
|---------------------|-------------------------------------|
| `embed.title`       | `header` block                      |
| `embed.description` | `section` block (mrkdwn)            |
| `embed.fields[]`    | `section` block with fields         |
| `embed.image`       | `image` block                       |
| `embed.thumbnail`   | `section` accessory (image)         |
| `embed.footer`      | `context` block                     |
| `embed.color`       | attachment color (legacy)           |
| `embed.author`      | `context` block (image + text)      |

### Component -> Block Kit (outbound)

| Discord Component         | Slack Block Element        |
|----------------------------|----------------------------|
| `ActionRow[Button]`        | `actions` block [buttons]  |
| `button.customId`          | `button.action_id`         |
| `button.label`             | `button.text` (plain_text) |
| `button.style=Primary`     | `style: "primary"`         |
| `button.style=Danger`      | `style: "danger"`          |
| `button.style=Secondary`   | (no style, default)        |
| `ActionRow[StringSelect]`  | `actions` [static_select]  |
| `select.customId`          | `select.action_id`         |
| `select.options`           | `select.options`           |
| `select.placeholder`       | `select.placeholder`       |

## Interactions

### Slash Commands (Slack -> Discord)

Slack sends slash commands as form-urlencoded POST. The adapter translates
to `INTERACTION_CREATE`:

```
Slack: POST /slack/events (form-urlencoded)
  command=/hello, text=world, user_id=U123, channel_id=C456, trigger_id=...

Discord Gateway dispatch:
  INTERACTION_CREATE {
    type: 2 (ApplicationCommand),
    data: { name: "hello", options: [{ value: "world" }] },
    channel_id: "C456",
    guild_id: "T04WORKSPACE",
    member: { user: { id: "U123", ... } },
    token: "<generated-interaction-token>"
  }
```

### Interaction Responses

When discord.js responds via `POST /interactions/:id/:token/callback`:

| Discord Response Type               | Slack Action                                |
|--------------------------------------|---------------------------------------------|
| Type 4 (message reply)               | `chat.postMessage` via `response_url`       |
| Type 5 (deferred message)            | Ack empty, later `chat.postMessage`         |
| Type 6 (deferred update)             | Ack empty                                   |
| Type 7 (update message)              | `chat.update` on original                   |
| Type 9 (modal)                       | `views.open` with `trigger_id`              |

### Button Clicks (Slack -> Discord)

Slack sends `block_actions` payload. The adapter:
1. Maps `action_id` -> Discord `custom_id`
2. Builds `INTERACTION_CREATE` with `type: MessageComponent`
3. discord.js responds -> adapter uses `response_url` or `chat.update`

## Configuration

```typescript
interface SlackBridgeConfig {
  slackBotToken: string       // xoxb-...
  slackSigningSecret: string  // For webhook verification
  workspaceId: string         // T... workspace ID
  port?: number               // Default 3710
}
```

The adapter starts:
1. HTTP server on `port` with Discord REST routes (`/api/v10/*`) and
   Slack webhook receiver (`/slack/events`)
2. WebSocket server on same port at `/gateway` for discord.js Gateway

## Package Structure

```
discord-slack-bridge/
├── src/
│   ├── index.ts              # Public API: SlackBridge class
│   ├── server.ts             # HTTP server (REST + webhook receiver)
│   ├── gateway.ts            # WebSocket gateway (reuse from digital-twin)
│   ├── id-converter.ts       # Stateless ID encode/decode
│   ├── rest-translator.ts    # Discord REST -> Slack Web API
│   ├── event-translator.ts   # Slack events -> Discord dispatches
│   ├── format-converter.ts   # markdown <-> mrkdwn, embeds <-> blocks
│   ├── interaction-handler.ts # Slash commands, buttons, modals
│   └── types.ts              # Shared types
├── tests/
│   ├── id-converter.test.ts
│   ├── format-converter.test.ts
│   ├── rest-translator.test.ts
│   └── event-translator.test.ts
├── package.json
└── tsconfig.json
```

## Not Supported (out of scope)

| Feature                    | Reason                                         |
|----------------------------|-------------------------------------------------|
| Voice channels             | Completely different APIs                       |
| Typing indicator           | Slack has no public typing API                  |
| Guild member intents       | Different model                                 |
| Ephemeral message edits    | Slack ephemeral messages can't be edited        |
| Custom emoji IDs           | Slack emojis are name-only                      |
| Permission overwrites      | Slack uses OAuth scopes, not per-channel perms  |
| Discord webhooks           | N/A, we use Slack's `chat.postMessage`          |
| Gateway resume/reconnect   | Not needed, local connection                    |

## Phases

1. **Phase 1**: Core messaging -- send/receive messages, threads, reactions.
   ID converter. Format converter. Gateway + REST server skeleton.
2. **Phase 2**: Interactions -- slash commands, buttons, modals.
   Interaction response handling.
3. **Phase 3**: Rich content -- embeds -> blocks, components -> block kit,
   file uploads.
4. **Phase 4**: Channel management -- create/list/archive channels,
   member listing.
