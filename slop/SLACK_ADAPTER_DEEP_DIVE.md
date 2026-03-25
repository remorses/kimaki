# Vercel Chat Slack Adapter - Comprehensive Analysis

## Overview
The Slack adapter (`@chat-adapter/slack`) is a production-grade adapter for the Vercel Chat SDK that handles all Slack webhook events, message operations, and interactive interactions. It's hosted in `/packages/adapter-slack` and is ~3500 lines of TypeScript.

---

## 1. WEBHOOK HANDLING & VERIFICATION

### HTTP POST Entry Point: `handleWebhook()`
Located at line 702-782 in index.ts

```typescript
async handleWebhook(
  request: Request,
  options?: WebhookOptions
): Promise<Response>
```

**Process:**
1. **Signature Verification** (lines 713-715)
   - Extracts `x-slack-request-timestamp` and `x-slack-signature` headers
   - Calls `verifySignature()` which:
     - Checks timestamp is within 5 minutes (line 1138)
     - Creates HMAC-SHA256 signature: `v0:${timestamp}:${body}`
     - Uses timing-safe comparison to prevent timing attacks (line 1152)

2. **Content-Type Detection** (lines 718-747)
   - **Form-urlencoded** (`application/x-www-form-urlencoded`):
     - Slash commands: `params.has("command") && !params.has("payload")`
     - Interactive payloads: `payload` field present
   - **JSON** (`application/json`):
     - Event callbacks and URL verification

3. **Multi-Workspace Support** (lines 764-777)
   - In multi-workspace mode (no defaultBotToken):
     - Extracts `team_id` from payload
     - Calls `resolveTokenForTeam()` to fetch bot token from state
     - Wraps processing in `requestContext.run()` to make token available

### Signature Verification Code (lines 1127-1159)
```typescript
private verifySignature(
  body: string,
  timestamp: string | null,
  signature: string | null
): boolean {
  if (!(timestamp && signature)) return false;
  
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number.parseInt(timestamp, 10)) > 300) {
    return false; // Reject if >5 min old
  }
  
  const sigBasestring = `v0:${timestamp}:${body}`;
  const expectedSignature = "v0=" + 
    createHmac("sha256", this.signingSecret)
      .update(sigBasestring)
      .digest("hex");
  
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}
```

---

## 2. EVENT PARSING & NORMALIZATION

### Event Dispatching (lines 784-825)
```typescript
private processEventPayload(
  payload: SlackWebhookPayload,
  options?: WebhookOptions
): void {
  if (payload.type === "event_callback" && payload.event) {
    const event = payload.event;
    
    if (event.type === "message" || event.type === "app_mention") {
      this.handleMessageEvent(event as SlackEvent, options);
    } else if (event.type === "reaction_added" || event.type === "reaction_removed") {
      this.handleReactionEvent(event as SlackReactionEvent, options);
    } else if (event.type === "assistant_thread_started") {
      this.handleAssistantThreadStarted(event as SlackAssistantThreadStartedEvent, options);
    }
    // ... more event types
  }
}
```

### Message Event Handling (lines 1165-1243)
The `handleMessageEvent()` method:

1. **Filters system messages** (lines 1177-1204)
   - Ignores subtypes: `message_changed`, `message_deleted`, `message_replied`, `channel_join`, etc.
   - Allows: `bot_message`, `file_share`, `thread_broadcast`, user messages

2. **Thread ID Resolution** (lines 1217-1222)
   - **For DMs** (`channel_type === "im"`):
     - Top-level: uses empty `threadTs` → `slack:D123:`
     - Replies: uses `thread_ts` → `slack:D123:1234567890.123456`
   - **For Channels**:
     - Always uses `thread_ts || ts` → enforces per-thread isolation

3. **User Mention Detection** (lines 1233-1239)
   - Sets `isMention = true` for:
     - DMs (all messages)
     - `app_mention` event type
   - Uses async factory function to parse message with user lookup

### Message Parsing (lines 1633-1682)
```typescript
private async parseSlackMessage(
  event: SlackEvent,
  threadId: string,
  options?: { skipSelfMention?: boolean }
): Promise<Message<unknown>> {
  const isMe = this.isMessageFromSelf(event);
  const text = event.text || "";
  
  // User lookup (caches result in state for 1 hour)
  let userName = event.username || "unknown";
  if (event.user && !event.username) {
    const userInfo = await this.lookupUser(event.user);
    userName = userInfo.displayName;
  }
  
  // Resolve inline @mentions to display names
  const resolvedText = await this.resolveInlineMentions(text, skipSelfMention);
  
  return new Message({
    id: event.ts || "",
    threadId,
    text: this.formatConverter.extractPlainText(resolvedText),
    formatted: this.formatConverter.toAst(resolvedText),
    raw: event,
    author: {
      userId: event.user || event.bot_id || "unknown",
      userName,
      fullName: userInfo.realName,
      isBot: !!event.bot_id,
      isMe
    },
    metadata: {
      dateSent: new Date(Number.parseFloat(event.ts || "0") * 1000),
      edited: !!event.edited,
      editedAt: event.edited ? new Date(...) : undefined
    },
    attachments: (event.files || []).map(file => this.createAttachment(file))
  });
}
```

---

## 3. MESSAGE POSTING

### Post Message (lines 1771-1908)
```typescript
async postMessage(
  threadId: string,
  message: AdapterPostableMessage
): Promise<RawMessage<unknown>> {
  const { channel, threadTs } = this.decodeThreadId(threadId);
  
  // 1. Check for file uploads
  const files = extractFiles(message);
  if (files.length > 0) {
    await this.uploadFiles(files, channel, threadTs);
  }
  
  // 2. Check for cards (Block Kit)
  const card = extractCard(message);
  if (card) {
    const blocks = cardToBlockKit(card);
    const fallbackText = cardToFallbackText(card);
    const result = await this.client.chat.postMessage(
      this.withToken({
        channel,
        thread_ts: threadTs,
        text: fallbackText,
        blocks,
        unfurl_links: false,
        unfurl_media: false
      })
    );
    return { id: result.ts, threadId, raw: result };
  }
  
  // 3. Check for tables (native Slack table blocks)
  const tableResult = this.renderWithTableBlocks(message);
  if (tableResult) {
    const result = await this.client.chat.postMessage(
      this.withToken({
        channel,
        thread_ts: threadTs,
        text: tableResult.text,
        blocks: tableResult.blocks
      })
    );
    return { id: result.ts, threadId, raw: result };
  }
  
  // 4. Regular text message
  const text = convertEmojiPlaceholders(
    this.formatConverter.renderPostable(message),
    "slack"
  );
  const result = await this.client.chat.postMessage(
    this.withToken({ channel, thread_ts: threadTs, text })
  );
  return { id: result.ts, threadId, raw: result };
}
```

### File Upload (lines 2207-2261)
- Uses `files.uploadV2()` API
- Converts file data to buffer using `toBuffer()`
- Automatically shares to channel and thread
- Returns file IDs from response

### Edit Message (lines 2263-2387)
- Detects ephemeral messages (response_url pattern)
- For ephemeral: sends to response_url with `replace_original`
- For regular messages: uses `chat.update()` API
- Supports all message types (text, cards, tables)

### Delete Message (lines 2389-2411)
- Ephemeral: calls `sendToResponseUrl(..., "delete")`
- Regular: calls `chat.delete()` API

---

## 4. THREAD HANDLING

### Thread ID Format
```
slack:{channel}:{threadTs}
```

Where:
- `channel`: C-xxx (public), G-xxx (private), D-xxx (DM)
- `threadTs`: Unix timestamp with fractional seconds or empty string for top-level channel messages

### Encoding/Decoding (lines 2920-2945)
```typescript
encodeThreadId(platformData: SlackThreadId): string {
  return `slack:${platformData.channel}:${platformData.threadTs}`;
}

decodeThreadId(threadId: string): SlackThreadId {
  const parts = threadId.split(":");
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "slack") {
    throw new ValidationError("slack", `Invalid Slack thread ID: ${threadId}`);
  }
  return {
    channel: parts[1],
    threadTs: parts.length === 3 ? parts[2] : ""
  };
}
```

### DM Handling (lines 2928-2931)
```typescript
isDM(threadId: string): boolean {
  const { channel } = this.decodeThreadId(threadId);
  return channel.startsWith("D"); // Slack DM channels start with D
}
```

### Channel-Level Messages (lines 3003-3143)
- Channel ID format: `slack:{channel}`
- `fetchChannelMessages()` uses `conversations.history()` (channel-level)
- `fetchMessages()` uses `conversations.replies()` (thread-level)
- Pagination support in both directions (forward/backward)

---

## 5. INTERACTIONS (Button Clicks, Modals, Slash Commands)

### Block Actions (lines 915-984)
```typescript
private handleBlockActions(
  payload: SlackBlockActionsPayload,
  options?: WebhookOptions
): void {
  const channel = payload.channel?.id || payload.container?.channel_id;
  const messageTs = payload.message?.ts || payload.container?.message_ts;
  const threadTs = payload.message?.thread_ts || payload.container?.thread_ts || messageTs;
  
  for (const action of payload.actions) {
    const actionValue = action.selected_option?.value ?? action.value;
    
    const actionEvent: Omit<ActionEvent, "thread" | "openModal"> = {
      actionId: action.action_id,
      value: actionValue,
      user: {
        userId: payload.user.id,
        userName: payload.user.username || payload.user.name,
        fullName: payload.user.name || payload.user.username,
        isBot: false,
        isMe: false
      },
      messageId: messageTs,
      threadId,
      raw: payload,
      triggerId: payload.trigger_id
    };
    
    this.chat.processAction(actionEvent, options);
  }
}
```

### Slash Commands (lines 870-910)
```typescript
private async handleSlashCommand(
  params: URLSearchParams,
  options?: WebhookOptions
): Promise<Response> {
  const command = params.get("command") || "";
  const text = params.get("text") || "";
  const userId = params.get("user_id") || "";
  const channelId = params.get("channel_id") || "";
  const triggerId = params.get("trigger_id");
  
  const userInfo = await this.lookupUser(userId);
  
  const event = {
    command,
    text,
    user: { userId, userName: userInfo.displayName, ... },
    adapter: this,
    raw: Object.fromEntries(params),
    triggerId,
    channelId: channelId ? `slack:${channelId}` : ""
  };
  
  this.chat.processSlashCommand(event, options);
  return new Response("", { status: 200 });
}
```

### Modal Submission (lines 986-1041)
```typescript
private async handleViewSubmission(
  payload: SlackViewSubmissionPayload,
  options?: WebhookOptions
): Promise<Response> {
  // Flatten Slack's nested value structure
  const values: Record<string, string> = {};
  for (const blockValues of Object.values(payload.view.state.values)) {
    for (const [actionId, input] of Object.entries(blockValues)) {
      values[actionId] = input.value ?? input.selected_option?.value ?? "";
    }
  }
  
  // Decode context metadata
  const { contextId, privateMetadata } = decodeModalMetadata(
    payload.view.private_metadata
  );
  
  const event = {
    callbackId: payload.view.callback_id,
    viewId: payload.view.id,
    values,
    privateMetadata,
    user: { ... },
    adapter: this,
    raw: payload
  };
  
  const response = await this.chat.processModalSubmit(event, contextId, options);
  
  if (response) {
    const slackResponse = this.modalResponseToSlack(response, contextId);
    return new Response(JSON.stringify(slackResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  return new Response("", { status: 200 });
}
```

### Modal Opening (lines 2138-2171)
```typescript
async openModal(
  triggerId: string,
  modal: ModalElement,
  contextId?: string
): Promise<{ viewId: string }> {
  const metadata = encodeModalMetadata({
    contextId,
    privateMetadata: modal.privateMetadata
  });
  const view = modalToSlackView(modal, metadata);
  
  const result = await this.client.views.open(
    this.withToken({
      trigger_id: triggerId,
      view
    })
  );
  
  return { viewId: result.view?.id as string };
}
```

**Modal Metadata Encoding** (lines 45-80 in modals.ts):
- Stores both `contextId` and user `privateMetadata` in Slack's `private_metadata` field
- Format: `JSON.stringify({ c: contextId, m: privateMetadata })`
- Falls back to plain string for backward compatibility

---

## 6. REACTIONS

### Reaction Event Handler (lines 1248-1330)
```typescript
private async handleReactionEvent(
  event: SlackReactionEvent,
  options?: WebhookOptions
): Promise<void> {
  // Only handle reactions to messages
  if (event.item.type !== "message") return;
  
  // Resolve parent thread_ts for threaded replies
  let parentTs = event.item.ts;
  try {
    const result = await this.client.conversations.replies(
      this.withToken({
        channel: event.item.channel,
        ts: event.item.ts,
        limit: 1
      })
    );
    const firstMessage = result.messages?.[0];
    if (firstMessage?.thread_ts) {
      parentTs = firstMessage.thread_ts; // Use parent, not reply
    }
  } catch (error) {
    // Fall back to message ts if lookup fails
  }
  
  const threadId = this.encodeThreadId({
    channel: event.item.channel,
    threadTs: parentTs
  });
  
  const normalizedEmoji = defaultEmojiResolver.fromSlack(event.reaction);
  
  const reactionEvent: Omit<ReactionEvent, "adapter" | "thread"> = {
    emoji: normalizedEmoji,
    rawEmoji: event.reaction,
    added: event.type === "reaction_added",
    user: { userId: event.user, userName: event.user, ... isMe: ... },
    messageId: event.item.ts,
    threadId,
    raw: event
  };
  
  this.chat.processReaction({ ...reactionEvent, adapter: this }, options);
}
```

### Emoji Normalization
- Uses `defaultEmojiResolver.fromSlack()` to convert raw emoji names
- Strips colons for Slack API: `:thumbsup:` → `thumbsup`

### Add/Remove Reactions (lines 2413-2473)
```typescript
async addReaction(
  threadId: string,
  messageId: string,
  emoji: EmojiValue | string
): Promise<void> {
  const { channel } = this.decodeThreadId(threadId);
  const slackEmoji = defaultEmojiResolver.toSlack(emoji);
  const name = slackEmoji.replace(/:/g, "");
  
  await this.client.reactions.add(
    this.withToken({
      channel,
      timestamp: messageId,
      name
    })
  );
}
```

---

## 7. FILE UPLOADS

### Creating Attachments (lines 1688-1737)
```typescript
private createAttachment(file: {
  id?: string;
  mimetype?: string;
  url_private?: string;
  name?: string;
  size?: number;
  original_w?: number;
  original_h?: number;
}): Attachment {
  const url = file.url_private;
  const botToken = this.getToken(); // Capture token at creation time
  
  let type: Attachment["type"] = "file";
  if (file.mimetype?.startsWith("image/")) type = "image";
  else if (file.mimetype?.startsWith("video/")) type = "video";
  else if (file.mimetype?.startsWith("audio/")) type = "audio";
  
  return {
    type,
    url,
    name: file.name,
    mimeType: file.mimetype,
    size: file.size,
    width: file.original_w,
    height: file.original_h,
    fetchData: url
      ? async () => {
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${botToken}` }
          });
          if (!response.ok) {
            throw new NetworkError("slack", `Failed to fetch file: ...`);
          }
          return Buffer.from(await response.arrayBuffer());
        }
      : undefined
  };
}
```

**Key points:**
- Captures bot token at attachment creation (during webhook processing)
- Lazy downloads via `fetchData()` callback
- Supports image, video, audio, and generic files
- Includes dimensions for images/videos

---

## 8. STREAMING (Native Slack Streaming)

### Stream Method (lines 2529-2660)
```typescript
async stream(
  threadId: string,
  textStream: AsyncIterable<string | StreamChunk>,
  options?: StreamOptions
): Promise<RawMessage<unknown>> {
  if (!(options?.recipientUserId && options?.recipientTeamId)) {
    throw new ValidationError("slack", 
      "Slack streaming requires recipientUserId and recipientTeamId in options");
  }
  
  const { channel, threadTs } = this.decodeThreadId(threadId);
  
  // Create streamer with Slack chat.stream() API
  const streamer = this.client.chatStream({
    channel,
    thread_ts: threadTs,
    recipient_user_id: options.recipientUserId,
    recipient_team_id: options.recipientTeamId,
    task_display_mode: options.taskDisplayMode
  });
  
  let first = true;
  let lastAppended = "";
  const renderer = new StreamingMarkdownRenderer();
  
  // For each chunk from the stream
  for await (const chunk of textStream) {
    if (typeof chunk === "string") {
      // Plain text: render incrementally
      renderer.push(chunk);
      const committable = renderer.getCommittableText();
      const delta = committable.slice(lastAppended.length);
      if (delta.length > 0) {
        if (first) {
          await streamer.append({ markdown_text: delta, token } as any);
          first = false;
        } else {
          await streamer.append({ markdown_text: delta });
        }
        lastAppended = committable;
      }
    } else if (chunk.type === "markdown_text") {
      // Structured markdown chunk
      await pushTextAndFlush(chunk.text);
    } else {
      // Task updates, plan updates, etc. — send directly
      await sendStructuredChunk(chunk);
    }
  }
  
  // Flush remaining content
  renderer.finish();
  const finalCommittable = renderer.getCommittableText();
  const finalDelta = finalCommittable.slice(lastAppended.length);
  await flushMarkdownDelta(finalDelta);
  
  const result = await streamer.stop(
    options?.stopBlocks ? { blocks: options.stopBlocks } : undefined
  );
  
  return { id: result.message?.ts ?? result.ts, threadId, raw: result };
}
```

**Features:**
- **Incremental Markdown**: Uses `StreamingMarkdownRenderer` for safe partial markdown
- **Structured Chunks**: Sends task/plan updates directly as native Slack API chunks
- **Graceful Fallback**: If structured chunks fail (missing scopes), continues with text-only streaming
- **Token Passing**: Passes token on first append, reused for subsequent calls
- **Recipients Required**: Must provide `recipientUserId` and `recipientTeamId` for assistant threads

---

## 9. EPHEMERAL MESSAGES

### Encoding (lines 3337-3344)
```typescript
private encodeEphemeralMessageId(
  messageTs: string,
  responseUrl: string,
  userId: string
): string {
  const data = JSON.stringify({ responseUrl, userId });
  return `ephemeral:${messageTs}:${btoa(data)}`;
}
```

### Decoding (lines 3350-3381)
```typescript
private decodeEphemeralMessageId(messageId: string):
  | { messageTs: string; responseUrl: string; userId: string } | null {
  if (!messageId.startsWith("ephemeral:")) return null;
  
  const parts = messageId.split(":");
  if (parts.length < 3) return null;
  
  const messageTs = parts[1];
  const encodedData = parts.slice(2).join(":");
  
  try {
    const decoded = atob(encodedData);
    const data = JSON.parse(decoded);
    if (data.responseUrl && data.userId) {
      return { messageTs, responseUrl: data.responseUrl, userId: data.userId };
    }
  } catch {
    // Fall back
  }
  return null;
}
```

### Posting Ephemeral (lines 1910-2025)
Uses `chat.postEphemeral()` API with `user` parameter
Supports the same message types: text, cards, tables

### Editing/Deleting Ephemeral (lines 2263-2411)
Uses `response_url` to modify ephemeral messages:
```typescript
private async sendToResponseUrl(
  responseUrl: string,
  action: "replace" | "delete",
  options?: { message?: AdapterPostableMessage; threadTs?: string }
): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown>;
  
  if (action === "delete") {
    payload = { delete_original: true };
  } else {
    // Render message and include replace_original
    const text = this.formatConverter.renderPostable(options?.message);
    payload = { replace_original: true, text };
  }
  
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    throw new NetworkError("slack", `Failed to ${action} via response_url`);
  }
  
  return response.ok ? { success: true } : { error: await response.text() };
}
```

---

## 10. ADAPTER INTERFACE IMPLEMENTATION

### Key Methods

| Method | Purpose |
|--------|---------|
| `handleWebhook()` | Entry point for all Slack events |
| `postMessage()` | Send message to thread |
| `postEphemeral()` | Send ephemeral message |
| `editMessage()` | Update message |
| `deleteMessage()` | Remove message |
| `addReaction()` | Add emoji reaction |
| `removeReaction()` | Remove emoji reaction |
| `startTyping()` | Show typing indicator via `assistant.threads.setStatus()` |
| `stream()` | Native Slack streaming |
| `openModal()` | Open slack view/modal |
| `updateModal()` | Update modal in place |
| `openDM()` | Start DM conversation |
| `fetchMessages()` | Get thread messages |
| `fetchChannelMessages()` | Get channel-level messages |
| `listThreads()` | List active threads in channel |
| `fetchThread()` | Get thread metadata |
| `fetchChannelInfo()` | Get channel info |
| `parseMessage()` | Parse raw Slack event to Message |
| `renderFormatted()` | Convert AST to Slack mrkdwn |

---

## 11. FORMAT CONVERSION

### Markdown to Slack mrkdwn (lines in markdown.ts)

| Markdown | Slack |
|----------|-------|
| `**bold**` | `*bold*` |
| `_italic_` | `_italic_` |
| `~~strikethrough~~` | `~strikethrough~` |
| `[text](url)` | `<url\|text>` |
| `@user` | `<@USER_ID>` |
| `#channel` | `<#CHANNEL_ID\|name>` |

### Slack mrkdwn to AST (lines 76-102)
1. Parse user mentions: `<@U123|name>` → `@name`
2. Parse channel mentions: `<#C123|name>` → `#name`
3. Parse links: `<url|text>` → `[text](url)`
4. Convert bold: `*text*` → `**text**`
5. Convert strikethrough: `~text~` → `~~text~~`
6. Parse with standard markdown parser

### Table Support (markdown.ts lines 109-158)
- Renders mdast table nodes to Slack table blocks (native Block Kit support)
- Falls back to ASCII tables for multiple tables or large tables (>100 rows, >20 cols)

---

## 12. MULTI-WORKSPACE SUPPORT

### Architecture
- **Single-workspace**: Uses `defaultBotToken` provided at construction
- **Multi-workspace**: No `defaultBotToken`; resolves per-request via `resolveTokenForTeam()`

### Installation Storage (lines 454-517)
```typescript
async setInstallation(
  teamId: string,
  installation: SlackInstallation
): Promise<void> {
  const state = this.chat.getState();
  const key = this.installationKey(teamId); // "slack:installation:{teamId}"
  
  const dataToStore = this.encryptionKey
    ? {
        ...installation,
        botToken: encryptToken(installation.botToken, this.encryptionKey)
      }
    : installation;
  
  await state.set(key, dataToStore);
}
```

### OAuth Callback (lines 524-569)
```typescript
async handleOAuthCallback(request: Request): Promise<{ teamId: string; installation: SlackInstallation }> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  
  const result = await this.client.oauth.v2.access({
    client_id: this.clientId,
    client_secret: this.clientSecret,
    code,
    redirect_uri: url.searchParams.get("redirect_uri")
  });
  
  const teamId = result.team?.id;
  const installation = {
    botToken: result.access_token,
    botUserId: result.bot_user_id,
    teamName: result.team?.name
  };
  
  await this.setInstallation(teamId, installation);
  return { teamId, installation };
}
```

### Request Context (lines 327-330, 591-593)
Uses Node.js `AsyncLocalStorage` for per-request token isolation:
```typescript
private readonly requestContext = new AsyncLocalStorage<{
  token: string;
  botUserId?: string;
}>();

withBotToken<T>(token: string, fn: () => T): T {
  return this.requestContext.run({ token }, fn);
}
```

---

## 13. ID GENERATION & MAPPING

### User ID Caching (lines 645-700)
```typescript
private async lookupUser(userId: string): 
  Promise<{ displayName: string; realName: string }> {
  const cacheKey = `slack:user:${userId}`;
  
  // Check state-backed cache first (1 hour TTL)
  if (this.chat) {
    const cached = await this.chat.getState().get<CachedUser>(cacheKey);
    if (cached) {
      return { displayName: cached.displayName, realName: cached.realName };
    }
  }
  
  try {
    const result = await this.client.users.info(
      this.withToken({ user: userId })
    );
    const user = result.user;
    
    // Priority: profile.display_name > profile.real_name > real_name > name > userId
    const displayName = 
      user?.profile?.display_name ||
      user?.profile?.real_name ||
      user?.real_name ||
      user?.name ||
      userId;
    
    // Cache via state adapter (serverless-compatible)
    if (this.chat) {
      await this.chat.getState().set(
        cacheKey,
        { displayName, realName },
        60 * 60 * 1000 // 1 hour
      );
    }
    
    return { displayName, realName };
  } catch (error) {
    // Fall back to user ID
    return { displayName: userId, realName: userId };
  }
}
```

### Ephemeral Message ID Encoding
Special format for ephemeral messages: `ephemeral:{messageTs}:{base64(json)}`
- Encodes `responseUrl` and `userId` for future modifications

---

## 14. EDGE CASES & SPECIAL HANDLING

### DM Threading (lines 1217-1222)
- **Top-level DMs**: Use empty threadTs for subscription matching
- **DM Threads**: Use actual thread_ts for per-conversation isolation

### Bot Message Detection (lines 3300-3318)
```typescript
private isMessageFromSelf(event: SlackEvent): boolean {
  // Check request context first (multi-workspace)
  const ctx = this.requestContext.getStore();
  if (ctx?.botUserId && event.user === ctx.botUserId) return true;
  
  // User ID match (for messages sent as bot user)
  if (this._botUserId && event.user === this._botUserId) return true;
  
  // Bot ID match (for bot_message subtypes)
  if (this._botId && event.bot_id === this._botId) return true;
  
  return false;
}
```

Note: Slack has two bot identity patterns:
- **User ID** (`U_xxx`): When bot messages sent as user
- **Bot ID** (`B_xxx`): For subtypes marked as `bot_message`

### Mention Resolution (lines 1562-1631)
Converts `<@U123>` to `<@U123|displayName>` for proper rendering:
- Avoids ReDoS by splitting on `<` and searching for matching `>`
- Can skip self-mentions for incoming webhooks (where mention detection applies)
- Caches user lookups in state

### Typing Indicator (lines 2487-2514)
```typescript
async startTyping(threadId: string, status?: string): Promise<void> {
  const { channel, threadTs } = this.decodeThreadId(threadId);
  if (!threadTs) return; // Skip if no thread context
  
  try {
    await this.client.assistant.threads.setStatus(
      this.withToken({
        channel_id: channel,
        thread_ts: threadTs,
        status: status ?? "Typing...",
        loading_messages: [status ?? "Typing..."]
      })
    );
  } catch (error) {
    this.logger.warn("Slack setStatus failed", { ... });
    // Silently fail — not critical
  }
}
```

---

## 15. ERROR HANDLING

### Slack Error Handler (lines 3320-3331)
```typescript
private handleSlackError(error: unknown): never {
  const slackError = error as { data?: { error?: string }; code?: string };
  
  if (
    slackError.code === "slack_webapi_platform_error" &&
    slackError.data?.error === "ratelimited"
  ) {
    throw new AdapterRateLimitError("slack");
  }
  
  throw error;
}
```

### Rate Limit Detection
Converts Slack rate limit errors to `AdapterRateLimitError` for uniform handling

---

## KEY PATTERNS TO IMPLEMENT

### 1. **Async Local Storage for Multi-Workspace**
```typescript
private readonly requestContext = new AsyncLocalStorage<TokenContext>();

// In webhook handler
if (multiWorkspaceMode && teamId) {
  const ctx = await resolveTokenForTeam(teamId);
  return this.requestContext.run(ctx, () => processWebhook());
}
```

### 2. **State-Backed Caching**
```typescript
const cacheKey = `slack:user:${userId}`;
const cached = await this.chat.getState().get(cacheKey);
if (cached) return cached;

const result = await fetchFromAPI();
await this.chat.getState().set(cacheKey, result, ttl_ms);
```

### 3. **Thread ID Encoding as Platform Bridge**
```typescript
encodeThreadId({ channel, threadTs }): string {
  return `slack:${channel}:${threadTs}`;
}
```

### 4. **Format Conversion Pipeline**
- Raw Slack mrkdwn → normalize mentions → parse to AST → extract plain text
- AST → render to Slack blocks (cards, tables) or mrkdwn

### 5. **Ephemeral Message Tracking**
```typescript
encodeEphemeralMessageId(ts, responseUrl, userId): string {
  return `ephemeral:${ts}:${btoa(JSON.stringify({ responseUrl, userId }))}`;
}
// Allows future edits/deletes via response_url without storing state
```

### 6. **Signature Verification with Timing-Safe Comparison**
```typescript
const sigBasestring = `v0:${timestamp}:${body}`;
const expectedSig = "v0=" + hmac("sha256", secret).digest("hex");
return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
```

---

## ASSEMBLY SUMMARY

The Slack adapter is a comprehensive, production-hardened implementation featuring:

✅ **Complete webhook handling** with signature verification  
✅ **Multi-workspace OAuth support** with encrypted token storage  
✅ **Intelligent thread ID mapping** for per-thread isolation  
✅ **Native streaming** via Slack's chat.stream() API  
✅ **Modals and interactive payloads** with context preservation  
✅ **File uploads** with lazy content fetching  
✅ **Emoji normalization** across platforms  
✅ **User caching** with state-backed TTL  
✅ **Format conversion** between Slack mrkdwn and standard markdown  
✅ **Ephemeral message tracking** without server state  
✅ **Graceful fallbacks** for API feature gaps  
✅ **Request-scoped token isolation** for multi-workspace concurrency  

All patterns are designed for **serverless deployment** (no in-memory state, state-backed caching) and **TypeScript safety** (full type coverage, no implicit any).
