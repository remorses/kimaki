// E2e tests for typing indicator lifecycle in advanced queue scenarios.
// Split from thread-queue-advanced.e2e.test.ts for parallelization.
// These tests are inherently slow (~10s each) due to 8.5s typing idle waits.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001002'

const e2eTest = describe

e2eTest('queue advanced: typing lifecycle', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-typing-e2e',
    dirName: 'qa-typing-e2e',
    username: 'queue-advanced-tester',
  })

  test(
    'normal reply stops typing after footer',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: typing-stop-normal',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: typing-stop-normal'
        },
      })

      const th = ctx.discord.thread(thread.id)

      await th.waitForTypingEvent({ timeout: 1_000 }).catch(() => {
        return undefined
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        timeout: 4_000,
      })

      const messages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      const replyIndex = messages.findIndex((message) => {
        return message.author.id === ctx.discord.botUserId && message.content.includes('ok')
      })
      const footerIndex = messages.findIndex((message, index) => {
        if (index <= replyIndex) {
          return false
        }
        return message.author.id === ctx.discord.botUserId
          && message.content.startsWith('*')
          && message.content.includes('⋅')
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(replyIndex).toBeGreaterThanOrEqual(0)
      expect(footerIndex).toBeGreaterThan(replyIndex)

      const footerSeenAt = Date.now()
      await th.waitForTypingToStop({
        afterTimestamp: footerSeenAt,
        idleMs: 8_500,
        timeout: 12_000,
      })
    },
    20_000,
  )

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

      await th.waitForTypingEvent({ timeout: 4_000 })

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

      const messages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        afterUserMessageIncludes: 'typing-stop-interrupt-final',
        timeout: 12_000,
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

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-advanced-tester)
        PLUGIN_TIMEOUT_SLEEP_MARKER
        --- from: assistant (TestBot)
        ⬥ starting sleep 100
        --- from: user (queue-advanced-tester)
        Reply with exactly: typing-stop-interrupt-final
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(finalUserIndex).toBeGreaterThanOrEqual(0)
      expect(finalReplyIndex).toBeGreaterThan(finalUserIndex)
      expect(finalFooterIndex).toBeGreaterThan(finalReplyIndex)

      const footerSeenAt = Date.now()
      await th.waitForTypingToStop({
        afterTimestamp: footerSeenAt,
        idleMs: 8_500,
        timeout: 12_000,
      })
    },
    25_000,
  )
})
