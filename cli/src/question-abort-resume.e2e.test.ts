// E2e test: a question answered after its run was aborted elsewhere must not be
// lost. The original run is dead, so question.reply is a no-op; kimaki resumes
// the session by sending the answers back as a fresh prompt.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining } from './test-utils.js'
import { pendingQuestionContexts } from './commands/ask-question.js'
import { getOpencodeClient } from './opencode.js'
import { getThreadSession } from './database.js'
import { getRuntime } from './session-handler/thread-session-runtime.js'

const TEXT_CHANNEL_ID = '200000000000001032'

describe('question answered after external abort resumes session', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-abort-resume',
    dirName: 'qa-question-abort-resume',
    username: 'question-resume-tester',
  })

  test(
    'answering a dropdown after opencode abort resumes with the answers',
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

      // Abort directly through opencode (simulating a different opencode client),
      // so kimaki's dropdown context stays live but the question is gone in
      // opencode. kimaki's own abort would clear the dropdown instead.
      const sessionId = await getThreadSession(thread.id)
      if (!sessionId) {
        throw new Error('Expected session id')
      }
      const client = getOpencodeClient(ctx.directories.projectDirectory)
      if (!client) {
        throw new Error('Expected opencode client')
      }
      await client.session.abort({
        sessionID: sessionId,
        directory: ctx.directories.projectDirectory,
      })

      // Wait until kimaki sees the session go idle (mirrors a user answering
      // after they aborted in another opencode).
      const runtime = getRuntime(thread.id)
      if (!runtime) {
        throw new Error('Expected runtime')
      }
      const idleStart = Date.now()
      while (runtime.isBusy() && Date.now() - idleStart < 8_000) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 50)
        })
      }
      expect(runtime.isBusy()).toBe(false)

      // Answer the dropdown. reply fails (question no longer pending), so kimaki
      // resumes the session with the answers as a new prompt.
      const interaction = await th.user(TEST_USER_ID).selectMenu({
        messageId: questionMsg.id,
        customId: `ask_question:${contextHash}:0`,
        values: ['0'],
      })
      await th.waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 8_000,
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'resumed-after-abort',
        timeout: 12_000,
      })

      const timeline = await th.text({ showInteractions: true })
      expect(timeline).toContain('How to proceed?')
      expect(timeline).toContain('» **question-resume-tester:** Alpha')
      expect(timeline).toContain('resumed-after-abort')
    },
    25_000,
  )
})
