// Voice routes must leave the source question answerable without aborting its run.
import { afterEach, describe, expect, test } from 'vitest'
import { setupQueueAdvancedSuite, TEST_USER_ID } from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'
import { store } from './store.js'

const TEXT_CHANNEL_ID = '200000000000001083'

describe('voice routing preserves source questions', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'voice-routing-question',
    dirName: 'voice-routing-question',
    username: 'voice-question-tester',
  })

  afterEach(() => {
    store.setState({ test: { deterministicTranscription: null } })
  })

  // Separate registrations permit distinct inline snapshots with Vitest 3.
  for (const sessionAction of ['btw', 'new-session'] as const) {
    test(`${sessionAction} preserves the source dropdown`, async () => {
      const marker = `QUESTION_SELECT_QUEUE_MARKER voice ${sessionAction}`
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content: marker })
      const source = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (thread) => thread.name === marker,
      })
      const th = ctx.discord.thread(source.id)
      const messages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: source.id,
        text: 'How to proceed?',
        timeout: 4_000,
      })
      const question = messages.find((message) => message.content.includes('How to proceed?'))
      if (!question) throw new Error('Expected question message')
      const customId = JSON.stringify(question.components).match(
        /"custom_id":"(ask_question:[^"]+)"/,
      )?.[1]
      if (!customId) throw new Error('Expected question dropdown')

      const prompt = `Explain routing without changing the source ${sessionAction}`
      store.setState({
        test: {
          deterministicTranscription: {
            transcription: prompt,
            queueMessage: false,
            sessionAction,
          },
        },
      })
      await th.user(TEST_USER_ID).sendVoiceMessage()
      const confirmation = sessionAction === 'btw' ? 'Session forked!' : 'Created new session in'
      const routingMessages = await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: source.id,
        text: confirmation,
        timeout: 4_000,
      })
      const targetId = routingMessages.find((message) => message.content.includes(confirmation))
        ?.content.match(/<#(\d+)>/)?.[1]
      if (!targetId) throw new Error('Expected destination thread link')
      const target = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (thread) => thread.id === targetId,
      })
      await waitForFooterMessage({ discord: ctx.discord, threadId: target.id, timeout: 4_000 })
      const interaction = await th.user(TEST_USER_ID).selectMenu({
        messageId: question.id,
        customId,
        values: ['0'],
      })
      await th.waitForInteractionAck({ interactionId: interaction.id, timeout: 4_000 })
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: source.id,
        text: '» **voice-question-tester:** Alpha',
        timeout: 4_000,
      })
      await waitForFooterMessage({ discord: ctx.discord, threadId: source.id, timeout: 4_000 })
      const transcript = (await th.text({ showInteractions: true })).replaceAll(
        target.id,
        'TARGET_THREAD',
      )
      if (sessionAction === 'btw') {
        expect(transcript).toMatchInlineSnapshot(`
          "--- from: user (voice-question-tester)
          QUESTION_SELECT_QUEUE_MARKER voice btw
          --- from: assistant (TestBot)
          -# *using deterministic-provider/deterministic-v2*
          **Select action**
          How to proceed?
          ✓ _Alpha_
          --- from: user (voice-question-tester)
          [attachment: voice-message.ogg]
          --- from: assistant (TestBot)
          🎤 Transcribing voice message...
          📝 **Transcribed message:** Explain routing without changing the source btw
          Session forked! Continue in <#TARGET_THREAD>
          [user selects dropdown: 0]
          » **voice-question-tester:** Alpha
          > tool done
          -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
        `)
      } else {
        expect(transcript).toMatchInlineSnapshot(`
          "--- from: user (voice-question-tester)
          QUESTION_SELECT_QUEUE_MARKER voice new-session
          --- from: assistant (TestBot)
          -# *using deterministic-provider/deterministic-v2*
          **Select action**
          How to proceed?
          ✓ _Alpha_
          --- from: user (voice-question-tester)
          [attachment: voice-message.ogg]
          --- from: assistant (TestBot)
          🎤 Transcribing voice message...
          📝 **Transcribed message:** Explain routing without changing the source new-session
          Created new session in <#TARGET_THREAD>
          [user selects dropdown: 0]
          » **voice-question-tester:** Alpha
          > tool done
          -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
        `)
      }
      expect(transcript).not.toContain('expired')
    })
  }
})
