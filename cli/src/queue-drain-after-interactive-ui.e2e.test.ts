// E2e test: queued messages must drain immediately when the session is idle,
// even if action buttons are still pending. The isSessionBusy check is
// sufficient — hasPendingInteractiveUi() should NOT block queue drain.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'
import { getThreadSession } from './database.js'
import {
  pendingActionButtonContexts,
  showActionButtons,
} from './commands/action-buttons.js'

const TEXT_CHANNEL_ID = '200000000000001020'

describe('queue drain with pending interactive UI', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-drain-interactive-ui',
    dirName: 'qa-drain-interactive-ui',
    username: 'drain-ui-tester',
  })

  test(
    'queued message drains immediately while action buttons are still pending',
    async () => {
      // 1. Create a thread with a first completed reply
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: drain-button-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: drain-button-setup'
        },
      })

      const th = ctx.discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'ok',
        afterAuthorId: ctx.discord.botUserId,
      })

      // 2. Show action buttons (session is idle, buttons are pending)
      const currentSessionId = await getThreadSession(thread.id)
      if (!currentSessionId) {
        throw new Error('Expected thread session id')
      }

      const channel = await ctx.botClient.channels.fetch(thread.id)
      if (!channel || !channel.isThread()) {
        throw new Error('Expected Discord thread channel')
      }

      await showActionButtons({
        thread: channel,
        sessionId: currentSessionId,
        directory: ctx.directories.projectDirectory,
        buttons: [{ label: 'Pending button', color: 'white' }],
      })

      // Verify buttons are pending
      const start = Date.now()
      while (Date.now() - start < 4_000) {
        const entry = [...pendingActionButtonContexts.entries()].find(([, context]) => {
          return context.thread.id === thread.id && Boolean(context.messageId)
        })
        if (entry) {
          break
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100)
        })
      }
      expect(
        [...pendingActionButtonContexts.values()].some((c) => {
          return c.thread.id === thread.id
        }),
      ).toBe(true)

      // 3. Queue a message via /queue while buttons are still pending.
      //    The queue should drain immediately because session is idle.
      //    Currently FAILS: hasPendingInteractiveUi() blocks tryDrainQueue().
      const { id: queueInteractionId } = await th.user(TEST_USER_ID)
        .runSlashCommand({
          name: 'queue',
          options: [{ name: 'message', type: 3, value: 'Reply with exactly: post-button-drain' }],
        })

      const queueAck = await th.waitForInteractionAck({
        interactionId: queueInteractionId,
        timeout: 4_000,
      })
      if (!queueAck.messageId) {
        throw new Error('Expected /queue response message id')
      }

      // 4. Queued message should dispatch immediately (not stay "Queued").
      //    The dispatch indicator should appear quickly.
      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: '» **drain-ui-tester:** Reply with exactly: post-button-drain',
        timeout: 4_000,
      })

      // 5. Wait for the footer after the drained message completes
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: '» **drain-ui-tester:**',
        afterAuthorId: ctx.discord.botUserId,
      })

      const timeline = await th.text({ showInteractions: true })
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (drain-ui-tester)
        Reply with exactly: drain-button-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        **Action Required**
        [user interaction]
        » **drain-ui-tester:** Reply with exactly: post-button-drain
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
    },
    20_000,
  )
})
