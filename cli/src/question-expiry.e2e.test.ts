// E2e tests: a question dropdown expires when OpenCode settles its form
// without a Discord answer. An external interrupt cancels the form (since
// OpenCode 2.0.19). A server restart drops it while SSE is disconnected, so
// reconnect reconciliation must settle it. A late answer is never resent.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining } from './test-utils.js'
import { pendingQuestionContexts } from './commands/ask-question.js'
import { getOpencodeClient, restartOpencodeServer } from './opencode.js'
import { getThreadSession } from './database.js'

const TEXT_CHANNEL_ID = '200000000000001032'

describe('question dropdown expiry', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-expiry',
    dirName: 'qa-question-expiry',
    username: 'question-expiry-tester',
  })

  async function showQuestion(marker: string) {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: marker,
    })
    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 8_000,
      predicate: (t) => {
        return t.name === marker
      },
    })
    const messages = await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      text: 'How to proceed?',
      timeout: 12_000,
    })
    const questionMsg = messages.find((message) => {
      return message.content.includes('How to proceed?')
    })
    if (!questionMsg) throw new Error('Expected question message')
    const pendingEntry = [...pendingQuestionContexts.entries()].find(([, context]) => {
      return context.thread.id === thread.id
    })
    if (!pendingEntry) throw new Error('Expected pending question context')
    return { thread, questionMsg, contextHash: pendingEntry[0] }
  }

  async function expectExpiredAnswer({
    threadId,
    messageId,
    contextHash,
  }: {
    threadId: string
    messageId: string
    contextHash: string
  }) {
    const expireStart = Date.now()
    while (pendingQuestionContexts.has(contextHash) && Date.now() - expireStart < 4_000) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      })
    }
    expect(pendingQuestionContexts.has(contextHash)).toBe(false)
    const th = ctx.discord.thread(threadId)
    const interaction = await th.user(TEST_USER_ID).selectMenu({
      messageId,
      customId: `ask_question:${contextHash}:0`,
      values: ['0'],
    })
    await th.waitForInteractionAck({ interactionId: interaction.id, timeout: 8_000 })
  }

  test('external opencode interrupt expires the dropdown', async () => {
    const { thread, questionMsg, contextHash } = await showQuestion(
      'QUESTION_ABORT_RESUME_MARKER interrupt',
    )
    const sessionId = await getThreadSession(thread.id)
    const client = getOpencodeClient(ctx.directories.projectDirectory)
    if (!sessionId || !client) throw new Error('Expected session and client')
    await client.session.interrupt({ sessionID: sessionId })

    await expectExpiredAnswer({ threadId: thread.id, messageId: questionMsg.id, contextHash })
    expect(await ctx.discord.thread(thread.id).text({ showInteractions: true })).toMatchInlineSnapshot(`
      "--- from: user (question-expiry-tester)
      QUESTION_ABORT_RESUME_MARKER interrupt
      --- from: assistant (TestBot)
      -# *using deterministic-provider/deterministic-v2*
      **Select action**
      How to proceed?
      [user selects dropdown: 0]
      This question has expired. Please ask the AI again."
    `)
  }, 25_000)

  test('reconnect settles a form dropped while disconnected', async () => {
    const { thread, questionMsg, contextHash } = await showQuestion(
      'QUESTION_ABORT_RESUME_MARKER restart',
    )
    // Forms live in server memory, so a restart drops the form without any
    // form.cancelled event reaching Kimaki.
    const restartResult = await restartOpencodeServer()
    if (restartResult instanceof Error) throw restartResult

    await expectExpiredAnswer({ threadId: thread.id, messageId: questionMsg.id, contextHash })
    expect(await ctx.discord.thread(thread.id).text({ showInteractions: true })).toMatchInlineSnapshot(`
      "--- from: user (question-expiry-tester)
      QUESTION_ABORT_RESUME_MARKER restart
      --- from: assistant (TestBot)
      -# *using deterministic-provider/deterministic-v2*
      **Select action**
      How to proceed?
      [user selects dropdown: 0]
      This question has expired. Please ask the AI again."
    `)
  }, 25_000)
})
