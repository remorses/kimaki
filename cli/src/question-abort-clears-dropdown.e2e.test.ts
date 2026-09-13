// E2e test: aborting a run must kill the pending question dropdown.
// Questions have no TTL, so abort is the only thing that clears them while the
// thread stays alive. Without this, a stale dropdown keeps accepting clicks and
// answers a question whose run is already dead.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining } from './test-utils.js'
import { pendingQuestionContexts } from './commands/ask-question.js'
import { getRuntime } from './session-handler/thread-session-runtime.js'

const TEXT_CHANNEL_ID = '200000000000001031'

describe('abort clears pending question dropdown', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-abort',
    dirName: 'qa-question-abort',
    username: 'question-abort-tester',
  })

  test(
    'dropdown stops accepting answers after abort',
    async () => {
      const marker = 'QUESTION_SELECT_QUEUE_MARKER abort-test'

      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: marker,
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 8_000,
        predicate: (t) => {
          return t.name === marker
        },
      })

      const th = ctx.discord.thread(thread.id)

      const questionMessages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'How to proceed?',
        timeout: 12_000,
      })
      const questionMsg = questionMessages.find((message) => {
        return message.content.includes('How to proceed?')
      })
      if (!questionMsg) {
        throw new Error('Expected question message')
      }

      const pendingEntry = [...pendingQuestionContexts.entries()].find(([, context]) => {
        return context.thread.id === thread.id
      })
      if (!pendingEntry) {
        throw new Error('Expected pending question context')
      }
      const runtime = getRuntime(thread.id)
      if (!runtime) {
        throw new Error('Expected runtime for question abort test')
      }
      runtime.abortActiveRun('test-question-abort')

      for (let i = 0; i < 40; i++) {
        const messages = await th.getMessages()
        const cancelledQuestion = messages.find((message) => {
          return message.id === questionMsg.id && message.components?.length === 0
        })
        if (cancelledQuestion) break
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100)
        })
      }

      const messages = await th.getMessages()
      const cancelledQuestion = messages.find((message) => message.id === questionMsg.id)
      const timeline = await th.text()
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (question-abort-tester)
        QUESTION_SELECT_QUEUE_MARKER abort-test
        --- from: assistant (TestBot)
        > *using deterministic-provider/deterministic-v2*
        **Select action**
        How to proceed?"
      `)
      expect(cancelledQuestion?.components ?? []).toHaveLength(0)
      expect(pendingQuestionContexts.size).toBe(0)
    },
    20_000,
  )
})
