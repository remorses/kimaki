// E2e test for question tool: user text message during pending question should
// be consumed as the answer and NOT also sent as a duplicate promptAsync.
// Reproduces the bug from commit a4dfb01 where the same message was sent twice.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'
import { pendingQuestionContexts } from './commands/ask-question.js'

const TEXT_CHANNEL_ID = '200000000000001007'

async function waitForPendingQuestion({
  threadId,
  timeoutMs,
}: {
  threadId: string
  timeoutMs: number
}): Promise<{ contextHash: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const entry = [...pendingQuestionContexts.entries()].find(([, context]) => {
      return context.thread.id === threadId
    })
    if (entry) {
      return { contextHash: entry[0] }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error('Timed out waiting for pending question context')
}

async function waitForNoPendingQuestion({
  threadId,
  timeoutMs,
}: {
  threadId: string
  timeoutMs: number
}): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const stillPending = [...pendingQuestionContexts.values()].some((context) => {
      return context.thread.id === threadId
    })
    if (!stillPending) {
      return
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error('Timed out waiting for question context cleanup')
}

describe('queue advanced: question tool text answer', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-e2e',
    dirName: 'qa-question-e2e',
    username: 'queue-question-tester',
  })

  test(
    'user text message answers pending question without sending duplicate prompt',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'QUESTION_TEXT_ANSWER_MARKER',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'QUESTION_TEXT_ANSWER_MARKER'
        },
      })

      const th = ctx.discord.thread(thread.id)

      // Wait for the question dropdown to appear
      const pending = await waitForPendingQuestion({
        threadId: thread.id,
        timeoutMs: 4_000,
      })
      expect(pending.contextHash).toBeTruthy()

      // Verify dropdown message appeared
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'Which option do you prefer?',
        timeout: 4_000,
      })

      // User sends a text message while question is pending.
      // This should:
      // 1. Answer the question via cancelPendingQuestion (consumed as answer)
      // 2. NOT also send as a new promptAsync (the fix)
      // 3. Clean up the pending question context
      await th.user(TEST_USER_ID).sendMessage({
        content: 'my text answer',
      })

      // Pending question context should be cleaned up after answer
      await waitForNoPendingQuestion({
        threadId: thread.id,
        timeoutMs: 4_000,
      })

      // Verify the user message shows in thread but no duplicate bot error/reply
      // from a stale promptAsync. The key assertion: no MessageAbortedError spam.
      // Wait briefly and check thread state.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 500)
      })

      const timeline = await th.text({ showInteractions: true })
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (queue-question-tester)
        QUESTION_TEXT_ANSWER_MARKER
        --- from: assistant (TestBot)
        **Pick one**
        Which option do you prefer?
        --- from: user (queue-question-tester)
        my text answer
        --- from: assistant (TestBot)
        **Pick one**
        Which option do you prefer?"
      `)

      // The user's "my text answer" message must appear in the thread
      expect(timeline).toContain('my text answer')
    },
    20_000,
  )
})
