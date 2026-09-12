// Native V2 events preserve live tool output, deduplication, and Discord title prefixes.
import { expect, test } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { getThreadSession } from './database.js'
import { getOpencodeClient } from './opencode.js'
import { isFooterMessage, waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'

const channelId = '200000000000001068'
const ctx = setupQueueAdvancedSuite({
  channelId,
  channelName: 'v2-live-rendering',
  dirName: 'v2-live-rendering',
  username: 'render-tester',
  extraMatchers: [
    {
      id: 'live-render-tool',
      priority: 300,
      when: { lastMessageRole: 'user', latestUserTextIncludes: 'LIVE_RENDER_MARKER' },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'intro' },
          { type: 'text-delta', id: 'intro', delta: 'Checking the project' },
          { type: 'text-end', id: 'intro' },
          {
            type: 'tool-call',
            toolCallId: 'live-shell',
            toolName: 'shell',
            input: JSON.stringify({ command: 'echo live-render', description: 'Check live rendering', hasSideEffect: true }),
          },
          { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 20_000, outputTokens: 1, totalTokens: 20_001 } },
        ],
      },
    },
    {
      id: 'live-render-finish',
      priority: 300,
      when: { lastMessageRole: 'tool', latestUserTextIncludes: 'LIVE_RENDER_MARKER' },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'finish' },
          { type: 'text-delta', id: 'finish', delta: 'Live rendering complete' },
          { type: 'text-end', id: 'finish' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ],
        partDelaysMs: [0, 0, 1200, 0, 0],
      },
    },
  ],
})

test('shows tools before completion, sends one tool line, and renames from native events', async () => {
  await ctx.discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'LIVE_RENDER_MARKER' })
  const thread = await ctx.discord.channel(channelId).waitForThread({ timeout: 4_000 })
  const th = ctx.discord.thread(thread.id)
  const liveMessages = await waitForBotMessageContaining({
    discord: ctx.discord,
    threadId: thread.id,
    text: '▏shell',
    timeout: 4_000,
  })
  const liveText = await th.text()
  expect(liveText).toMatchInlineSnapshot(`
    "--- from: user (render-tester)
    LIVE_RENDER_MARKER
    --- from: assistant (TestBot)
    > *using deterministic-provider/deterministic-v2*
    Checking the project

    ▏shell _echo live-render_"
  `)
  expect(liveMessages.some((message) => isFooterMessage({ message, botUserId: ctx.discord.botUserId }))).toBe(false)
  expect(liveText).not.toContain('Live rendering complete')

  await waitForFooterMessage({ discord: ctx.discord, threadId: thread.id, timeout: 4_000 })
  const finishedText = await th.text()
  expect(finishedText).toMatchInlineSnapshot(`
    "--- from: user (render-tester)
    LIVE_RENDER_MARKER
    --- from: assistant (TestBot)
    > *using deterministic-provider/deterministic-v2*
    Checking the project

    ▏shell _echo live-render_
    ⻟context usage 10%

    Live rendering complete
    > *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000991>"
  `)
  expect(finishedText.split('\n').filter((line) => line.startsWith('▏shell'))).toHaveLength(1)
  // OpenCode's configured model default has a 200,000-token context window.
  expect(finishedText).toContain('⻟context usage 10%')
  expect(finishedText.indexOf('Checking the project')).toBeLessThan(finishedText.indexOf('▏shell'))
  expect(finishedText.indexOf('▏shell')).toBeLessThan(finishedText.indexOf('Live rendering complete'))

  const channel = await ctx.botClient.channels.fetch(thread.id)
  if (!channel?.isThread()) throw new Error('Missing Discord thread')
  await channel.setName('⻟Original title')
  const sessionID = await getThreadSession(thread.id)
  const client = getOpencodeClient(ctx.directories.projectDirectory)
  if (!sessionID || !client) throw new Error('Missing OpenCode session')
  await client.session.rename({ sessionID, title: 'Native renamed title' })
  await expect.poll(async () => {
    const updated = await ctx.botClient.channels.fetch(thread.id, { force: true })
    return updated?.isThread() ? updated.name : undefined
  }, { timeout: 4_000, interval: 100 }).toBe('⻟Native renamed title')
}, 15_000)
