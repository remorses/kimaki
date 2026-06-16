// E2e test for queue + interrupt interaction.
// Validates that a user can queue a command via /queue while a slow session
// is in progress, then send a normal (non-queued) message to interrupt.
//
// Expected behavior:
//   1. Slow session is running
//   2. User queues a message via /queue (enters kimaki local queue)
//   3. User sends a normal message (interrupt)
//   4. Session aborts the slow task, processes the interrupt message immediately
//   5. Interrupt response appears in Discord with a ⬥ ok reply
//   6. When interrupt response completes, the queued message drains and runs
//
// Uses opencode-deterministic-provider (no real LLM calls).
// Poll timeouts: 4s max, 100ms interval. Slow matcher uses 100s delay.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForFooterMessage,
  waitForBotMessageContaining,
  waitForMessageById,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001099'

const e2eTest = describe

e2eTest('queue + interrupt drain ordering', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-interrupt-drain-e2e',
    dirName: 'qa-interrupt-drain-e2e',
    username: 'interrupt-tester',
  })

  test(
    'queued message via /queue + normal interrupt: interrupt reply should appear, then queue drains',
    async () => {
      // 1. Establish session with a quick first message
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: setup-interrupt-drain',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: setup-interrupt-drain'
        },
      })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      // Wait for first run to fully complete (footer) so state is clean
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      // 2. Start a slow session — PLUGIN_TIMEOUT_SLEEP_MARKER has a 100s delay
      //    before the finish event, guaranteeing the session stays busy.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })

      // Wait for the slow matcher to start streaming (text appears before delay)
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'starting sleep',
        afterUserMessageIncludes: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
        timeout: 4_000,
      })

      // 3. Queue a message via /queue while the slow session is running
      const { id: queueInteractionId } = await th.user(TEST_USER_ID)
        .runSlashCommand({
          name: 'queue',
          options: [{ name: 'message', type: 3, value: 'Reply with exactly: queued-behind-slow' }],
        })

      const queueAck = await th.waitForInteractionAck({
        interactionId: queueInteractionId,
        timeout: 4_000,
      })
      if (!queueAck.messageId) {
        throw new Error('Expected /queue response message id')
      }

      const queueStatusMessage = await waitForMessageById({
        discord: ctx.discord,
        threadId: thread.id,
        messageId: queueAck.messageId,
        timeout: 4_000,
      })
      // The /queue message should be queued (session is busy with the 100s task)
      expect(queueStatusMessage.content).toContain('Queued message')

      // 4. Send a normal (non-queued) message — this should interrupt the slow
      //    session and be processed immediately
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: interrupt-now',
      })

      // 5. Wait for the final state: the interrupt message should get its own
      //    ⬥ ok reply, then the queued message should drain and get processed.
      //    We wait for the queued message's footer as the final signal.
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 12_000,
        afterMessageIncludes: 'queued-behind-slow',
        afterAuthorId: ctx.discord.botUserId,
      })

      // 6. Capture the full interaction in an inline snapshot.
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (interrupt-tester)
        Reply with exactly: setup-interrupt-drain
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (interrupt-tester)
        PLUGIN_TIMEOUT_SLEEP_MARKER
        --- from: assistant (TestBot)
        ⬥ starting sleep 100
        Queued message (position 1)
        --- from: user (interrupt-tester)
        Reply with exactly: interrupt-now
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        » **interrupt-tester:** Reply with exactly: queued-behind-slow
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)

      // 7. Assert the interrupt message got its own ⬥ ok reply between the
      //    user's interrupt message and the queue dispatch indicator.
      const text = await th.text()
      const lines = text.split('\n')

      const interruptUserLine = lines.findIndex((line) => {
        return line.includes('Reply with exactly: interrupt-now')
      })
      expect(interruptUserLine).toBeGreaterThan(-1)

      const queueDispatchLine = lines.findIndex((line) => {
        return line.includes('» **interrupt-tester:** Reply with exactly: queued-behind-slow')
      })
      expect(queueDispatchLine).toBeGreaterThan(-1)

      const linesBetween = lines.slice(interruptUserLine + 1, queueDispatchLine)
      const hasInterruptReply = linesBetween.some((line) => {
        return line.includes('⬥ ok')
      })
      expect(hasInterruptReply).toBe(true)
    },
    20_000,
  )
})
