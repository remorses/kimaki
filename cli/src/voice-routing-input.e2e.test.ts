// Cover long routed prompts and rejected voice routes without an existing session.
import { afterEach, describe, expect, test } from 'vitest'
import { ChannelType } from 'discord.js'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'
import { getThreadSession } from './database.js'
import { getOpencodeClient } from './opencode.js'
import { store } from './store.js'

const TEXT_CHANNEL_ID = '200000000000001084'

describe('voice routing input boundaries', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'voice-routing-input',
    dirName: 'voice-routing-input',
    username: 'voice-input-tester',
  })

  afterEach(() => {
    store.setState({ test: { deterministicTranscription: null } })
  })

  test('fresh voice route splits display and preserves the full model prompt', async () => {
    const channel = await ctx.botClient.channels.fetch(TEXT_CHANNEL_ID)
    if (channel?.type !== ChannelType.GuildText) throw new Error('Expected text channel')
    const source = await channel.threads.create({ name: 'Long voice source' })
    const prompt = `Long voice request ${'Z'.repeat(2100)} END_OF_REQUEST`
    const caption = 'Keep the existing public API unchanged.'
    store.setState({
      test: {
        deterministicTranscription: {
          transcription: prompt,
          queueMessage: false,
          sessionAction: 'new-session',
        },
      },
    })
    await ctx.discord.thread(source.id).user(TEST_USER_ID).sendVoiceMessage({ content: caption })
    const routingMessages = await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: source.id,
      text: 'Created new session in',
      timeout: 4_000,
    })
    const targetId = routingMessages.find((message) => message.content.includes('Created new session in'))
      ?.content.match(/<#(\d+)>/)?.[1]
    if (!targetId) throw new Error('Expected destination thread link')
    const target = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (thread) => thread.id === targetId,
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: target.id, timeout: 4_000 })
    expect((await ctx.discord.channel(TEXT_CHANNEL_ID).text()).replace(/Z+/g, '[DETAILS]'))
      .toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        **Starting OpenCode session**
        Keep the existing public API unchanged.

        "
      `)
    expect((await ctx.discord.thread(target.id).text()).replace(/Z+/g, '[DETAILS]'))
      .toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        **Starting OpenCode session**
        Keep the existing public API unchanged.


        Long voice request [DETAILS]
        [DETAILS] END_OF_REQUEST
        > *using deterministic-provider/deterministic-v2*
        > ok
      > *project ⋅ main ⋅ <1s ⋅ 0% ⋅ deterministic-v2*"
      `)
    const channelMessages = await ctx.discord.channel(TEXT_CHANNEL_ID).getMessages()
    expect(channelMessages).toHaveLength(1)
    expect(channelMessages.every((message) => message.content.length <= 2000)).toBe(true)
    const threadText = await ctx.discord.thread(target.id).text()
    expect(threadText).toContain(caption)
    expect(threadText.replace(/\s/g, '')).toContain(prompt.replace(/\s/g, ''))
    expect(
      threadText.match(/Z/g),
    ).toHaveLength(2100)
    const sessionId = await getThreadSession(target.id)
    if (!sessionId) throw new Error('Expected target session')
    const client = getOpencodeClient(ctx.directories.projectDirectory)
    if (!client) throw new Error('Expected OpenCode client')
    const messages = await client.session.messages({ sessionID: sessionId })
    const userTexts = messages.data
      ?.filter((message) => message.info.role === 'user')
      .flatMap((message) =>
        message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
      )
    expect(userTexts?.join('\n')).toContain(
      `Voice message transcription from Discord user:\n${prompt}`,
    )
    expect(userTexts?.join('\n')).toContain(caption)
    expect(await getThreadSession(source.id)).toBeFalsy()
  })

  test('unsupported contextual route keeps the transcript and never dispatches raw text', async () => {
    const channel = await ctx.botClient.channels.fetch(TEXT_CHANNEL_ID)
    if (channel?.type !== ChannelType.GuildText) throw new Error('Expected text channel')
    const source = await channel.threads.create({ name: 'Unsupported voice source' })
    const th = ctx.discord.thread(source.id)
    store.setState({
      test: {
        deterministicTranscription: {
          transcription: 'Explain the parser in a contextual side chat',
          queueMessage: false,
          sessionAction: 'btw',
        },
      },
    })
    await th.user(TEST_USER_ID).sendVoiceMessage({ content: 'Do not dispatch this raw text' })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: source.id,
      text: 'Nothing was sent to the agent',
      timeout: 4_000,
    })
    expect(await th.text()).toMatchInlineSnapshot(`
      "--- from: user (voice-input-tester)
      Do not dispatch this raw text
      [attachment: voice-message.ogg]
      --- from: assistant (TestBot)
      🎤 Transcribing voice message...
      📝 **Transcribed message:** Explain the parser in a contextual side chat
      A contextual side chat needs an existing session. Nothing was sent to the agent. Retry from a session, or ask to create a fresh chat with this request."
    `)
    for (let index = 0; index < 10; index++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(await getThreadSession(source.id)).toBeFalsy()
    }
  })

  test('routing-only audio does not start a junk turn', async () => {
    const channel = await ctx.botClient.channels.fetch(TEXT_CHANNEL_ID)
    if (channel?.type !== ChannelType.GuildText) throw new Error('Expected text channel')
    const source = await channel.threads.create({ name: 'Empty voice source' })
    const th = ctx.discord.thread(source.id)
    store.setState({
      test: {
        deterministicTranscription: {
          transcription: '',
          queueMessage: false,
          sessionAction: 'new-session',
        },
      },
    })
    await th.user(TEST_USER_ID).sendVoiceMessage({ content: 'Create a new chat' })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: source.id,
      text: 'No request was transcribed',
      timeout: 4_000,
    })
    expect(await th.text()).toMatchInlineSnapshot(`
      "--- from: user (voice-input-tester)
      Create a new chat
      [attachment: voice-message.ogg]
      --- from: assistant (TestBot)
      🎤 Transcribing voice message...
      No request was transcribed. Record another voice message with the task to send."
    `)
    for (let index = 0; index < 10; index++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(await getThreadSession(source.id)).toBeFalsy()
    }
  })

  test('/new-session confirms the destination and sends the prompt', async () => {
    const channel = await ctx.botClient.channels.fetch(TEXT_CHANNEL_ID)
    if (channel?.type !== ChannelType.GuildText) throw new Error('Expected text channel')
    const source = await channel.threads.create({ name: 'Slash source' })
    const th = ctx.discord.thread(source.id)
    const interaction = await th.user(TEST_USER_ID).runSlashCommand({
      name: 'new-session',
      options: [{ name: 'prompt', type: 3, value: 'Slash fresh request' }],
    })
    await th.waitForInteractionAck({ interactionId: interaction.id, timeout: 4_000 })
    const target = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (thread) => thread.name === 'Slash fresh request',
    })
    await waitForFooterMessage({ discord: ctx.discord, threadId: target.id, timeout: 4_000 })
    expect(
      (await th.text({ showInteractions: true })).replaceAll(target.id, 'TARGET_THREAD'),
    ).toMatchInlineSnapshot(`
      "[user interaction]
      --- from: assistant (TestBot)
      Created new session in <#TARGET_THREAD>"
    `)
    expect(await ctx.discord.thread(target.id).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      **Starting OpenCode session**
      Slash fresh request
      > *using deterministic-provider/deterministic-v2*
      > ok
      > *project ⋅ main ⋅ <1s ⋅ 0% ⋅ deterministic-v2*"
    `)
  })
})
