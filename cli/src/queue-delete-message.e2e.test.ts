// E2e tests for deleting queued Discord messages.
// Covers the MessageDelete path that removes pending local queue items before drain.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
  waitForThreadState,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001071'

const e2eTest = describe

e2eTest('queue delete message', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'queue-delete-message-e2e',
    dirName: 'queue-delete-message-e2e',
    username: 'queue-delete-tester',
  })

  test(
    'deleting a queued Discord message removes it from queue',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'SLOW_BUSY_MARKER Reply with exactly: delete-queue-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'SLOW_BUSY_MARKER Reply with exactly: delete-queue-setup'
        },
      })
      const th = ctx.discord.thread(thread.id)

      await th.waitForBotReply({ timeout: 4_000 })

      const queuedMsg = await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: deleted-queue. queue',
      })

      await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return state.queueItems.some((item) => {
            return item.sourceMessageId === queuedMsg.id
          })
        },
        timeout: 4_000,
        description: 'queue has item to delete',
      })

      await th.user(TEST_USER_ID).deleteMessage({ messageId: queuedMsg.id })

      await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return !state.queueItems.some((item) => {
            return item.sourceMessageId === queuedMsg.id
          })
        },
        timeout: 4_000,
        description: 'queued item removed after Discord delete',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'removed message from queue',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 8_000,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-delete-tester)
        SLOW_BUSY_MARKER Reply with exactly: delete-queue-setup
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        Queued at position 1. Edit or delete your message to update the queue
        ⬦ **queue-delete-tester** removed message from queue
        ⬥ slow-busy-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      const finalText = await th.text()
      expect(finalText).not.toContain(
        '» **queue-delete-tester:** Reply with exactly: deleted-queue',
      )
    },
    12_000,
  )
})
