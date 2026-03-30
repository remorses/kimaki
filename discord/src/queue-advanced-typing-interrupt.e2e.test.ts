// E2e test for typing indicator lifecycle during interruption flow.
// Split from queue-advanced-typing.e2e.test.ts for parallelization.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001008'

const e2eTest = describe

e2eTest('queue advanced: typing interrupt', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-typing-interrupt-e2e',
    dirName: 'qa-typing-interrupt-e2e',
    username: 'queue-advanced-tester',
  })

  test(
    'interruption flow emits footer for final assistant reply and then stops typing',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: typing-stop-interrupt-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: typing-stop-interrupt-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      th.clearTypingEvents()

      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'starting sleep 100',
        afterUserMessageIncludes: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: typing-stop-interrupt-final',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        afterUserMessageIncludes: 'typing-stop-interrupt-final',
        timeout: 12_000,
      })

      const messages = await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 12_000,
        afterMessageIncludes: 'typing-stop-interrupt-final',
        afterAuthorId: TEST_USER_ID,
      })

      const finalUserIndex = messages.findIndex((message) => {
        return message.author.id === TEST_USER_ID
          && message.content.includes('typing-stop-interrupt-final')
      })
      const finalReplyIndex = messages.findIndex((message, index) => {
        if (index <= finalUserIndex) {
          return false
        }
        return message.author.id === ctx.discord.botUserId && message.content.includes('ok')
      })
      const finalFooterIndex = messages.findIndex((message, index) => {
        if (index <= finalReplyIndex) {
          return false
        }
        return message.author.id === ctx.discord.botUserId
          && message.content.startsWith('*')
          && message.content.includes('⋅')
      })

      const timeline = await th.text({ showTyping: true })
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (queue-advanced-tester)
        Reply with exactly: typing-stop-interrupt-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-advanced-tester)
        PLUGIN_TIMEOUT_SLEEP_MARKER
        --- from: assistant (TestBot)
        ⬥ ok
        ⬥ starting sleep 100
        --- from: user (queue-advanced-tester)
        Reply with exactly: typing-stop-interrupt-final
        [bot typing]
        [bot typing]
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        [bot typing]"
      `)
      expect(finalUserIndex).toBeGreaterThanOrEqual(0)
      expect(finalReplyIndex).toBeGreaterThan(finalUserIndex)
      expect(finalFooterIndex).toBeGreaterThan(finalReplyIndex)
      expect(messages[finalFooterIndex]).toBeDefined()

      const lastFooterPosition = timeline.lastIndexOf('*project ⋅')
      expect(lastFooterPosition).toBeGreaterThanOrEqual(0)
      expect(timeline.slice(lastFooterPosition)).not.toContain('[bot typing]')

    },
    12_000,
  )

})
