// E2e test: queued message must drain after the user answers a pending question
// via the Discord dropdown select menu. Reproduces a bug where answering via
// select (not text) leaves queued messages stuck because the session continues
// processing after the answer and may enter another blocking state.

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

const TEXT_CHANNEL_ID = '200000000000001030'

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

describe('queue drain after question select answer', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-select-drain',
    dirName: 'qa-question-select-drain',
    username: 'question-select-tester',
  })

  test(
    'queued message drains after answering question via dropdown select',
    async () => {
      // 1. Send a message that triggers the question tool
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'QUESTION_SELECT_QUEUE_MARKER',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'QUESTION_SELECT_QUEUE_MARKER'
        },
      })

      const th = ctx.discord.thread(thread.id)

      // 2. Wait for the question dropdown to appear
      const pending = await waitForPendingQuestion({
        threadId: thread.id,
        timeoutMs: 4_000,
      })
      expect(pending.contextHash).toBeTruthy()

      // Verify dropdown message appeared
      const questionMessages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'How to proceed?',
        timeout: 4_000,
      })
      const questionMsg = questionMessages.find((m) => {
        return m.content.includes('How to proceed?')
      })!
      expect(questionMsg).toBeTruthy()

      // 3. Queue a message while question is pending
      const { id: queueInteractionId } = await th.user(TEST_USER_ID)
        .runSlashCommand({
          name: 'queue',
          options: [{ name: 'message', type: 3, value: 'Reply with exactly: post-question-drain' }],
        })

      const queueAck = await th.waitForInteractionAck({
        interactionId: queueInteractionId,
        timeout: 4_000,
      })
      if (!queueAck.messageId) {
        throw new Error('Expected /queue response message id')
      }

      // 4. Answer the question via dropdown select (pick first option "Alpha")
      const interaction = await th.user(TEST_USER_ID).selectMenu({
        messageId: questionMsg.id,
        customId: `ask_question:${pending.contextHash}:0`,
        values: ['0'],
      })

      await th.waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 4_000,
      })

      // 5. Queued message should be handed off to OpenCode's own prompt queue
      //    after the question reply, so the dispatch indicator appears without
      //    waiting for a later natural idle.
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: '» **question-select-tester:** Reply with exactly: post-question-drain',
        timeout: 4_000,
      })

      // 6. Wait for footer from the drained queued message
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: '» **question-select-tester:**',
        afterAuthorId: ctx.discord.botUserId,
      })

      const timeline = await th.text({ showInteractions: true })
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (question-select-tester)
        QUESTION_SELECT_QUEUE_MARKER
        --- from: assistant (TestBot)
        **Select action**
        How to proceed?
        ✓ _Alpha_
        [user interaction]
        Queued message (position 1)
        [user selects dropdown: 0]
        » **question-select-tester:** Reply with exactly: post-question-drain
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        ⬥ ok"
      `)
    },
    20_000,
  )
})
