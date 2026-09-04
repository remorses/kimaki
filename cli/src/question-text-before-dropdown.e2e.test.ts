// E2e: text that precedes a question tool must post before the dropdown.
// OpenCode can emit question.asked before the text part's time.end; Kimaki
// must wait so the plan is not hidden under the question UI.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { getMessageVisibleText, waitForBotMessageContaining } from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001042'

describe('question text before dropdown', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-text-order',
    dirName: 'qa-question-text-order',
    username: 'question-text-tester',
  })

  test(
    'posts plan text before the question dropdown',
    async () => {
      const marker = 'QUESTION_AFTER_TEXT_MARKER'
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

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'What next?',
        timeout: 8_000,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (question-text-tester)
        QUESTION_AFTER_TEXT_MARKER
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        PLAN_TEXT_BEFORE_QUESTION
        **Next step**
        What next?"
      `)

      const messages = await th.getMessages()
      const planIndex = messages.findIndex((message) => {
        return getMessageVisibleText(message).includes('PLAN_TEXT_BEFORE_QUESTION')
      })
      const questionIndex = messages.findIndex((message) => {
        return getMessageVisibleText(message).includes('What next?')
      })
      expect(planIndex).toBeGreaterThanOrEqual(0)
      expect(questionIndex).toBeGreaterThan(planIndex)
    },
    15_000,
  )
})
