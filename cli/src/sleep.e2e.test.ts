// E2e coverage for the durable kimaki_sleep tool.
// Verifies the tool persists a wake row, the thread shows the sleep line,
// the task runner wake resumes the same session, and a user message cancels
// a planned sleep so the wake never fires.

import { describe, test, expect } from 'vitest'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'
import { getSessionSleep, getThreadSession } from './database.js'
import { wakeDueSessionSleeps } from './task-runner.js'

const TEXT_CHANNEL_ID = '200000000000001031'

// Fixed wake instant so the wake message stays snapshot-stable across runs.
const SLEEP_UNTIL = '2030-01-01T09:00:00Z'
const AFTER_SLEEP_UNTIL = new Date('2030-01-01T09:00:01Z')

function createSleepMatchers(): DeterministicMatcher[] {
  const sleepCallMatcher: DeterministicMatcher = {
    id: 'sleep-tool-call',
    priority: 130,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'SLEEP_TOOL_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sleep-call-text' },
        {
          type: 'text-delta',
          id: 'sleep-call-text',
          delta: 'waiting for the deploy',
        },
        { type: 'text-end', id: 'sleep-call-text' },
        {
          type: 'tool-call',
          toolCallId: 'sleep-call-1',
          toolName: 'kimaki_sleep',
          input: JSON.stringify({
            until: SLEEP_UNTIL,
            reason: 'waiting for the deploy',
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const sleepAcknowledgeMatcher: DeterministicMatcher = {
    id: 'sleep-tool-ack',
    priority: 129,
    when: {
      latestUserTextIncludes: 'SLEEP_TOOL_MARKER',
      rawPromptIncludes: 'Sleeping until',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sleep-ack-text' },
        { type: 'text-delta', id: 'sleep-ack-text', delta: 'sleep-started' },
        { type: 'text-end', id: 'sleep-ack-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const sleepWakeMatcher: DeterministicMatcher = {
    id: 'sleep-tool-wake',
    priority: 131,
    when: {
      latestUserTextIncludes: 'Woke after sleeping until',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sleep-wake-text' },
        { type: 'text-delta', id: 'sleep-wake-text', delta: 'sleep-wake-done' },
        { type: 'text-end', id: 'sleep-wake-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const sleepCancelCallMatcher: DeterministicMatcher = {
    id: 'sleep-cancel-call',
    priority: 132,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'SLEEP_CANCEL_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'sleep-cancel-call-1',
          toolName: 'kimaki_sleep',
          input: JSON.stringify({ duration: '2h', reason: 'cancel me' }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const sleepCancelAckMatcher: DeterministicMatcher = {
    id: 'sleep-cancel-ack',
    priority: 133,
    when: {
      latestUserTextIncludes: 'SLEEP_CANCEL_MARKER',
      rawPromptIncludes: 'Sleeping until',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sleep-cancel-ack-text' },
        {
          type: 'text-delta',
          id: 'sleep-cancel-ack-text',
          delta: 'cancel-sleep-started',
        },
        { type: 'text-end', id: 'sleep-cancel-ack-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const sleepQueueCallMatcher: DeterministicMatcher = {
    id: 'sleep-queue-call',
    priority: 135,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'SLEEP_QUEUE_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'sleep-queue-call-1',
          toolName: 'kimaki_sleep',
          input: JSON.stringify({ duration: '2h', reason: 'queue supersedes' }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const sleepQueueAckMatcher: DeterministicMatcher = {
    id: 'sleep-queue-ack',
    priority: 136,
    when: {
      latestUserTextIncludes: 'SLEEP_QUEUE_MARKER',
      rawPromptIncludes: 'Sleeping until',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sleep-queue-ack-text' },
        {
          type: 'text-delta',
          id: 'sleep-queue-ack-text',
          delta: 'queue-sleep-started',
        },
        { type: 'text-end', id: 'sleep-queue-ack-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const sleepQueuedMessageMatcher: DeterministicMatcher = {
    id: 'sleep-queued-message',
    priority: 137,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'SLEEP_QUEUE_FOLLOWUP',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sleep-queued-text' },
        {
          type: 'text-delta',
          id: 'sleep-queued-text',
          delta: 'queue-followup-done',
        },
        { type: 'text-end', id: 'sleep-queued-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const sleepCancelFollowupMatcher: DeterministicMatcher = {
    id: 'sleep-cancel-followup',
    priority: 134,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'SLEEP_CANCEL_FOLLOWUP',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sleep-cancel-followup-text' },
        {
          type: 'text-delta',
          id: 'sleep-cancel-followup-text',
          delta: 'cancel-followup-done',
        },
        { type: 'text-end', id: 'sleep-cancel-followup-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  return [
    sleepCallMatcher,
    sleepAcknowledgeMatcher,
    sleepWakeMatcher,
    sleepCancelCallMatcher,
    sleepCancelAckMatcher,
    sleepCancelFollowupMatcher,
    sleepQueueCallMatcher,
    sleepQueueAckMatcher,
    sleepQueuedMessageMatcher,
  ]
}

describe('kimaki_sleep', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'sleep-e2e',
    dirName: 'sleep-e2e',
    username: 'sleep-tester',
    extraMatchers: createSleepMatchers(),
  })

  test(
    'persists a wake row, then the runner wakes the same session',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'SLEEP_TOOL_MARKER wait for the deploy',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'SLEEP_TOOL_MARKER wait for the deploy'
        },
      })

      const th = ctx.discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'sleep-started',
        timeout: 4_000,
      })

      // Let the first turn finish emitting its footer before waking, otherwise
      // the footer can land after the wake message and reorder the snapshot.
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'sleep-started',
        afterAuthorId: ctx.discord.botUserId,
      })

      const sessionId = await getThreadSession(thread.id)
      if (!sessionId) {
        throw new Error('Expected a thread session after the sleep tool ran')
      }

      const plannedSleep = await getSessionSleep({ sessionId })
      expect(plannedSleep?.status).toBe('planned')
      expect(plannedSleep?.reason).toBe('waiting for the deploy')

      // The row is years out, so pass a future `now` instead of waiting on the tick.
      await wakeDueSessionSleeps({
        rest: ctx.botClient.rest,
        now: AFTER_SLEEP_UNTIL,
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'sleep-wake-done',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'sleep-wake-done',
        afterAuthorId: ctx.discord.botUserId,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (sleep-tester)
        SLEEP_TOOL_MARKER wait for the deploy
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        ⬥ waiting for the deploy
        ┣ kimaki_sleep until 2030-01-01T09:00:00Z _waiting for the deploy_
        ⬥ sleep-started
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        ⬦ Woke after sleeping until 2030-01-01 09:00 UTC
        Reason: waiting for the deploy
        Continue the work you were waiting for.
        [embed]
        ⬥ sleep-wake-done
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)

      // The wake must continue the SAME OpenCode session, not start a new one:
      // that is the whole point of sleeping instead of scheduling a new prompt.
      expect(await getThreadSession(thread.id)).toBe(sessionId)

      // `consumed` proves ingress actually turned the wake into a turn. The row
      // only reaches this state through the ingress commit point.
      const wokenSleep = await getSessionSleep({ sessionId })
      expect(wokenSleep?.status).toBe('consumed')

      // Replaying the tick must not produce a second wake turn.
      const messagesBeforeReplay = (await th.getMessages()).length
      await wakeDueSessionSleeps({
        rest: ctx.botClient.rest,
        now: AFTER_SLEEP_UNTIL,
      })
      for (let attempt = 0; attempt < 10; attempt++) {
        expect((await th.getMessages()).length).toBe(messagesBeforeReplay)
        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
      }
    },
    20_000,
  )

  test(
    'a user message cancels a planned sleep so no wake fires',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'SLEEP_CANCEL_MARKER wait for something',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'SLEEP_CANCEL_MARKER wait for something'
        },
      })

      const th = ctx.discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'cancel-sleep-started',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'cancel-sleep-started',
        afterAuthorId: ctx.discord.botUserId,
      })

      const sessionId = await getThreadSession(thread.id)
      if (!sessionId) {
        throw new Error('Expected a thread session after the sleep tool ran')
      }
      expect((await getSessionSleep({ sessionId }))?.status).toBe('planned')

      await th.user(TEST_USER_ID).sendMessage({
        content: 'SLEEP_CANCEL_FOLLOWUP never mind, keep going',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'cancel-followup-done',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'cancel-followup-done',
        afterAuthorId: ctx.discord.botUserId,
      })

      // Cancellation happens inside runtime.enqueueIncoming, so it covers
      // slash commands and CLI-injected prompts, not just chat messages.
      expect((await getSessionSleep({ sessionId }))?.status).toBe('cancelled')

      await wakeDueSessionSleeps({
        rest: ctx.botClient.rest,
        now: AFTER_SLEEP_UNTIL,
      })

      // Everything is deterministic, so a short poll proves the wake never posts.
      for (let attempt = 0; attempt < 10; attempt++) {
        const messages = await th.getMessages()
        const woke = messages.some((message) => {
          return message.content.includes('Woke after sleeping until')
        })
        expect(woke).toBe(false)
        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
      }

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (sleep-tester)
        SLEEP_CANCEL_MARKER wait for something
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        ┣ kimaki_sleep for 2h _cancel me_
        ⬥ cancel-sleep-started
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (sleep-tester)
        SLEEP_CANCEL_FOLLOWUP never mind, keep going
        --- from: assistant (TestBot)
        ⬥ cancel-followup-done
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
    },
    20_000,
  )

  test(
    '/queue also supersedes a pending sleep',
    async () => {
      // Slash commands never reach the Discord MessageCreate handler, so this
      // proves cancellation really lives in the shared ingress path.
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'SLEEP_QUEUE_MARKER wait for something',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'SLEEP_QUEUE_MARKER wait for something'
        },
      })

      const th = ctx.discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'queue-sleep-started',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'queue-sleep-started',
        afterAuthorId: ctx.discord.botUserId,
      })

      const sessionId = await getThreadSession(thread.id)
      if (!sessionId) {
        throw new Error('Expected a thread session after the sleep tool ran')
      }
      expect((await getSessionSleep({ sessionId }))?.status).toBe('planned')

      const { id: queueInteractionId } = await th.user(TEST_USER_ID)
        .runSlashCommand({
          name: 'queue',
          options: [
            {
              name: 'message',
              type: 3,
              value: 'SLEEP_QUEUE_FOLLOWUP handle this instead',
            },
          ],
        })
      await th.waitForInteractionAck({
        interactionId: queueInteractionId,
        timeout: 4_000,
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'queue-followup-done',
        timeout: 4_000,
      })

      expect((await getSessionSleep({ sessionId }))?.status).toBe('cancelled')

      await wakeDueSessionSleeps({
        rest: ctx.botClient.rest,
        now: AFTER_SLEEP_UNTIL,
      })

      for (let attempt = 0; attempt < 10; attempt++) {
        const messages = await th.getMessages()
        const woke = messages.some((message) => {
          return message.content.includes('Woke after sleeping until')
        })
        expect(woke).toBe(false)
        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
      }
    },
    20_000,
  )
})
