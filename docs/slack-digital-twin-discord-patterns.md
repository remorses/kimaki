# Slack Digital Twin - Discord Interaction Patterns & Test Scenarios

## Overview
This document summarizes the Discord bot interaction patterns that the slack-digital-twin needs to replicate for testing Slack-based Kimaki deployments.

---

## 1. THREAD CREATION PATTERNS

### Pattern 1a: Auto-Thread on First User Message
- **When:** User sends first message to a text channel (not a thread)
- **What happens:**
  - Bot detects message in text channel via `MessageCreate` event
  - Bot calls `message.startThread({ name, autoArchiveDuration })`
  - Stores thread ID in database as session anchor
  - Adds user to thread via `thread.members.add(userId)`
  - Returns thread ID for future message routing
- **Key Discord APIs:**
  - `Message.startThread(options)`
  - `ThreadChannel.members.add(userId)`

### Pattern 1b: Bot-Initiated Thread (CLI/Scheduled)
- **When:** Kimaki CLI sends initial prompt via REST, or scheduled task triggers session
- **What happens:**
  - CLI creates ephemeral bot message with embedded metadata in footer (YAML)
  - Footer contains: `cliThreadPrompt`, `userId`, `username`, `agent`, `model`
  - Triggers `ThreadCreate` event when thread is auto-created
  - Bot parses footer marker and starts session automatically
- **Key Discord APIs:**
  - `Message.embeds[].footer.text` (stores YAML metadata)
  - `ThreadCreate` event (detects bot-initiated threads)

### Pattern 1c: Slash Command Contexts
- **When:** User runs `/new-session` or other commands in text channel
- **What happens:**
  - Slash command interaction in text channel
  - Bot creates thread, then starts session
  - Thread ID is resolved and stored for command context

---

## 2. MESSAGE POSTING & EDITING IN THREADS

### Pattern 2a: Sequential Message Posting
- **When:** Bot sends multiple text parts, tool parts, footer
- **What happens:**
  - Each part formatted as separate Discord message
  - Text parts prefixed with `⬥ ` (bullet)
  - Tool parts prefixed with `┣ ` or `◼︎ ` (for file edits/writes)
  - Context usage shown with `⬦ ` prefix at ~10% windows
  - Footer message sent at run completion: `*project ⋅ branch ⋅ 2m 30s ⋅ 71% ⋅ model-name*`
- **Key Discord APIs:**
  - `ThreadChannel.send({ content })`
  - `Message.edit({ content, components })`

### Pattern 2b: Message Splitting (Discord 2000-char limit)
- **When:** Bot response exceeds 2000 characters
- **What happens:**
  - Content split into 2000-char chunks
  - Code blocks preserved and not broken mid-line
  - Tables split intelligently
  - Each chunk posted as separate message
- **Key Discord APIs:**
  - Multiple `ThreadChannel.send()` calls

### Pattern 2c: Message Edit for Updates
- **When:** Run state changes (progress, error, completion)
- **What happens:**
  - Fetch message by ID
  - Update content and/or components
  - Used for progress bars, status changes
- **Key Discord APIs:**
  - `Message.edit({ content, components })`

### Pattern 2d: Message Deletion
- **When:** Session aborted or message no longer needed
- **What happens:**
  - Fetch message by ID
  - Call `message.delete()`
- **Key Discord APIs:**
  - `Message.delete()`

---

## 3. SLASH COMMANDS (Interaction Patterns)

### Common Commands:
- `/new-session` - Start new OpenCode session (with directory autocomplete)
- `/resume` - Resume paused session (with session ID autocomplete)
- `/model` - Set/change model for channel/session (select menu flow)
- `/abort` - Stop current session in thread
- `/queue` - Queue message for next session end (local queue mode)
- `/clear-queue` - Discard queued messages
- `/fork` - Create git worktree from current session
- `/ask-question` - Prompt for user confirmation (permission/choice)
- `/file-upload` - Upload file to working directory
- `/permissions` - Check/grant execution permissions
- `/login` - OAuth flow (provider, API key modal)
- `/verbosity` - Set tool output verbosity

### Command Patterns:
1. **Autocomplete Select** - User types, bot provides filtered options (256 chars max)
2. **Select Menu** - Post ephemeral message with select menu, user chooses, bot processes
3. **Modal Submission** - Post modal dialog, user fills form, bot receives `ModalSubmit` interaction
4. **Ephemeral Reply** - Command replies with flag `MessageFlags.Ephemeral` (only user sees)

### Key Discord APIs:
- `ChatInputCommandInteraction.reply(options)` - respond to slash command
- `StringSelectMenuBuilder` - create select dropdowns
- `ModalBuilder` - create text input dialogs
- `AutocompleteInteraction.respond(choices)` - respond to autocomplete

---

## 4. REACTIONS (Bot Reacting to Messages)

### Pattern 4a: Thread Marker Reaction
- **When:** Thread is created (especially worktree threads)
- **What happens:**
  - Bot adds emoji reaction to thread starter message
  - Uses tree emoji (🌳) for worktree threads
  - Marks thread type visually
- **Key Discord APIs:**
  - `REST.put(Routes.channelMessageOwnReaction(channelId, messageId, emoji))`

### Pattern 4b: Reaction to User Message
- **Currently:** Not heavily used in Kimaki
- **Potential:** Could mark completed sessions, errors, etc.

---

## 5. MESSAGE QUEUEING & CONCURRENT HANDLING

### Pattern 5a: Local Queue Mode (`/queue` command)
- **When:** User runs `/queue message`
- **What happens:**
  - Message enqueued to `ThreadSessionRuntime.enqueueIncoming(mode: 'local-queue')`
  - Stores in `threadState.queuedMessages` array
  - When session becomes idle, messages processed one-by-one
  - Bot posts `» username: queued_message` format
- **Key:** Messages are buffered in memory during active session

### Pattern 5b: Direct Channel Message
- **When:** User sends message directly to thread
- **What happens:**
  - `MessageCreate` event triggered
  - If runtime exists, enqueues to `mode: 'direct'`
  - If session is idle, starts immediately
  - If session is busy, queues for next turn
- **Key:** Runtime routes based on session state

### Pattern 5c: Concurrent Message Handling
- **When:** Multiple messages arrive while session running
- **What happens:**
  - Each message triggers separate `MessageCreate` event
  - Runtime queue ensures FIFO ordering
  - No message loss or race conditions

---

## 6. TYPING INDICATOR LIFECYCLE

### Pattern 6a: Typing Start
- **When:** Session becomes busy (OpenCode event: `session.status: busy`)
- **What happens:**
  - Call `ThreadChannel.sendTyping()`
  - Shows "Bot is typing..." indicator
  - Lasts ~10 seconds
- **Key:** Must call every 7-8 seconds for long-running operations

### Pattern 6b: Typing Stop
- **When:** Final bot message posted
- **What happens:**
  - Stop calling `sendTyping()`
  - Discord automatically hides indicator after last message
  - Footer message ends the typing indicator

### Pattern 6c: Typing Re-pulse
- **When:** Multiple assistant messages in one session turn
- **What happens:**
  - After non-final message (e.g., tool start)
  - Call `sendTyping()` again if session still busy
  - Prevents indicator from disappearing mid-session
- **Key:** Guard with session closed/aborted checks

---

## 7. FILE UPLOAD & ATTACHMENT HANDLING

### Pattern 7a: User Uploads File to Thread
- **When:** User attaches file to message in thread
- **What happens:**
  - `Message.attachments` contains file metadata (URL, filename, size)
  - `DiscordFileAttachment` extracted with `sourceUrl`
  - File used in OpenCode session (read, compare, diff)
  - Stored in database for session context
- **Key Discord APIs:**
  - `Message.attachments` collection

### Pattern 7b: Bot Uploads File to Thread
- **When:** OpenCode generates/modifies file, bot shares it
- **What happens:**
  - Read file from filesystem
  - Create `MessageAttachment` from buffer
  - Post message with `files: [attachment]`
  - Discord CDN hosts file
- **Key Discord APIs:**
  - `AttachmentBuilder` from `discord.js`
  - `ThreadChannel.send({ files: [attachment] })`

### Pattern 7c: File Upload Command (`/file-upload`)
- **When:** User clicks "Upload File" button or runs command
- **What happens:**
  - Post modal with text input (file path)
  - User pastes content or path
  - Bot validates, stores in thread context
- **Key Discord APIs:**
  - `ModalSubmit` interaction

---

## 8. PERMISSION & ROLE CHECKING

### Pattern 8a: Bot Access Check
- **When:** Message received
- **What happens:**
  - Check `hasKimakiBotPermission(member, guild)`
  - Returns true if: owner, admin, "Manage Guild", or "kimaki" role
  - Returns false if: "no-kimaki" role present (override)
- **Key:** Permission checks happen early, before session creation

### Pattern 8b: Mention Mode
- **When:** Channel has `mention_mode = true` in database
- **What happens:**
  - Only process messages if bot @mentioned or `!` command
  - Silent ignore for regular messages
  - Useful for shared channels

---

## 9. COMPONENT INTERACTIONS (Buttons, Selects, Modals)

### Pattern 9a: Button Click
- **When:** User clicks button on bot message
- **What happens:**
  - `ButtonInteraction` event
  - `customId` identifies action (max 100 chars, must be short)
  - Context stored server-side by hash (to avoid ID length limits)
  - Bot processes action, updates message or shows new message

### Pattern 9b: Select Menu
- **When:** User selects option from dropdown
- **What happens:**
  - `StringSelectMenuInteraction` event
  - `customId` identifies which menu
  - `values` array contains selected options
  - Bot responds with result or new state

### Pattern 9c: Modal Submission
- **When:** User submits modal form
- **What happens:**
  - `ModalSubmitInteraction` event
  - `fields` contain user text input
  - Bot processes and stores (API key, settings, etc.)

---

## 10. SESSION LIFECYCLE EVENTS

### Pattern 10a: Session Start
- **When:** First user message or thread created
- **What happens:**
  - `ThreadSessionRuntime` created for thread
  - OpenCode `session.create()` called
  - Session stored in database
  - Runtime holds resource handles (listeners, timers)

### Pattern 10b: Session Abort
- **When:** `/abort` command or timeout
- **What happens:**
  - `session.abort()` called
  - Active timers cleared
  - Listeners unsubscribed
  - No footer message shown
  - Queue cleared

### Pattern 10c: Session Resume
- **When:** `/resume` command with session ID
- **What happens:**
  - Fetch existing session from database
  - Create new runtime for thread
  - Subscribe to existing session events
  - Continue message processing

---

## 11. VOICE MESSAGES (Special Case)

### Pattern 11a: Voice Attachment
- **When:** User sends audio file attachment
- **What happens:**
  - Detect `.mp3`, `.wav`, `.m4a`, etc.
  - Transcribe via Gemini API (or deterministic in tests)
  - Prepend "Transcribed message: " to text
  - Process as normal message
- **Key:** Deterministic transcription in tests via `store.deterministicTranscription`

---

## 12. ERROR & CLEANUP SCENARIOS

### Pattern 12a: Thread Deletion
- **When:** User deletes thread
- **What happens:**
  - `ThreadDelete` event triggered
  - `disposeRuntime(threadId)` called
  - All resources freed (timers, listeners)
  - Database session entry remains (for history)

### Pattern 12b: Runtime Idle Timeout
- **When:** Thread has no activity for extended period
- **What happens:**
  - Idle sweeper detects stale runtime
  - Calls `disposeRuntime(threadId)`
  - Frees memory for inactive threads

### Pattern 12c: Permission Denied
- **When:** User lacks "kimaki" role
- **What happens:**
  - Reply: "You don't have permission to start sessions"
  - Message flags: `SILENT_MESSAGE_FLAGS` (no ping, hide preview)

---

## TEST SCENARIOS FOR SLACK DIGITAL TWIN

Below are 18+ concrete scenarios that should be tested to ensure Slack behavior matches Discord:

### **Message & Threading** (4 scenarios)
1. **Auto-thread creation on first message** - User sends message to channel → thread created → session started
2. **Multiple messages in thread create queue** - User sends 3 messages in quick succession → all queued in order → executed sequentially
3. **Message splitting at 2000 chars** - Bot posts response >2000 chars → split into multiple messages → all in correct thread
4. **Message edit updates content** - Bot posts initial status → session progresses → edits message with updated content

### **Command Interactions** (4 scenarios)
5. **Slash command with autocomplete** - User runs `/new-session` → autocomplete filters directories → user selects → session starts
6. **Select menu interaction** - User runs `/model` → select menu appears → user picks model → model changed
7. **Modal submission** - User runs `/login` → modal appears → enters API key → key stored in DB
8. **Ephemeral command reply** - User runs `/abort` → reply visible only to user → others don't see it

### **Typing Indicator** (2 scenarios)
9. **Typing pulses during long session** - Session runs for 20 seconds → typing indicator appears continuously → stops with final message
10. **No typing after abort** - User aborts session → typing immediately stops → no footer shown

### **Message Queueing** (2 scenarios)
11. **Local queue mode** - User runs `/queue msg1` → `/queue msg2` → session idle → executes msg1 → then msg2
12. **Direct messages queue while busy** - Session running → user sends 2 messages → both queued → executed after session idle

### **File Handling** (3 scenarios)
13. **User uploads file as attachment** - User attaches file to message → bot receives attachment URL → uses in session
14. **Bot uploads file to thread** - Session generates file → bot posts with attachment → file appears in Discord
15. **File upload command** - User runs `/file-upload` → modal for path → file stored for session

### **Reactions & Markers** (2 scenarios)
16. **Thread reaction marks worktree** - Worktree thread created → bot adds 🌳 reaction → marks thread type
17. **Multiple users in thread** - User1 creates thread → User2 joins → User1 runs `/abort` → User2 sees abort confirmation

### **Concurrent & Edge Cases** (3 scenarios)
18. **Rapid message succession** - User sends 5 messages in <1 second → all handled in FIFO order → none lost
19. **Thread deleted while session active** - Thread running → user deletes thread → session stops → no errors in logs
20. **Permission denied for no-kimaki role** - User has no-kimaki role → sends message → bot replies "blocked" → no session created

### **Voice Messages** (1 scenario)
21. **Voice message transcription** - User attaches audio file → bot transcribes → prepends "Transcribed: " → processes as text

---

## KEY SLACK BRIDGE API CALLS (What slack-digital-twin Must Support)

From `discord-slack-bridge/src/rest-translator.ts`:

### **Message Operations**
- `slack.chat.postMessage({ channel, thread_ts?, text, blocks })`
- `slack.chat.update({ channel, ts, text, blocks })`
- `slack.chat.delete({ channel, ts })`
- `slack.conversations.history({ channel, limit, latest, oldest })`
- `slack.conversations.replies({ channel, ts, limit, latest, oldest })`
- `slack.reactions.add({ channel, name, timestamp })`
- `slack.reactions.remove({ channel, name, timestamp })`

### **File Upload (2-step)**
- `slack.files.getUploadURLExternal({ filename, length })`
- `PUT <upload_url>` (presigned URL)
- `slack.files.completeUploadExternal({ files, channel_id, thread_ts })`

### **User/Channel Info**
- `slack.users.info({ user })`
- `slack.users.list()`
- `slack.conversations.info({ channel })`
- `slack.conversations.list()`

### **Component Handling**
- `slack.views.open({ trigger_id, view })` (for modals)
- Block Kit buttons/selects in `chat.postMessage` blocks

---

## TRANSLATION BOUNDARIES (What Bridge Must Handle)

### **Discord → Slack**
- Thread ID encoding: `THR_{channel}_{ts_no_dots}` → resolve to `(channel, thread_ts)`
- Message ID encoding: `MSG_{channel}_{ts_no_dots}` → resolve to `(channel, ts)`
- Markdown → mrkdwn: `**bold**` → `*bold*`, `~~strike~~` → `~strike~`, `[text](url)` → `<url|text>`
- Discord components → Block Kit blocks (buttons, select menus)

### **Slack → Discord**
- mrkdwn → Markdown: `*bold*` → `**bold**`, `~strike~` → `~~strike~~`, `<url|text>` → `[text](url)`
- Slack thread_ts → Discord thread channel ID
- Slack reactions → Discord MESSAGE_REACTION_ADD/REMOVE events

---

## IMPORTANT TESTING NOTES

1. **ID Encoding is Stateless** - All conversions deterministic, no database needed
2. **Timestamp Format** - Slack: `1503435956.000247` (seconds.microseconds), Discord: ISO 8601
3. **Thread Model Difference**:
   - Discord: Threads are channels with `type: PublicThread` and `parent_id`
   - Slack: Threads are replies to a message with `thread_ts`
   - Bridge maps: Discord `thread_id` → Slack `(channel_id, thread_ts)`
4. **Rate Limiting** - Mock Slack API should allow rapid requests (no real rate limits)
5. **Block Kit Limitations**:
   - Max 40 components per message
   - Select menus must be single element in action row
   - Section max 3 text children + 1 accessory
