// E2e test: an interrupt from another OpenCode client expires the Discord
// dropdown. Since OpenCode 2.0.19 the interrupt cancels the pending question
// form and emits form.cancelled, so a later answer must not resume the run.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining } from './test-utils.js'
import { pendingQuestionContexts } from './commands/ask-question.js'
import { getOpencodeClient } from './opencode.js'
import { getThreadSession } from './database.js'

const TEXT_CHANNEL_ID = '200000000000001032'

describe('question after external abort', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-abort-resume',
    dirName: 'qa-question-abort-resume',
    username: 'question-resume-tester',
  })

  test(
    'external opencode interrupt expires the dropdown',
    async () => {
      const marker = 'QUESTION_ABORT_RESUME_MARKER'
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

      const pendingEntry = [...pendingQuestionContexts.entries()].find(
        ([, context]) => {
          return context.thread.id === thread.id
        },
      )
      if (!pendingEntry) {
        throw new Error('Expected pending question context')
      }
      const contextHash = pendingEntry[0]

      // Interrupt through opencode directly, like a different opencode client.
      const sessionId = await getThreadSession(thread.id)
      if (!sessionId) {
        throw new Error('Expected session id')
      }
      const client = getOpencodeClient(ctx.directories.projectDirectory)
      if (!client) {
        throw new Error('Expected opencode client')
      }
      await client.session.interrupt({
        sessionID: sessionId,
      })

      const expireStart = Date.now()
      while (pendingQuestionContexts.has(contextHash) && Date.now() - expireStart < 4_000) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50)
        })
      }
      expect(pendingQuestionContexts.has(contextHash)).toBe(false)

      const interaction = await th.user(TEST_USER_ID).selectMenu({
        messageId: questionMsg.id,
        customId: `ask_question:${contextHash}:0`,
        values: ['0'],
      })
      await th.waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 8_000,
      })

      expect(await th.text({ showInteractions: true })).toMatchInlineSnapshot(`
        "--- from: user (question-resume-tester)
        QUESTION_ABORT_RESUME_MARKER
        --- from: assistant (TestBot)
        -# *using deterministic-provider/deterministic-v2*
        **Select action**
        How to proceed?
        [user selects dropdown: 0]
        This question has expired. Please ask the AI again."
      `)
    },
    25_000,
  )
})
