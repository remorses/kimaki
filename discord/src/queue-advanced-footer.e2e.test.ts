// E2e tests for footer emission in advanced queue scenarios.
// Split from thread-queue-advanced.e2e.test.ts for parallelization.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForFooterMessage,
  waitForBotMessageContaining,
  waitForBotReplyAfterUserMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001001'

const e2eTest = describe

e2eTest('queue advanced: footer emission', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-footer-e2e',
    dirName: 'qa-footer-e2e',
    username: 'queue-advanced-tester',
  })

  test(
    'normal completion emits footer after bot reply',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: footer-check',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: footer-check'
        },
      })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      const footerMessages = await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
      })
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      const foundFooter = footerMessages.some((m) => {
        return m.author.id === ctx.discord.botUserId
          && m.content.startsWith('*')
          && m.content.includes('⋅')
      })
      expect(foundFooter).toBe(true)
    },
    8_000,
  )

  test(
    'footer appears after second message in same session',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: footer-multi-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: footer-multi-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⋅',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: footer-multi-second',
      })

      await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'footer-multi-second',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'footer-multi-second',
        afterAuthorId: TEST_USER_ID,
      })

      const msgs = await th.getMessages()
      const footerCount = msgs.filter((m) => {
        return m.author.id === ctx.discord.botUserId
          && m.content.startsWith('*')
          && m.content.includes('⋅')
      }).length
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-advanced-tester)
        Reply with exactly: footer-multi-second
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      if (footerCount >= 2) {
        expect(footerCount).toBeGreaterThanOrEqual(2)
        return
      }

      const pollDeadline = Date.now() + 4_000
      let found = false
      while (Date.now() < pollDeadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
        const latestMsgs = await th.getMessages()
        const count = latestMsgs.filter((m) => {
          return m.author.id === ctx.discord.botUserId
            && m.content.startsWith('*')
            && m.content.includes('⋅')
        }).length
        if (count >= 2) {
          found = true
          break
        }
      }
      expect(found).toBe(true)
    },
    12_000,
  )

  test(
    'interrupted run has no footer, completed follow-up has footer',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: interrupt-footer-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: interrupt-footer-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⋅',
        timeout: 4_000,
      })

      const beforeInterruptMsgs = await th.getMessages()
      const baselineCount = beforeInterruptMsgs.length

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
        content: 'Reply with exactly: interrupt-footer-followup',
      })

      const messages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        afterUserMessageIncludes: 'interrupt-footer-followup',
        timeout: 12_000,
      })

      const followupUserIdx = messages.findIndex((m, idx) => {
        return idx >= baselineCount
          && m.author.id === TEST_USER_ID
          && m.content.includes('interrupt-footer-followup')
      })
      const okReplyIdx = messages.findIndex((m, idx) => {
        if (idx <= followupUserIdx) {
          return false
        }
        return m.author.id === ctx.discord.botUserId && m.content.includes('ok')
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 12_000,
        afterMessageIncludes: 'interrupt-footer-followup',
        afterAuthorId: TEST_USER_ID,
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
        Reply with exactly: interrupt-footer-followup
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(followupUserIdx).toBeGreaterThanOrEqual(0)
      expect(okReplyIdx).toBeGreaterThan(followupUserIdx)

      const footerBetween = messages.some((m, idx) => {
        if (idx < baselineCount || idx >= okReplyIdx) {
          return false
        }
        return m.author.id === ctx.discord.botUserId
          && m.content.startsWith('*')
          && m.content.includes('⋅')
      })
      expect(footerBetween).toBe(false)
    },
    15_000,
  )

  test(
    'plugin timeout interrupt aborts slow sleep and avoids intermediate footer',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: plugin-timeout-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: plugin-timeout-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

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
        content: 'Reply with exactly: plugin-timeout-after',
      })

      const messages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        afterUserMessageIncludes: 'plugin-timeout-after',
        timeout: 12_000,
      })

      const messagesWithFooter = await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 12_000,
        afterMessageIncludes: 'plugin-timeout-after',
        afterAuthorId: TEST_USER_ID,
      })

      const afterIndex = messagesWithFooter.findIndex((message) => {
        return (
          message.author.id === TEST_USER_ID
          && message.content.includes('plugin-timeout-after')
        )
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
        Reply with exactly: plugin-timeout-after
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(afterIndex).toBeGreaterThanOrEqual(0)

      const okReplyIndex = messagesWithFooter.findIndex((message, index) => {
        if (index <= afterIndex) {
          return false
        }
        return message.author.id === ctx.discord.botUserId && message.content.includes('ok')
      })
      expect(okReplyIndex).toBeGreaterThan(afterIndex)

      const footerBeforeReply = messagesWithFooter.some((message, index) => {
        if (index <= afterIndex || index >= okReplyIndex) {
          return false
        }
        if (message.author.id !== ctx.discord.botUserId) {
          return false
        }
        return message.content.startsWith('*') && message.content.includes('⋅')
      })
      expect(footerBeforeReply).toBe(false)
    },
    15_000,
  )
})
