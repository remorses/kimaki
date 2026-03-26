// E2e regression test for action button click continuation in thread sessions.
// Reproduces the bug where button click interaction acks but the session does not continue.

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

const TEXT_CHANNEL_ID = '200000000000001006'

async function waitForPendingActionButtons({
  threadId,
  timeoutMs,
}: {
  threadId: string
  timeoutMs: number
}): Promise<{ contextHash: string; messageId: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const entry = [...pendingActionButtonContexts.entries()].find(([, context]) => {
      return context.thread.id === threadId && Boolean(context.messageId)
    })
    if (entry) {
      const [contextHash, context] = entry
      if (context.messageId) {
        return { contextHash, messageId: context.messageId }
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error('Timed out waiting for pending action buttons context')
}

async function waitForNoPendingActionButtons({
  threadId,
  timeoutMs,
}: {
  threadId: string
  timeoutMs: number
}): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const stillPending = [...pendingActionButtonContexts.values()].some((context) => {
      return context.thread.id === threadId
    })
    if (!stillPending) {
      return
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error('Timed out waiting for action buttons cleanup')
}

describe('queue advanced: action buttons', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-action-buttons-e2e',
    dirName: 'qa-action-buttons-e2e',
    username: 'queue-action-tester',
  })

  test(
    'button click should continue the session with a follow-up assistant reply',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: action-button-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: action-button-setup'
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

      const currentSessionId = await getThreadSession(thread.id)
      if (!currentSessionId) {
        throw new Error('Expected thread session id before showing action buttons')
      }

      const channel = await ctx.botClient.channels.fetch(thread.id)
      if (!channel || !channel.isThread()) {
        throw new Error('Expected Discord thread channel for action button test')
      }

      await showActionButtons({
        thread: channel,
        sessionId: currentSessionId,
        directory: ctx.directories.projectDirectory,
        buttons: [{ label: 'Continue action-buttons flow', color: 'green' }],
      })

      const action = await waitForPendingActionButtons({
        threadId: thread.id,
        timeoutMs: 12_000,
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Action Required',
        timeout: 12_000,
      })

      const interaction = await th.user(TEST_USER_ID).clickButton({
        messageId: action.messageId,
        customId: `action_button:${action.contextHash}:0`,
      })

      await th.waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 4_000,
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'action-buttons-click-continued',
        timeout: 12_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 12_000,
        afterMessageIncludes: 'action-buttons-click-continued',
        afterAuthorId: ctx.discord.botUserId,
      })

      const timeline = await th.text({ showInteractions: true })
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (queue-action-tester)
        Reply with exactly: action-button-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ **z_orchestrator***
        **Action Required**
        _Selected: Continue action-buttons flow_
        [user clicks button]
        ⬥ action-buttons-click-continued
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ **z_orchestrator***"
      `)
      expect(timeline).toContain('action-buttons-click-continued')
    },
    20_000,
  )

  test(
    'manual thread message dismisses pending action buttons',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: action-button-dismiss-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: action-button-dismiss-setup'
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

      const currentSessionId = await getThreadSession(thread.id)
      if (!currentSessionId) {
        throw new Error('Expected thread session id before showing action buttons')
      }

      const channel = await ctx.botClient.channels.fetch(thread.id)
      if (!channel || !channel.isThread()) {
        throw new Error('Expected Discord thread channel for action button test')
      }

      await showActionButtons({
        thread: channel,
        sessionId: currentSessionId,
        directory: ctx.directories.projectDirectory,
        buttons: [{ label: 'Dismiss me', color: 'white' }],
      })

      await waitForPendingActionButtons({
        threadId: thread.id,
        timeoutMs: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: post-dismiss-user-message',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'Buttons dismissed.',
        timeout: 4_000,
      })

      await waitForNoPendingActionButtons({
        threadId: thread.id,
        timeoutMs: 4_000,
      })

      const timeline = await th.text({ showInteractions: true })
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (queue-action-tester)
        Reply with exactly: action-button-dismiss-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        **Action Required**
        _Buttons dismissed._
        --- from: user (queue-action-tester)
        Reply with exactly: post-dismiss-user-message"
      `)
      expect(timeline).toContain('_Buttons dismissed._')
      expect(timeline).toContain('post-dismiss-user-message')
    },
    20_000,
  )
})
