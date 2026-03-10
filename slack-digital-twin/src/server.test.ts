// Tests for the Slack digital twin server using the official @slack/web-api SDK.
// This validates that our mock server is compliant with what WebClient expects.
// Each test creates a fresh SlackDigitalTwin, starts it, uses the real WebClient
// to call API methods, and asserts the responses match Slack's expected shapes.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { WebClient } from '@slack/web-api'
import { SlackDigitalTwin } from './index.ts'

describe('slack digital twin with @slack/web-api', () => {
  let twin: SlackDigitalTwin
  let client: WebClient

  beforeAll(async () => {
    twin = new SlackDigitalTwin({
      workspaceName: 'test-workspace',
      channels: [
        { name: 'general' },
        { name: 'random' },
        { name: 'private-chan', isPrivate: true },
      ],
      users: [
        { name: 'alice', realName: 'Alice Smith' },
        { name: 'bob', realName: 'Bob Jones' },
      ],
    })
    await twin.start()

    client = new WebClient(twin.botToken, {
      slackApiUrl: twin.apiUrl,
      // Disable retries for tests
      retryConfig: { retries: 0 },
    })
  })

  afterAll(async () => {
    await twin.stop()
  })

  // --- auth.test ---

  test('auth.test returns bot identity', async () => {
    const result = await client.auth.test()
    expect(result.ok).toBe(true)
    expect(result.user_id).toBe(twin.botUserId)
    expect(result.team_id).toBe(twin.workspaceId)
  })

  // --- conversations.list ---

  test('conversations.list returns seeded channels', async () => {
    const result = await client.conversations.list()
    expect(result.ok).toBe(true)
    const names = result.channels?.map((c) => c.name) ?? []
    expect(names).toContain('general')
    expect(names).toContain('random')
  })

  test('conversations.list excludes private channels by default', async () => {
    const result = await client.conversations.list({ types: 'public_channel' })
    expect(result.ok).toBe(true)
    const names = result.channels?.map((c) => c.name) ?? []
    expect(names).not.toContain('private-chan')
  })

  test('conversations.list includes private channels when requested', async () => {
    const result = await client.conversations.list({
      types: 'public_channel,private_channel',
    })
    expect(result.ok).toBe(true)
    const names = result.channels?.map((c) => c.name) ?? []
    expect(names).toContain('private-chan')
  })

  // --- conversations.info ---

  test('conversations.info returns channel details', async () => {
    const channelId = twin.resolveChannelId('general')
    const result = await client.conversations.info({ channel: channelId })
    expect(result.ok).toBe(true)
    expect(result.channel?.name).toBe('general')
    expect(result.channel?.is_archived).toBe(false)
  })

  test('conversations.info returns error for unknown channel', async () => {
    try {
      await client.conversations.info({ channel: 'C_NONEXISTENT' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('channel_not_found')
    }
  })

  // --- chat.postMessage ---

  test('chat.postMessage sends a message and returns ts', async () => {
    const channelId = twin.resolveChannelId('general')
    const result = await client.chat.postMessage({
      channel: channelId,
      text: 'Hello from bot!',
    })
    expect(result.ok).toBe(true)
    expect(result.ts).toBeTruthy()
    expect(result.channel).toBe(channelId)
    expect(result.message?.text).toBe('Hello from bot!')
  })

  test('chat.postMessage to thread', async () => {
    const channelId = twin.resolveChannelId('general')

    // Post parent message
    const parent = await client.chat.postMessage({
      channel: channelId,
      text: 'Parent message',
    })

    // Post reply in thread
    const reply = await client.chat.postMessage({
      channel: channelId,
      text: 'Thread reply',
      thread_ts: parent.ts!,
    })

    expect(reply.ok).toBe(true)
    expect(reply.message?.thread_ts).toBe(parent.ts)
  })

  test('chat.postMessage returns error for unknown channel', async () => {
    try {
      await client.chat.postMessage({
        channel: 'C_NONEXISTENT',
        text: 'Should fail',
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('channel_not_found')
    }
  })

  // --- chat.update ---

  test('chat.update edits a message', async () => {
    const channelId = twin.resolveChannelId('general')
    const posted = await client.chat.postMessage({
      channel: channelId,
      text: 'Original text',
    })

    const updated = await client.chat.update({
      channel: channelId,
      ts: posted.ts!,
      text: 'Updated text',
    })

    expect(updated.ok).toBe(true)
    expect(updated.text).toBe('Updated text')
  })

  // --- chat.delete ---

  test('chat.delete soft-deletes a message', async () => {
    const channelId = twin.resolveChannelId('random')
    const posted = await client.chat.postMessage({
      channel: channelId,
      text: 'Will be deleted',
    })

    const deleted = await client.chat.delete({
      channel: channelId,
      ts: posted.ts!,
    })
    expect(deleted.ok).toBe(true)

    // Message should not appear in history
    const history = await client.conversations.history({ channel: channelId })
    const found = history.messages?.find((m) => m.ts === posted.ts)
    expect(found).toBeUndefined()
  })

  // --- conversations.history ---

  test('conversations.history returns messages in desc order', async () => {
    const channelId = twin.resolveChannelId('random')

    await client.chat.postMessage({ channel: channelId, text: 'msg 1' })
    await client.chat.postMessage({ channel: channelId, text: 'msg 2' })
    await client.chat.postMessage({ channel: channelId, text: 'msg 3' })

    const history = await client.conversations.history({ channel: channelId })
    expect(history.ok).toBe(true)
    expect(history.messages?.length).toBeGreaterThanOrEqual(3)

    // Slack returns messages in reverse chronological order (newest first)
    const texts = history.messages?.map((m) => m.text) ?? []
    const idx1 = texts.indexOf('msg 1')
    const idx3 = texts.indexOf('msg 3')
    expect(idx3).toBeLessThan(idx1)
  })

  // --- conversations.replies ---

  test('conversations.replies returns thread messages', async () => {
    const channelId = twin.resolveChannelId('general')

    const parent = await client.chat.postMessage({
      channel: channelId,
      text: 'Thread parent',
    })

    await client.chat.postMessage({
      channel: channelId,
      text: 'Reply 1',
      thread_ts: parent.ts!,
    })
    await client.chat.postMessage({
      channel: channelId,
      text: 'Reply 2',
      thread_ts: parent.ts!,
    })

    const replies = await client.conversations.replies({
      channel: channelId,
      ts: parent.ts!,
    })

    expect(replies.ok).toBe(true)
    // Should include parent + 2 replies
    expect(replies.messages?.length).toBe(3)
    expect(replies.messages?.[0]?.text).toBe('Thread parent')
    expect(replies.messages?.[1]?.text).toBe('Reply 1')
    expect(replies.messages?.[2]?.text).toBe('Reply 2')
  })

  // --- reactions.add / reactions.remove ---

  test('reactions.add and reactions.remove', async () => {
    const channelId = twin.resolveChannelId('general')
    const posted = await client.chat.postMessage({
      channel: channelId,
      text: 'React to this',
    })

    const addResult = await client.reactions.add({
      channel: channelId,
      timestamp: posted.ts!,
      name: 'thumbsup',
    })
    expect(addResult.ok).toBe(true)

    // Adding same reaction again should error
    try {
      await client.reactions.add({
        channel: channelId,
        timestamp: posted.ts!,
        name: 'thumbsup',
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('already_reacted')
    }

    const removeResult = await client.reactions.remove({
      channel: channelId,
      timestamp: posted.ts!,
      name: 'thumbsup',
    })
    expect(removeResult.ok).toBe(true)
  })

  // --- users.info ---

  test('users.info returns user details', async () => {
    const aliceId = twin.resolveUserId('alice')
    const result = await client.users.info({ user: aliceId })
    expect(result.ok).toBe(true)
    expect(result.user?.name).toBe('alice')
    expect(result.user?.real_name).toBe('Alice Smith')
    expect(result.user?.is_bot).toBe(false)
  })

  test('users.info for bot user', async () => {
    const result = await client.users.info({ user: twin.botUserId })
    expect(result.ok).toBe(true)
    expect(result.user?.is_bot).toBe(true)
  })

  test('users.info returns error for unknown user', async () => {
    try {
      await client.users.info({ user: 'U_NONEXISTENT' })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).toContain('user_not_found')
    }
  })

  // --- users.list ---

  test('users.list returns all workspace users', async () => {
    const result = await client.users.list({})
    expect(result.ok).toBe(true)
    const names = result.members?.map((m) => m.name) ?? []
    expect(names).toContain('alice')
    expect(names).toContain('bob')
    expect(names).toContain('test-bot')
  })

  // --- ChannelScope helpers ---

  test('channel.text() returns readable snapshot', async () => {
    // Use a fresh channel to avoid pollution from other tests
    const channelId = twin.resolveChannelId('random')

    // Clear messages by directly using prisma
    await twin.prisma.message.deleteMany({ where: { channelId } })

    // Simulate user message + bot reply
    twin.user('alice').sendMessage({ channel: 'random', text: 'hello bot' })

    await client.chat.postMessage({
      channel: channelId,
      text: 'Hello alice!',
    })

    const snapshot = await twin.channel('random').text()
    expect(snapshot).toMatchInlineSnapshot(`
      "alice: hello bot
      test-bot: Hello alice!"
    `)
  })

  test('channel.getMessages() returns SlackMessage array', async () => {
    const channelId = twin.resolveChannelId('random')
    await twin.prisma.message.deleteMany({ where: { channelId } })

    await client.chat.postMessage({
      channel: channelId,
      text: 'Test message',
    })

    const messages = await twin.channel('random').getMessages()
    expect(messages.length).toBe(1)
    expect(messages[0]?.text).toBe('Test message')
    expect(messages[0]?.type).toBe('message')
    expect(messages[0]?.bot_id).toBeTruthy()
  })
})

describe('slack digital twin - user actor', () => {
  let twin: SlackDigitalTwin

  beforeAll(async () => {
    twin = new SlackDigitalTwin({
      channels: [{ name: 'general' }],
      users: [{ name: 'alice' }],
    })
    await twin.start()
  })

  afterAll(async () => {
    await twin.stop()
  })

  test('user.sendMessage creates a message', async () => {
    const msg = await twin.user('alice').sendMessage({
      channel: 'general',
      text: 'hi from alice',
    })
    expect(msg.user).toBe(twin.resolveUserId('alice'))
    expect(msg.text).toBe('hi from alice')
    expect(msg.ts).toBeTruthy()

    const messages = await twin.channel('general').getMessages()
    expect(messages.some((m) => m.text === 'hi from alice')).toBe(true)
  })

  test('user.addReaction adds a reaction', async () => {
    const msg = await twin.user('alice').sendMessage({
      channel: 'general',
      text: 'react to me',
    })

    await twin.user('alice').addReaction({
      channel: 'general',
      messageTs: msg.ts,
      name: 'heart',
    })

    const messages = await twin.channel('general').getMessages()
    const reactedMsg = messages.find((m) => m.ts === msg.ts)
    expect(reactedMsg?.reactions).toEqual([
      { name: 'heart', users: [twin.resolveUserId('alice')], count: 1 },
    ])
  })

  test('user.sendMessage in thread', async () => {
    const parent = await twin.user('alice').sendMessage({
      channel: 'general',
      text: 'parent msg',
    })

    await twin.user('alice').sendMessage({
      channel: 'general',
      text: 'thread reply',
      threadTs: parent.ts,
    })

    const snapshot = await twin.channel('general').text()
    expect(snapshot).toContain('parent msg')
    expect(snapshot).toContain('  ↳ alice: thread reply')
  })
})
