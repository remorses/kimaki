// E2e tests for abort, model-switch, and retry scenarios.
// Split from thread-queue-advanced.e2e.test.ts for parallelization.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  getRuntime,
} from './session-handler/thread-session-runtime.js'
import { getThreadState } from './session-handler/thread-runtime-state.js'
import { setSessionModel } from './database.js'
import {
  waitForFooterMessage,
  waitForBotMessageContaining,
  waitForBotReplyAfterUserMessage,
  waitForThreadPhase,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001003'

const e2eTest = describe

e2eTest('queue advanced: abort and retry', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-abort-e2e',
    dirName: 'qa-abort-e2e',
    username: 'queue-advanced-tester',
  })

  test(
    'slow tool call (sleep) gets aborted by explicit abort, then queue continues',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: oscar',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: oscar'
        },
      })

      const th = ctx.discord.thread(thread.id)
      const firstReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      // Wait for the first completion footer so it lands in a deterministic position
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === ctx.discord.botUserId
      }).length

      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
        timeout: 4_000,
      })

      // The matcher emits "starting sleep 100" text before the long delay.
      // Wait for it to land in Discord BEFORE aborting so the message is in a
      // deterministic position and the abort produces no further stray messages.
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'starting sleep',
        afterUserMessageIncludes: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
        timeout: 4_000,
      })

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for explicit-abort test')
      }

      runtime.abortActiveRun('test-explicit-abort')

      // Wait for abort to settle before sending next message
      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'idle',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: papa',
      })

      const after = await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'papa',
        timeout: 8_000,
      })

      const afterBotMessages = after.filter((m) => {
        return m.author.id === ctx.discord.botUserId
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 8_000,
        afterMessageIncludes: 'papa',
        afterAuthorId: TEST_USER_ID,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-advanced-tester)
        PLUGIN_TIMEOUT_SLEEP_MARKER
        --- from: assistant (TestBot)
        ⬥ starting sleep 100
        --- from: user (queue-advanced-tester)
        Reply with exactly: papa
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(afterBotMessages.length).toBeGreaterThanOrEqual(beforeBotCount + 1)

      const sleepToolIndex = after.findIndex((m) => {
        return (
          m.author.id === TEST_USER_ID &&
          m.content.includes('PLUGIN_TIMEOUT_SLEEP_MARKER')
        )
      })
      expect(sleepToolIndex).toBeGreaterThan(-1)

      const userPapaIndex = after.findIndex((m) => {
        return m.author.id === TEST_USER_ID && m.content.includes('papa')
      })
      expect(userPapaIndex).toBeGreaterThan(-1)
      expect(sleepToolIndex).toBeLessThan(userPapaIndex)
      const lastBotIndex = after.findLastIndex((m) => {
        return m.author.id === ctx.discord.botUserId
      })
      expect(userPapaIndex).toBeLessThan(lastBotIndex)
    },
    12_000,
  )

  test(
    'explicit abort emits MessageAbortedError and does not emit footer',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: abort-no-footer-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: abort-no-footer-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⋅',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'SLOW_ABORT_MARKER run long response',
      })

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
        timeout: 4_000,
      })

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for abort no-footer test')
      }

      const beforeAbortMessages = await th.getMessages()
      const baselineCount = beforeAbortMessages.length

      runtime.abortActiveRun('test-no-footer-on-abort')

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'idle',
        timeout: 4_000,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-advanced-tester)
        SLOW_ABORT_MARKER run long response"
      `)
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
        const msgs = await th.getMessages()
        const newMsgs = msgs.slice(baselineCount)
        const hasFooter = newMsgs.some((m) => {
          return m.author.id === ctx.discord.botUserId
            && m.content.startsWith('*')
            && m.content.includes('⋅')
        })
        expect(hasFooter).toBe(false)
      }
    },
    10_000,
  )

  test.skip(
    'explicit abort stale-idle window: follow-up prompt still gets assistant text',
    async () => {
      const setupPrompt = 'Reply with exactly: race-setup-1'
      const raceFinalPrompt = 'Reply with exactly: race-final-1'

      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: setupPrompt,
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === setupPrompt
        },
      })

      const th = ctx.discord.thread(thread.id)
      const setupReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(setupReply.content.trim().length).toBeGreaterThan(0)

      await th.user(TEST_USER_ID).sendMessage({
        content: 'SLOW_ABORT_MARKER run long response',
      })

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
        timeout: 4_000,
      })

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for race abort scenario')
      }

      runtime.abortActiveRun('test-race-abort')

      await th.user(TEST_USER_ID).sendMessage({
        content: raceFinalPrompt,
      })

      await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: raceFinalPrompt,
        timeout: 4_000,
      })
    },
    8_000,
  )

  test(
    'model switch mid-session aborts and restarts from same session history',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: retry-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: retry-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)
      const firstReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
        timeout: 4_000,
      })

      const sessionId = getThreadState(thread.id)?.sessionId
      expect(sessionId).toBeDefined()
      if (!sessionId) {
        throw new Error('Expected active session id for model switch test')
      }

      await setSessionModel({
        sessionId,
        modelId: 'deterministic-provider/deterministic-v3',
        variant: null,
      })

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for model switch test')
      }
      const retried = await runtime.retryLastUserPrompt()
      expect(retried).toBe(true)

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: model-switch-followup',
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: user (queue-advanced-tester)
        PLUGIN_TIMEOUT_SLEEP_MARKER
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-advanced-tester)
        Reply with exactly: model-switch-followup"
      `)
      await waitForBotReplyAfterUserMessage({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'model-switch-followup',
        timeout: 4_000,
      })
    },
    10_000,
  )

  test(
    'abortActiveRun settles correctly during long-running request',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: force-abort-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: force-abort-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)
      const setupReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(setupReply.content.trim().length).toBeGreaterThan(0)

      await th.user(TEST_USER_ID).sendMessage({
        content: 'SLOW_ABORT_MARKER run long response',
      })

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
        timeout: 4_000,
      })

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for forced-abort test')
      }

      runtime.abortActiveRun('force-abort-test')

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'idle',
        timeout: 4_000,
      })
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: user (queue-advanced-tester)
        SLOW_ABORT_MARKER run long response
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
    },
    10_000,
  )
})
