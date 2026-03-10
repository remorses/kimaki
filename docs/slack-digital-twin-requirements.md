# Slack Digital Twin - Implementation Requirements

**Purpose**: Define what the slack-digital-twin mock library must implement to support testing Kimaki with the Discord-Slack Bridge.

---

## Architecture Overview

The slack-digital-twin needs to:
1. Mock the Slack Web API (`@slack/web-api` interface)
2. Provide a test harness similar to `discord-digital-twin` 
3. Support in-memory state for channels, threads, messages, users
4. Emit webhook events that the bridge translates to Discord Gateway events
5. Validate message formatting, Block Kit structure, ID encoding

---

## Core Slack Web API Methods to Mock

### Chat Methods
```typescript
chat.postMessage({
  channel: string           // C... or G... or D...
  thread_ts?: string        // "1234567890.123456"
  text: string              // fallback text
  blocks?: SlackBlock[]     // Block Kit blocks
  unfurl_links?: boolean    // disable link previews
  unfurl_media?: boolean    // disable media previews
}): Promise<{ ts: string; ok: boolean; ... }>

chat.update({
  channel: string
  ts: string
  text: string
  blocks?: SlackBlock[]
}): Promise<{ ok: boolean; ... }>

chat.delete({
  channel: string
  ts: string
}): Promise<{ ok: boolean; ... }>
```

### Conversation (Channel) Methods
```typescript
conversations.history({
  channel: string
  limit?: number
  latest?: string           // ts (exclusive upper bound)
  oldest?: string           // ts (inclusive lower bound)
}): Promise<{ 
  messages: SlackMessage[]
  has_more?: boolean
  ... 
}>

conversations.replies({
  channel: string
  ts: string                // thread parent ts
  limit?: number
  latest?: string
  oldest?: string
}): Promise<{
  messages: SlackMessage[]
  has_more?: boolean
  ...
}>

conversations.info({
  channel: string
}): Promise<{
  channel: {
    id: string
    name: string
    is_channel: boolean
    is_private: boolean
    created: number
    created_by: string
    ...
  }
}>

conversations.list({
  exclude_archived?: boolean
  limit?: number
  cursor?: string
}): Promise<{
  channels: SlackChannel[]
  response_metadata?: { next_cursor?: string }
  ...
}>
```

### Reaction Methods
```typescript
reactions.add({
  channel: string
  name: string              // emoji name without colons
  timestamp: string         // message ts
}): Promise<{ ok: boolean; ... }>

reactions.remove({
  channel: string
  name: string
  timestamp: string
}): Promise<{ ok: boolean; ... }>
```

### File Upload (2-Step)
```typescript
files.getUploadURLExternal({
  filename: string
  length: number            // file size in bytes
}): Promise<{
  upload_url: string
  file_id: string
  ok: boolean
}>

files.completeUploadExternal({
  files: Array<{
    id: string
    title?: string
  }>
  channel_id?: string
  thread_ts?: string
}): Promise<{
  ok: boolean
  ...
}>
```

### User & Team Methods
```typescript
users.info({
  user: string              // U... user ID
}): Promise<{
  user: {
    id: string
    username: string
    name: string
    real_name: string
    is_bot: boolean
    profile: { avatar_hash?: string; ... }
    ...
  }
}>

users.list({
  limit?: number
  cursor?: string
}): Promise<{
  members: SlackUser[]
  response_metadata?: { next_cursor?: string }
}>
```

---

## In-Memory State Structure

```typescript
interface SlackDigitalTwinState {
  workspace: {
    id: string                        // T...
    name: string
    url: string
  }

  channels: Map<string, {
    id: string                        // C... or G... (DM = D...)
    name: string
    is_private: boolean
    is_channel: boolean
    created: number
    creator: string
    topic: string
    members: string[]                 // user IDs
    messages: Map<string, SlackMessage> // keyed by ts
  }>

  threads: Map<string, {
    channelId: string
    parentTs: string
    name: string
    messages: Map<string, SlackMessage>
  }>

  users: Map<string, {
    id: string                        // U...
    username: string
    real_name: string
    is_bot: boolean
    avatar: string | null
  }>

  messages: Map<string, SlackMessage> // flat index by (channel, ts)
}

interface SlackMessage {
  ts: string                          // "1234567890.123456"
  thread_ts?: string                  // if thread reply
  user?: string                       // U... user ID
  bot_id?: string                     // B... bot ID
  text: string
  blocks?: SlackBlock[]
  reactions?: Array<{
    name: string
    users: string[]
    count: number
  }>
  files?: SlackFile[]
  edited?: {
    user: string
    ts: string
  }
}

interface SlackBlock {
  type: string                        // "section" | "actions" | "divider" | etc
  block_id?: string
  text?: SlackTextObject
  elements?: SlackElement[]
  accessory?: SlackElement
  [key: string]: unknown
}

interface SlackFile {
  id: string
  name: string
  title: string
  size: number
  url_private: string
  created: number
  timestamp: string
}
```

---

## Event Emission

The slack-digital-twin must accept a webhook URL and POST events:

```typescript
interface SlackEventEnvelope {
  token: string
  team_id: string
  api_app_id: string
  event: SlackEvent
  type: "event_callback" | "url_verification"
  event_id: string
  event_time: number
  trigger_id?: string
}

type SlackEvent =
  | { type: "message"; subtype?: string; channel: string; user?: string; ts: string; ... }
  | { type: "message"; subtype: "message_changed"; channel: string; message: SlackMessage; ... }
  | { type: "message"; subtype: "message_deleted"; channel: string; deleted_ts: string; ... }
  | { type: "reaction_added"; user: string; reaction: string; item: { type: "message"; channel: string; ts: string } }
  | { type: "reaction_removed"; user: string; reaction: string; item: { type: "message"; channel: string; ts: string } }
  | { type: "channel_created"; channel: { id: string; name: string; created: number } }
  | { type: "channel_deleted"; channel: string }
  | { type: "member_joined_channel"; user: string; channel: string; ... }
  | { type: "app_mention"; channel: string; user: string; text: string; ts: string; ... }
```

---

## Test Harness API (Similar to DigitalDiscord)

```typescript
interface SlackDigitalTwin {
  // Channel operations
  channel(channelId: string): {
    getMessages(): Promise<SlackMessage[]>
    getMessage(ts: string): Promise<SlackMessage | null>
    sendMessage(text: string, blocks?: SlackBlock[]): Promise<SlackMessage>
    deleteMessage(ts: string): Promise<void>
    
    // Thread operations
    thread(ts: string): {
      getMessages(): Promise<SlackMessage[]>
      sendMessage(text: string, blocks?: SlackBlock[]): Promise<SlackMessage>
      waitForMessage(
        predicate: (msg: SlackMessage) => boolean,
        timeout: number
      ): Promise<SlackMessage>
    }
    
    // User interaction
    user(userId: string): {
      sendMessage(text: string): Promise<SlackMessage>
      react(emoji: string, ts: string): Promise<void>
    }
  }

  // User operations
  user(userId: string): {
    getInfo(): Promise<SlackUser>
    sendDirectMessage(text: string): Promise<SlackMessage>
  }

  // Workspace operations
  getWorkspaceId(): string
  getBotUserId(): string
  listChannels(): Promise<SlackChannel[]>
  listUsers(): Promise<SlackUser[]>

  // Event simulation
  emitEvent(event: SlackEvent): Promise<void>
  
  // State inspection
  getState(): SlackDigitalTwinState
  reset(): void
}
```

---

## Format Conversion Requirements

The slack-digital-twin should validate that:

### Markdown ↔ mrkdwn Conversion
```
Discord markdown        → Slack mrkdwn
**bold**              → *bold*
~~strikethrough~~     → ~strikethrough~
[text](url)           → <url|text>
`code`                → `code` (unchanged)
```

### Block Kit Validation
- All buttons have `action_id` (max 75 chars)
- Select menus properly formed
- Text object types correct (`plain_text` or `mrkdwn`)
- Component hierarchy valid

### ID Encoding
- Thread IDs: `THR_{channel}_{ts_no_dots}` format
- Message IDs: `MSG_{channel}_{ts_no_dots}` format
- Reversible decoding back to (channel, ts)

---

## Timestamp Handling

Slack timestamps: `seconds.microseconds` (always 6 decimal places for microseconds)

```typescript
// Example: "1503435956.000247"
//          └─ seconds ─┘ └ microseconds ┘

interface SlackTimestamp {
  seconds: number
  microseconds: number
  
  toISO(): string        // "2017-08-22T19:32:36.000247Z"
  toEpochMs(): number    // millisecond epoch
}
```

---

## Component Interaction Handling

When Block Kit buttons or select menus are included:

1. Track `action_id` → handler context mapping
2. On interaction event, emit webhook with `type: "block_actions"`
3. Include `trigger_id` for follow-up modals/actions

```typescript
interface SlackInteractionEvent {
  type: "block_actions"
  trigger_id: string
  user: { id: string; name: string; ... }
  team: { id: string; domain: string; ... }
  channel: { id: string; name: string; ... }
  actions: Array<{
    type: "button" | "static_select" | ...
    action_id: string
    value?: string
    selected_options?: Array<{ value: string }>
    selected_user?: string
  }>
}
```

---

## Error Handling & Edge Cases

Mock API should:
1. Validate channel IDs exist before message operations
2. Validate thread_ts when posting to thread
3. Handle missing ts (message not found) → throw error
4. Support concurrent message posting (FIFO queue)
5. Validate Block Kit structure and reject invalid blocks
6. Support rate limit simulation (optional, but useful)
7. Track message edit history (for MESSAGE_UPDATE events)

---

## Test Scenario Coverage

To be complete, slack-digital-twin must support:

- ✓ Creating channel
- ✓ Posting message with text + blocks
- ✓ Creating thread (first reply)
- ✓ Posting replies to thread
- ✓ Editing messages
- ✓ Deleting messages
- ✓ Adding reactions
- ✓ Removing reactions
- ✓ File upload (2-step flow)
- ✓ User mention resolution
- ✓ Channel mention resolution
- ✓ Emoji handling in reactions
- ✓ Block Kit component rendering
- ✓ Message history pagination (limit, latest, oldest)
- ✓ Thread reply pagination
- ✓ Rapid concurrent operations
- ✓ Event webhook delivery timing

---

## Implementation Notes

1. **No Real Slack Connection** - Entirely in-process mock, no HTTP calls to api.slack.com
2. **Deterministic State** - Same inputs → same outputs (for reproducible tests)
3. **Event Timing** - Events emitted synchronously or with configurable delay
4. **ID Generation** - Use predictable IDs (not random) for test reproducibility
5. **Cleanup** - Support `reset()` for test isolation
6. **Type Safety** - Use TypeScript with strict checks, no `any` casts
7. **Error Messages** - Match Slack's actual error format where possible

---

## References

- Slack Web API Docs: https://api.slack.com/docs
- Block Kit Docs: https://api.slack.com/block-kit
- Event Types: https://api.slack.com/events
- Discord-Digital-Twin: `/Users/morse/Documents/GitHub/kimakivoice/discord-digital-twin/src`
