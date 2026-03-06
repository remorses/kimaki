// E2e test for queue + interrupt interaction.
// Reproduces a bug where a user queues a command via /queue while a slow session
// is in progress, then sends a normal (non-queued) message to interrupt.
//
// Expected behavior:
//   1. Slow session is running
//   2. User queues a message via /queue (enters kimaki local queue)
//   3. User sends a normal message (interrupt)
//   4. Session aborts the slow task, processes the interrupt message immediately
//   5. Interrupt response appears in Discord with a ⬥ ok reply
//   6. When interrupt response completes, the queued message drains and runs
//
// Current buggy behavior (captured in inline snapshot):
//   - Normal messages go through submitViaOpencodeQueue → promptAsync which
//     does NOT abort the running task. It just adds to opencode's internal queue.
//   - The slow task runs to completion or times out, NOT interrupted by the
//     normal user message.
//   - The interrupt message's ⬥ ok reply is MISSING from Discord — opencode
//     processes it internally but kimaki doesn't surface it as a separate response.
//   - The queued message dispatches and runs, but the interrupt message
//     never gets its own visible response in the thread.
//
// Root cause: submitViaOpencodeQueue needs to abort the active run before
// calling promptAsync, so the interrupt message actually interrupts. Then
// after the abort settles and the interrupt message's response completes,
// the local queue should drain the /queue messages.
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

      // 6. Capture current behavior with inline snapshot.
      //
      //    BUG visible in snapshot: the interrupt message "Reply with exactly:
      //    interrupt-now" has NO ⬥ ok reply. The queued message dispatches and
      //    runs fine, but the user's direct interrupt message is swallowed.
      //
      //    Expected (when fixed): there should be a ⬥ ok reply for interrupt-now
      //    between the user's interrupt message and the queue dispatch indicator.
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (interrupt-tester)
        Reply with exactly: setup-interrupt-drain
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (interrupt-tester)
        PLUGIN_TIMEOUT_SLEEP_MARKER
        --- from: assistant (TestBot)
        ⬥ starting sleep 100
        --- from: assistant (TestBot)
        Queued message (position 1)
        --- from: user (interrupt-tester)
        Reply with exactly: interrupt-now
        --- from: assistant (TestBot)
        » **interrupt-tester:** Reply with exactly: queued-behind-slow
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)

      // 7. Assert the expected behavior that should happen when the bug is fixed.
      //    These assertions currently FAIL, demonstrating the bug.
      const text = await th.text()
      const lines = text.split('\n')

      // Find the interrupt user message line
      const interruptUserLine = lines.findIndex((line) => {
        return line.includes('Reply with exactly: interrupt-now')
      })
      expect(interruptUserLine).toBeGreaterThan(-1)

      // Find the queue dispatch indicator line
      const queueDispatchLine = lines.findIndex((line) => {
        return line.includes('» **interrupt-tester:** Reply with exactly: queued-behind-slow')
      })
      expect(queueDispatchLine).toBeGreaterThan(-1)

      // There should be a ⬥ ok reply for the interrupt message BETWEEN the
      // interrupt user message and the queue dispatch indicator.
      // BUG: currently there is no such reply — the interrupt message is swallowed.
      const linesBetween = lines.slice(interruptUserLine + 1, queueDispatchLine)
      const hasInterruptReply = linesBetween.some((line) => {
        return line.includes('⬥ ok')
      })
      expect(hasInterruptReply).toBe(true)
    },
    20_000,
  )
})
