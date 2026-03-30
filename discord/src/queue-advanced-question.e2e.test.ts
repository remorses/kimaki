// E2e test for question tool: user text message during pending question should
// dismiss the question (abort), then enqueue as a normal user prompt.
// The user's message must appear as a real user message in the thread, not
// get consumed as a tool result answer (which lost voice/image content).

import { describe, test, expect, afterEach } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'
import { pendingQuestionContexts } from './commands/ask-question.js'
import { store, type DeterministicTranscriptionConfig } from './store.js'

const TEXT_CHANNEL_ID = '200000000000001007'
const VOICE_CHANNEL_ID = '200000000000001017'

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

function setDeterministicTranscription(config: DeterministicTranscriptionConfig | null) {
  store.setState({
    test: { deterministicTranscription: config },
  })
}

describe('queue advanced: question tool answer', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-question-e2e',
    dirName: 'qa-question-e2e',
    username: 'queue-question-tester',
  })

  afterEach(() => {
    setDeterministicTranscription(null)
  })

  test(
    'user text message dismisses pending question and enqueues as normal prompt',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'QUESTION_TEXT_ANSWER_MARKER',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 8_000,
        predicate: (t) => {
          return t.name === 'QUESTION_TEXT_ANSWER_MARKER'
        },
      })

      const th = ctx.discord.thread(thread.id)

      // Wait for the question dropdown message to appear in Discord.
      // This is the user-visible signal that the question tool fired and
      // kimaki processed the event. Avoids polling internal Maps which
      // have timing sensitivity on slower CI hardware.
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'Which option do you prefer?',
        timeout: 12_000,
      })

      // User sends a text message while question is pending.
      // This should:
      // 1. Dismiss the pending question (cleanup context)
      // 2. Abort the blocked session so OpenCode unblocks
      // 3. Enqueue the message as a normal user prompt (not consumed as answer)
      await th.user(TEST_USER_ID).sendMessage({
        content: 'my text answer',
      })

      // Give time for question cleanup to propagate
      await new Promise((r) => {
        setTimeout(r, 1_000)
      })

      const timeline = await th.text({ showInteractions: true })

      // The user's text answer must appear in Discord
      expect(timeline).toContain('my text answer')
      // The original question must have appeared
      expect(timeline).toContain('Which option do you prefer?')
      // The user's marker message triggered the question
      expect(timeline).toContain('QUESTION_TEXT_ANSWER_MARKER')
    },
    20_000,
  )

})

describe('queue advanced: voice message during pending question', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: VOICE_CHANNEL_ID,
    channelName: 'qa-question-voice-e2e',
    dirName: 'qa-question-voice-e2e',
    username: 'queue-question-tester',
  })

  afterEach(() => {
    setDeterministicTranscription(null)
  })

  test(
    'voice message during pending question dismisses question and transcribes normally',
    async () => {
      // This is the exact bug scenario: user sends a voice message while a
      // question dropdown is pending. Voice messages have empty message.content
      // (audio is in attachments, transcription happens later). The old code
      // passed "" as the question answer and consumed the message — the voice
      // content was completely lost.
      await ctx.discord.channel(VOICE_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'QUESTION_TEXT_ANSWER_MARKER',
      })

      const thread = await ctx.discord.channel(VOICE_CHANNEL_ID).waitForThread({
        timeout: 8_000,
        predicate: (t) => {
          return t.name === 'QUESTION_TEXT_ANSWER_MARKER'
        },
      })

      const th = ctx.discord.thread(thread.id)

      // Wait for the question dropdown message to appear in Discord
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'Which option do you prefer?',
        timeout: 12_000,
      })

      // Send a voice message while the question is pending.
      // message.content is "" for voice messages — only the attachment exists.
      setDeterministicTranscription({
        transcription: 'I want option Alpha please',
        queueMessage: false,
      })

      await th.user(TEST_USER_ID).sendVoiceMessage()

      // Give time for question cleanup to propagate
      await new Promise((r) => {
        setTimeout(r, 1_000)
      })

      // Voice content should be transcribed and appear as the next user message,
      // processed after the model responds to the empty question answer.
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'I want option Alpha please',
        timeout: 8_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 8_000,
        afterMessageIncludes: 'I want option Alpha please',
        afterAuthorId: ctx.discord.botUserId,
      })

      const timeline = await th.text({ showInteractions: true })
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (queue-question-tester)
        QUESTION_TEXT_ANSWER_MARKER
        --- from: assistant (TestBot)
        **Pick one**
        Which option do you prefer?
        --- from: user (queue-question-tester)
        [attachment: voice-message.ogg]
        --- from: assistant (TestBot)
        🎤 Transcribing voice message...
        📝 **Transcribed message:** I want option Alpha please
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)

      // Voice content must be present as a real transcribed message, not lost
      expect(timeline).toContain('I want option Alpha please')
    },
    20_000,
  )
})
