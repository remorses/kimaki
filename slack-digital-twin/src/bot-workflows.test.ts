// Tests that simulate real bot workflows similar to what Kimaki does on Discord.
// These validate the slack-digital-twin handles the interaction patterns that
// the discord-slack-bridge relies on: thread creation via first message,
// sequential bot messages in threads, edit-then-delete flows, reactions,
// file uploads, channel lifecycle, and concurrent operations.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { WebClient } from '@slack/web-api'
import { SlackDigitalTwin } from './index.ts'

describe('bot workflows - thread creation and messaging', () => {
  let twin: SlackDigitalTwin
  let client: WebClient

  beforeAll(async () => {
    twin = new SlackDigitalTwin({
      channels: [{ name: 'general' }, { name: 'projects' }],
      users: [
        { name: 'alice', realName: 'Alice Smith' },
        { name: 'bob', realName: 'Bob Jones' },
      ],
    })
    await twin.start()
    client = new WebClient(twin.botToken, {
      slackApiUrl: twin.apiUrl,
      retryConfig: { retries: 0 },
    })
  })

  afterAll(async () => {
    await twin.stop()
  })

  // In Slack, creating a thread = posting a parent message, then replying
  // with thread_ts set to the parent's ts. The bridge does this for every
  // Discord thread creation.
  test('thread creation: post parent then reply in thread', async () => {
    const channelId = twin.resolveChannelId('general')

    const parent = await client.chat.postMessage({
      channel: channelId,
      text: 'New coding session started',
    })
    expect(parent.ts).toBeTruthy()

    const reply1 = await client.chat.postMessage({
      channel: channelId,
      text: 'Reading file src/index.ts...',
      thread_ts: parent.ts!,
    })
    const reply2 = await client.chat.postMessage({
      channel: channelId,
      text: 'Editing src/index.ts...',
      thread_ts: parent.ts!,
    })

    // Verify thread via conversations.replies
    const replies = await client.conversations.replies({
      channel: channelId,
      ts: parent.ts!,
    })

    expect(replies.messages?.length).toBe(3)
    expect(replies.messages?.[0]?.text).toBe('New coding session started')
    expect(replies.messages?.[1]?.text).toBe('Reading file src/index.ts...')
    expect(replies.messages?.[2]?.text).toBe('Editing src/index.ts...')
  })

  // Kimaki posts many sequential messages in a thread (tool outputs, text
  // parts, context usage, footer). All must appear in order.
  test('sequential bot messages maintain order in thread', async () => {
    const channelId = twin.resolveChannelId('general')

    const parent = await client.chat.postMessage({
      channel: channelId,
      text: 'Session thread',
    })

    const messages: string[] = [
      '⬥ I will read the file first.',
      '┣ bash: cat src/main.ts',
      '⬥ The file contains a simple function. Let me edit it.',
      '◼︎ edit: src/main.ts',
      '⬦ 15% context used',
      'kimakivoice ⋅ main ⋅ 0m 30s ⋅ 15% ⋅ claude-opus-4-6',
    ]

    for (const text of messages) {
      await client.chat.postMessage({
        channel: channelId,
        text,
        thread_ts: parent.ts!,
      })
    }

    const replies = await client.conversations.replies({
      channel: channelId,
      ts: parent.ts!,
    })

    // Parent + 6 replies = 7
    expect(replies.messages?.length).toBe(7)
    const replyTexts = replies.messages?.slice(1).map((m) => m.text) ?? []
    expect(replyTexts).toEqual(messages)
  })

  // Thread messages should NOT appear in channel history (only top-level
  // messages appear there). This is how Slack works.
  test('thread replies are excluded from conversations.history', async () => {
    const channelId = twin.resolveChannelId('projects')

    const parent = await client.chat.postMessage({
      channel: channelId,
      text: 'Parent in projects',
    })

    await client.chat.postMessage({
      channel: channelId,
      text: 'Reply in thread',
      thread_ts: parent.ts!,
    })

    const history = await client.conversations.history({ channel: channelId })
    const texts = history.messages?.map((m) => m.text) ?? []

    expect(texts).toContain('Parent in projects')
    expect(texts).not.toContain('Reply in thread')
  })

  // The bridge edits messages (e.g. updating a tool status from pending to done)
  // then reads them back via conversations.replies.
  test('edit message in thread and verify via replies', async () => {
    const channelId = twin.resolveChannelId('general')

    const parent = await client.chat.postMessage({
      channel: channelId,
      text: 'Edit test thread',
    })

    const toolMsg = await client.chat.postMessage({
      channel: channelId,
      text: '┣ bash: running tests... (pending)',
      thread_ts: parent.ts!,
    })

    await client.chat.update({
      channel: channelId,
      ts: toolMsg.ts!,
      text: '┣ bash: running tests... (done, exit 0)',
    })

    const replies = await client.conversations.replies({
      channel: channelId,
      ts: parent.ts!,
    })

    const editedMsg = replies.messages?.find((m) => m.ts === toolMsg.ts)
    expect(editedMsg?.text).toBe('┣ bash: running tests... (done, exit 0)')
    expect(editedMsg?.edited).toBeTruthy()
  })

  // Delete a message in a thread (e.g. removing a temporary status message)
  test('delete message in thread removes it from replies', async () => {
    const channelId = twin.resolveChannelId('general')

    const parent = await client.chat.postMessage({
      channel: channelId,
      text: 'Delete test thread',
    })

    const tempMsg = await client.chat.postMessage({
      channel: channelId,
      text: 'Temporary typing indicator...',
      thread_ts: parent.ts!,
    })

    const finalMsg = await client.chat.postMessage({
      channel: channelId,
      text: '⬥ Here is the answer.',
      thread_ts: parent.ts!,
    })

    await client.chat.delete({
      channel: channelId,
      ts: tempMsg.ts!,
    })

    const replies = await client.conversations.replies({
      channel: channelId,
      ts: parent.ts!,
    })

    const tsValues = replies.messages?.map((m) => m.ts) ?? []
    expect(tsValues).toContain(parent.ts)
    expect(tsValues).not.toContain(tempMsg.ts)
    expect(tsValues).toContain(finalMsg.ts)
  })
})

describe('bot workflows - reactions', () => {
  let twin: SlackDigitalTwin
  let client: WebClient

  beforeAll(async () => {
    twin = new SlackDigitalTwin({
      channels: [{ name: 'general' }],
      users: [{ name: 'alice' }],
    })
    await twin.start()
    client = new WebClient(twin.botToken, {
      slackApiUrl: twin.apiUrl,
      retryConfig: { retries: 0 },
    })
  })

  afterAll(async () => {
    await twin.stop()
  })

  // Bot reacts to a user message to acknowledge it (e.g. eyes emoji when
  // starting to process, checkmark when done)
  test('bot adds reaction to user message then removes it', async () => {
    const channelId = twin.resolveChannelId('general')

    // User sends a message
    const userMsg = await twin.user('alice').sendMessage({
      channel: 'general',
      text: 'please fix the bug',
    })

    // Bot adds eyes reaction (acknowledging)
    await client.reactions.add({
      channel: channelId,
      timestamp: userMsg.ts,
      name: 'eyes',
    })

    // Verify reaction appears on the message
    let messages = await twin.channel('general').getMessages()
    let msg = messages.find((m) => m.ts === userMsg.ts)
    expect(msg?.reactions?.length).toBe(1)
    expect(msg?.reactions?.[0]?.name).toBe('eyes')

    // Bot removes eyes and adds checkmark (done)
    await client.reactions.remove({
      channel: channelId,
      timestamp: userMsg.ts,
      name: 'eyes',
    })
    await client.reactions.add({
      channel: channelId,
      timestamp: userMsg.ts,
      name: 'white_check_mark',
    })

    messages = await twin.channel('general').getMessages()
    msg = messages.find((m) => m.ts === userMsg.ts)
    const reactionNames = msg?.reactions?.map((r) => r.name) ?? []
    expect(reactionNames).toContain('white_check_mark')
    expect(reactionNames).not.toContain('eyes')
  })

  // Multiple reactions from different sources on the same message
  test('multiple reactions from bot and user on same message', async () => {
    const channelId = twin.resolveChannelId('general')

    const msg = await twin.user('alice').sendMessage({
      channel: 'general',
      text: 'great work!',
    })

    // User reacts
    await twin.user('alice').addReaction({
      channel: 'general',
      messageTs: msg.ts,
      name: 'thumbsup',
    })

    // Bot reacts
    await client.reactions.add({
      channel: channelId,
      timestamp: msg.ts,
      name: 'robot_face',
    })

    const messages = await twin.channel('general').getMessages()
    const reactedMsg = messages.find((m) => m.ts === msg.ts)
    const reactionNames = reactedMsg?.reactions?.map((r) => r.name) ?? []
    expect(reactionNames).toContain('thumbsup')
    expect(reactionNames).toContain('robot_face')
  })

  // Reaction on a message inside a thread
  test('reaction on thread reply message', async () => {
    const channelId = twin.resolveChannelId('general')

    const parent = await client.chat.postMessage({
      channel: channelId,
      text: 'Thread with reactions',
    })

    const reply = await client.chat.postMessage({
      channel: channelId,
      text: 'Bot reply in thread',
      thread_ts: parent.ts!,
    })

    await client.reactions.add({
      channel: channelId,
      timestamp: reply.ts!,
      name: 'tada',
    })

    // Verify via conversations.replies that the reaction is on the reply
    const replies = await client.conversations.replies({
      channel: channelId,
      ts: parent.ts!,
    })

    const reactedReply = replies.messages?.find((m) => m.ts === reply.ts)
    expect(reactedReply?.reactions?.length).toBe(1)
    expect(reactedReply?.reactions?.[0]?.name).toBe('tada')
  })
})

describe('bot workflows - file uploads', () => {
  let twin: SlackDigitalTwin
  let client: WebClient

  beforeAll(async () => {
    twin = new SlackDigitalTwin({
      channels: [{ name: 'general' }],
      users: [{ name: 'alice' }],
    })
    await twin.start()
    client = new WebClient(twin.botToken, {
      slackApiUrl: twin.apiUrl,
      retryConfig: { retries: 0 },
    })
  })

  afterAll(async () => {
    await twin.stop()
  })

  // The bridge uses Slack's 2-step upload: getUploadURLExternal then
  // completeUploadExternal. Both must return ok: true.
  test('2-step file upload flow succeeds', async () => {
    const uploadUrl = await client.files.getUploadURLExternal({
      filename: 'patch.diff',
      length: 1234,
    })

    expect(uploadUrl.ok).toBe(true)
    expect(uploadUrl.upload_url).toBeTruthy()
    expect(uploadUrl.file_id).toBeTruthy()

    const complete = await client.files.completeUploadExternal({
      files: [{ id: uploadUrl.file_id!, title: 'patch.diff' }],
      channel_id: twin.resolveChannelId('general'),
    })

    expect(complete.ok).toBe(true)
  })

  // Multiple file uploads in sequence (e.g. bot uploading several edited files)
  test('multiple sequential file uploads', async () => {
    const filenames = ['file1.ts', 'file2.ts', 'file3.ts']

    for (const filename of filenames) {
      const upload = await client.files.getUploadURLExternal({
        filename,
        length: 500,
      })
      expect(upload.ok).toBe(true)

      const complete = await client.files.completeUploadExternal({
        files: [{ id: upload.file_id!, title: filename }],
        channel_id: twin.resolveChannelId('general'),
      })
      expect(complete.ok).toBe(true)
    }
  })
})

describe('bot workflows - channel lifecycle', () => {
  let twin: SlackDigitalTwin
  let client: WebClient

  beforeAll(async () => {
    twin = new SlackDigitalTwin({
      channels: [{ name: 'general' }, { name: 'old-project' }],
      users: [{ name: 'alice' }],
    })
    await twin.start()
    client = new WebClient(twin.botToken, {
      slackApiUrl: twin.apiUrl,
      retryConfig: { retries: 0 },
    })
  })

  afterAll(async () => {
    await twin.stop()
  })

  // The bridge calls conversations.create when Discord creates a new channel
  test('create a new channel', async () => {
    const result = await client.conversations.create({ name: 'new-project' })
    expect(result.ok).toBe(true)
    expect(result.channel?.name).toBe('new-project')
    expect(result.channel?.id).toBeTruthy()

    // Verify it appears in conversations.list
    const list = await client.conversations.list()
    const names = list.channels?.map((c) => c.name) ?? []
    expect(names).toContain('new-project')
  })

  // Duplicate channel name should error
  test('create channel with duplicate name fails', async () => {
    try {
      await client.conversations.create({ name: 'general' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('name_taken')
    }
  })

  // The bridge calls conversations.rename when a Discord channel is renamed
  test('rename a channel', async () => {
    const channelId = twin.resolveChannelId('old-project')
    const result = await client.conversations.rename({
      channel: channelId,
      name: 'active-project',
    })
    expect(result.ok).toBe(true)
    expect(result.channel?.name).toBe('active-project')

    // Verify via conversations.info
    const info = await client.conversations.info({ channel: channelId })
    expect(info.channel?.name).toBe('active-project')
  })

  // The bridge calls conversations.setTopic when a Discord channel topic changes
  test('set channel topic', async () => {
    const channelId = twin.resolveChannelId('general')
    const result = await client.conversations.setTopic({
      channel: channelId,
      topic: 'Main project discussion',
    })
    expect(result.ok).toBe(true)

    // Verify via conversations.info
    const info = await client.conversations.info({ channel: channelId })
    expect(info.channel?.topic?.value).toBe('Main project discussion')
  })

  // The bridge calls conversations.archive when a Discord channel is deleted
  test('archive a channel', async () => {
    // Create a channel to archive
    const created = await client.conversations.create({ name: 'to-archive' })
    const channelId = created.channel?.id!

    const result = await client.conversations.archive({ channel: channelId })
    expect(result.ok).toBe(true)

    // Archived channels should be excluded from list by default
    const list = await client.conversations.list()
    const ids = list.channels?.map((c) => c.id) ?? []
    expect(ids).not.toContain(channelId)
  })

  // Archiving an already archived channel should error
  test('archive already archived channel fails', async () => {
    const created = await client.conversations.create({ name: 'double-archive' })
    const channelId = created.channel?.id!

    await client.conversations.archive({ channel: channelId })

    try {
      await client.conversations.archive({ channel: channelId })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('already_archived')
    }
  })
})

describe('bot workflows - concurrent operations', () => {
  let twin: SlackDigitalTwin
  let client: WebClient

  beforeAll(async () => {
    twin = new SlackDigitalTwin({
      channels: [{ name: 'general' }],
      users: [
        { name: 'alice' },
        { name: 'bob' },
      ],
    })
    await twin.start()
    client = new WebClient(twin.botToken, {
      slackApiUrl: twin.apiUrl,
      retryConfig: { retries: 0 },
    })
  })

  afterAll(async () => {
    await twin.stop()
  })

  // Multiple users sending messages concurrently in the same channel
  test('concurrent messages from multiple users', async () => {
    const channelId = twin.resolveChannelId('general')
    await twin.prisma.message.deleteMany({ where: { channelId } })

    // Send messages concurrently
    await Promise.all([
      twin.user('alice').sendMessage({ channel: 'general', text: 'alice msg 1' }),
      twin.user('bob').sendMessage({ channel: 'general', text: 'bob msg 1' }),
      client.chat.postMessage({ channel: channelId, text: 'bot msg 1' }),
      twin.user('alice').sendMessage({ channel: 'general', text: 'alice msg 2' }),
      client.chat.postMessage({ channel: channelId, text: 'bot msg 2' }),
    ])

    const messages = await twin.channel('general').getMessages()
    expect(messages.length).toBe(5)

    // All messages should have unique timestamps
    const timestamps = messages.map((m) => m.ts)
    expect(new Set(timestamps).size).toBe(5)
  })

  // Bot posts, edits, and reacts to the same message (common pattern)
  test('post then edit then react on same message', async () => {
    const channelId = twin.resolveChannelId('general')

    const posted = await client.chat.postMessage({
      channel: channelId,
      text: 'Processing...',
    })

    await client.chat.update({
      channel: channelId,
      ts: posted.ts!,
      text: 'Done processing.',
    })

    await client.reactions.add({
      channel: channelId,
      timestamp: posted.ts!,
      name: 'white_check_mark',
    })

    // Verify the final state via history
    const history = await client.conversations.history({ channel: channelId })
    const msg = history.messages?.find((m) => m.ts === posted.ts)
    expect(msg?.text).toBe('Done processing.')
    expect(msg?.edited).toBeTruthy()
    expect(msg?.reactions?.length).toBe(1)
    expect(msg?.reactions?.[0]?.name).toBe('white_check_mark')
  })

  // Multiple threads in the same channel running simultaneously
  test('multiple threads in same channel', async () => {
    const channelId = twin.resolveChannelId('general')

    const thread1 = await client.chat.postMessage({
      channel: channelId,
      text: 'Thread 1 parent',
    })
    const thread2 = await client.chat.postMessage({
      channel: channelId,
      text: 'Thread 2 parent',
    })

    // Post to both threads concurrently
    await Promise.all([
      client.chat.postMessage({
        channel: channelId,
        text: 'T1 reply 1',
        thread_ts: thread1.ts!,
      }),
      client.chat.postMessage({
        channel: channelId,
        text: 'T2 reply 1',
        thread_ts: thread2.ts!,
      }),
      client.chat.postMessage({
        channel: channelId,
        text: 'T1 reply 2',
        thread_ts: thread1.ts!,
      }),
      client.chat.postMessage({
        channel: channelId,
        text: 'T2 reply 2',
        thread_ts: thread2.ts!,
      }),
    ])

    // Verify each thread has correct replies
    const replies1 = await client.conversations.replies({
      channel: channelId,
      ts: thread1.ts!,
    })
    const replies2 = await client.conversations.replies({
      channel: channelId,
      ts: thread2.ts!,
    })

    const t1Texts = replies1.messages?.map((m) => m.text) ?? []
    const t2Texts = replies2.messages?.map((m) => m.text) ?? []

    expect(t1Texts).toContain('Thread 1 parent')
    expect(t1Texts).toContain('T1 reply 1')
    expect(t1Texts).toContain('T1 reply 2')
    expect(t1Texts).not.toContain('T2 reply 1')

    expect(t2Texts).toContain('Thread 2 parent')
    expect(t2Texts).toContain('T2 reply 1')
    expect(t2Texts).toContain('T2 reply 2')
    expect(t2Texts).not.toContain('T1 reply 1')
  })
})

describe('bot workflows - user message then bot reply pattern', () => {
  let twin: SlackDigitalTwin
  let client: WebClient

  beforeAll(async () => {
    twin = new SlackDigitalTwin({
      channels: [{ name: 'general' }],
      users: [{ name: 'alice' }],
    })
    await twin.start()
    client = new WebClient(twin.botToken, {
      slackApiUrl: twin.apiUrl,
      retryConfig: { retries: 0 },
    })
  })

  afterAll(async () => {
    await twin.stop()
  })

  // The full Kimaki flow: user sends message -> bot creates thread -> bot
  // posts multiple messages -> bot adds footer
  test('full session flow: user msg -> thread -> bot replies -> footer', async () => {
    const channelId = twin.resolveChannelId('general')
    await twin.prisma.message.deleteMany({ where: { channelId } })

    // User sends a message in the channel
    const userMsg = await twin.user('alice').sendMessage({
      channel: 'general',
      text: 'fix the login bug',
    })

    // Bot creates a thread by replying to the user message
    await client.chat.postMessage({
      channel: channelId,
      text: '⬥ Looking at the login code...',
      thread_ts: userMsg.ts,
    })

    await client.chat.postMessage({
      channel: channelId,
      text: '┣ read: src/auth/login.ts',
      thread_ts: userMsg.ts,
    })

    await client.chat.postMessage({
      channel: channelId,
      text: '◼︎ edit: src/auth/login.ts',
      thread_ts: userMsg.ts,
    })

    await client.chat.postMessage({
      channel: channelId,
      text: '⬥ Fixed the null check in the login handler.',
      thread_ts: userMsg.ts,
    })

    await client.chat.postMessage({
      channel: channelId,
      text: 'kimakivoice ⋅ main ⋅ 0m 15s ⋅ 8% ⋅ claude-opus-4-6',
      thread_ts: userMsg.ts,
    })

    // Verify the full thread
    const replies = await client.conversations.replies({
      channel: channelId,
      ts: userMsg.ts,
    })

    expect(replies.messages?.length).toBe(6)

    const snapshot = await twin.channel('general').text()
    expect(snapshot).toMatchInlineSnapshot(`
      "alice: fix the login bug
        ↳ test-bot: ⬥ Looking at the login code...
        ↳ test-bot: ┣ read: src/auth/login.ts
        ↳ test-bot: ◼︎ edit: src/auth/login.ts
        ↳ test-bot: ⬥ Fixed the null check in the login handler.
        ↳ test-bot: kimakivoice ⋅ main ⋅ 0m 15s ⋅ 8% ⋅ claude-opus-4-6"
    `)
  })

  // User sends a follow-up message in the thread (like /queue does)
  test('user follow-up in existing thread', async () => {
    const channelId = twin.resolveChannelId('general')
    await twin.prisma.message.deleteMany({ where: { channelId } })

    // User starts a thread
    const userMsg = await twin.user('alice').sendMessage({
      channel: 'general',
      text: 'add tests',
    })

    // Bot replies
    await client.chat.postMessage({
      channel: channelId,
      text: '⬥ Adding tests...',
      thread_ts: userMsg.ts,
    })

    // User queues a follow-up in the same thread
    await twin.user('alice').sendMessage({
      channel: 'general',
      text: 'also add docs',
      threadTs: userMsg.ts,
    })

    // Bot handles the queued message
    await client.chat.postMessage({
      channel: channelId,
      text: '» alice: also add docs',
      thread_ts: userMsg.ts,
    })

    await client.chat.postMessage({
      channel: channelId,
      text: '⬥ Adding documentation...',
      thread_ts: userMsg.ts,
    })

    const snapshot = await twin.channel('general').text()
    expect(snapshot).toMatchInlineSnapshot(`
      "alice: add tests
        ↳ test-bot: ⬥ Adding tests...
        ↳ alice: also add docs
        ↳ test-bot: » alice: also add docs
        ↳ test-bot: ⬥ Adding documentation..."
    `)
  })

  // Bot edits a message multiple times (e.g. streaming text updates)
  test('bot edits same message multiple times (streaming)', async () => {
    const channelId = twin.resolveChannelId('general')

    const parent = await client.chat.postMessage({
      channel: channelId,
      text: 'Streaming thread',
    })

    const streamMsg = await client.chat.postMessage({
      channel: channelId,
      text: '⬥ I',
      thread_ts: parent.ts!,
    })

    // Simulate streaming edits
    await client.chat.update({
      channel: channelId,
      ts: streamMsg.ts!,
      text: '⬥ I will fix',
    })

    await client.chat.update({
      channel: channelId,
      ts: streamMsg.ts!,
      text: '⬥ I will fix the login',
    })

    await client.chat.update({
      channel: channelId,
      ts: streamMsg.ts!,
      text: '⬥ I will fix the login bug now.',
    })

    // Verify final state
    const replies = await client.conversations.replies({
      channel: channelId,
      ts: parent.ts!,
    })

    const editedMsg = replies.messages?.find((m) => m.ts === streamMsg.ts)
    expect(editedMsg?.text).toBe('⬥ I will fix the login bug now.')
    expect(editedMsg?.edited).toBeTruthy()
  })
})
