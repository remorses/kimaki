// E2e tests for typing indicator lifecycle in advanced queue scenarios.
// Split from thread-queue-advanced.e2e.test.ts for parallelization.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
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

      const messages = await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'ok',
        afterAuthorId: ctx.discord.botUserId,
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

      const timeline = await th.text({ showTyping: true })
      expect(timeline).toContain('Reply with exactly: typing-stop-normal')
      expect(timeline).toContain('⬥ ok')
      expect(timeline).toContain('*project ⋅ main ⋅')
      const typingCount = (timeline.match(/\[bot typing\]/g) || []).length
      expect(typingCount).toBeGreaterThanOrEqual(1)
      expect(replyIndex).toBeGreaterThanOrEqual(0)
      expect(footerIndex).toBeGreaterThan(replyIndex)
      expect(messages[footerIndex]).toBeDefined()

      const lastFooterPosition = timeline.lastIndexOf('*project ⋅')
      expect(lastFooterPosition).toBeGreaterThanOrEqual(0)
      expect(timeline.slice(lastFooterPosition)).not.toContain('[bot typing]')

    },
    8_000,
  )

  test(
    'thread follow-up reply re-pulses typing after a visible assistant message while session stays busy',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: typing-thread-reply-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: typing-thread-reply-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'ok',
        afterAuthorId: ctx.discord.botUserId,
      })

      th.clearTypingEvents()

      await th.user(TEST_USER_ID).sendMessage({
        content: 'TYPING_REPULSE_MARKER',
      })

      const messagesAfterFirstReply = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'repulse-first',
        afterUserMessageIncludes: 'TYPING_REPULSE_MARKER',
        timeout: 4_000,
      })

      const markerUserIndex = messagesAfterFirstReply.findIndex((message) => {
        return message.author.id === TEST_USER_ID
          && message.content.includes('TYPING_REPULSE_MARKER')
      })
      const firstReply = messagesAfterFirstReply.find((message, index) => {
        if (index <= markerUserIndex) {
          return false
        }
        return message.author.id === ctx.discord.botUserId
          && message.content.includes('repulse-first')
      })
      if (!firstReply) {
        throw new Error('Expected first bot reply after TYPING_REPULSE_MARKER')
      }

      const typingAfterVisibleReply = await th.waitForTypingEvent({
        timeout: 700,
        afterTimestamp: new Date(firstReply.timestamp).getTime(),
      }).then(
        () => {
          return true
        },
        () => {
          return false
        },
      )

      const messages = await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 6_000,
        afterMessageIncludes: 'TYPING_REPULSE_MARKER',
        afterAuthorId: TEST_USER_ID,
      })

      const timeline = await th.text({ showTyping: true })
      expect(timeline).toContain('TYPING_REPULSE_MARKER')
      expect(timeline).toContain('⬥ repulse-first')
      const typingCount = (timeline.match(/\[bot typing\]/g) || []).length
      expect(typingCount).toBeGreaterThanOrEqual(2)

      const followupUserIndex = messages.findIndex((message) => {
        return message.author.id === TEST_USER_ID
          && message.content.includes('TYPING_REPULSE_MARKER')
      })
      const followupReplyIndex = messages.findIndex((message, index) => {
        if (index <= followupUserIndex) {
          return false
        }
        return message.author.id === ctx.discord.botUserId
          && message.content.includes('repulse-first')
      })

      expect(followupUserIndex).toBeGreaterThanOrEqual(0)
      expect(followupReplyIndex).toBeGreaterThan(followupUserIndex)
      expect(typingAfterVisibleReply).toBe(true)
    },
    10_000,
  )

})
