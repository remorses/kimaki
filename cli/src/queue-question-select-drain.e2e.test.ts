// E2e test for ordered queue drain after a pending question is answered via select.

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

async function expectNoBotMessageContaining({
  discord,
  threadId,
  text,
  timeout,
}: {
  discord: Parameters<typeof waitForBotMessageContaining>[0]['discord']
  threadId: string
  text: string
  timeout: number
}): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const messages = await discord.thread(threadId).getMessages()
    const match = messages.find((message) => {
      return message.author.id === discord.botUserId && message.content.includes(text)
    })
    if (match) {
      throw new Error(
        `Unexpected bot message containing ${JSON.stringify(text)} while it should still be queued`,
      )
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20)
    })
  }
}

describe('queue drain after question select answer', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-select-drain',
    dirName: 'qa-question-select-drain',
    username: 'question-select-tester',
  })

  test(
    'queued messages drain in order after answering via dropdown select',
    async () => {
      const marker = 'QUESTION_SELECT_QUEUE_MARKER'
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: marker,
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 8_000,
        predicate: (candidate) => {
          return candidate.name === marker
        },
      })
      const th = ctx.discord.thread(thread.id)

      const questionMessages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'How to proceed?',
        timeout: 12_000,
      })
      const pending = await waitForPendingQuestion({
        threadId: thread.id,
        timeoutMs: 8_000,
      })
      const questionMessage = questionMessages.find((message) => {
        return message.content.includes('How to proceed?')
      })
      if (!questionMessage) {
        throw new Error('Expected question message')
      }

      const firstQueuedPrompt = 'QUESTION_SELECT_DRAIN_FIRST_MARKER'
      const secondQueuedPrompt = 'Reply with exactly: post-question-second'

      const { id: firstQueueInteractionId } = await th.user(TEST_USER_ID)
        .runSlashCommand({
          name: 'queue',
          options: [{ name: 'message', type: 3, value: firstQueuedPrompt }],
        })
      await th.waitForInteractionAck({
        interactionId: firstQueueInteractionId,
        timeout: 8_000,
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: `» **question-select-tester:** ${firstQueuedPrompt}`,
        timeout: 8_000,
      })

      const { id: secondQueueInteractionId } = await th.user(TEST_USER_ID)
        .runSlashCommand({
          name: 'queue',
          options: [{ name: 'message', type: 3, value: secondQueuedPrompt }],
        })
      await th.waitForInteractionAck({
        interactionId: secondQueueInteractionId,
        timeout: 8_000,
      })

      await expectNoBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: `» **question-select-tester:** ${secondQueuedPrompt}`,
        timeout: 200,
      })

      const interaction = await th.user(TEST_USER_ID).selectMenu({
        messageId: questionMessage.id,
        customId: `ask_question:${pending.contextHash}:0`,
        values: ['0'],
      })
      await th.waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 8_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 8_000,
        afterMessageIncludes: `» **question-select-tester:** ${firstQueuedPrompt}`,
        afterAuthorId: ctx.discord.botUserId,
      })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: `» **question-select-tester:** ${secondQueuedPrompt}`,
        timeout: 8_000,
      })
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 8_000,
        afterMessageIncludes: `» **question-select-tester:** ${secondQueuedPrompt}`,
        afterAuthorId: ctx.discord.botUserId,
      })

      const timeline = await th.text({ showInteractions: true })
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (question-select-tester)
        QUESTION_SELECT_QUEUE_MARKER
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        **Select action**
        How to proceed?
        ✓ _Alpha_
        [user interaction]
        » **question-select-tester:** QUESTION_SELECT_DRAIN_FIRST_MARKER
        Queued message (position 1)
        [user interaction]
        Queued message (position 1)
        [user selects dropdown: 0]
        » **question-select-tester:** Alpha
        question-drain-first
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        » **question-select-tester:** Reply with exactly: post-question-second
        ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(timeline).toContain('How to proceed?')
      expect(timeline).toContain('[user selects dropdown: 0]')
      expect(timeline).toContain(`» **question-select-tester:** ${firstQueuedPrompt}`)
      expect(timeline).toContain('question-drain-first')
      expect(timeline).toContain(`» **question-select-tester:** ${secondQueuedPrompt}`)
      expect(timeline).toContain('ok')
    },
    15_000,
  )
})
