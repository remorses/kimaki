// E2e tests for typing indicator behavior around permission prompts.

import { describe, test, expect } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'
import { pendingPermissions } from './session-handler/thread-session-runtime.js'

const TEXT_CHANNEL_ID = '200000000000001005'

async function waitForPendingPermission({
  threadId,
  timeoutMs,
}: {
  threadId: string
  timeoutMs: number
}): Promise<{ contextHash: string; messageId: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const threadPermissions = pendingPermissions.get(threadId)
    const firstPermission = threadPermissions ? [...threadPermissions.values()][0] : undefined
    if (firstPermission?.contextHash && firstPermission.messageId) {
      return {
        contextHash: firstPermission.contextHash,
        messageId: firstPermission.messageId,
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error('Timed out waiting for pending permission context')
}

describe('queue advanced: typing around permissions', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-permission-typing-e2e',
    dirName: 'qa-permission-typing-e2e',
    username: 'queue-permission-tester',
  })

  test(
    'permission prompt pauses typing until user click, then typing resumes for long follow-up step',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'PERMISSION_TYPING_MARKER',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'PERMISSION_TYPING_MARKER'
        },
      })

      const th = ctx.discord.thread(thread.id)

      await th.waitForTypingEvent({ timeout: 1_000 })

      const pending = await waitForPendingPermission({
        threadId: thread.id,
        timeoutMs: 4_000,
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Permission Required',
        timeout: 4_000,
      })

      th.clearTypingEvents()

      await th.waitForTypingEvent({ timeout: 2_000 }).then(
        () => {
          throw new Error('Typing should stay paused while permission UI is pending')
        },
        () => {
          return undefined
        },
      )

      const interaction = await th.user(TEST_USER_ID).clickButton({
        messageId: pending.messageId,
        customId: `permission_once:${pending.contextHash}`,
      })

      await th.waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 4_000,
      })

      const resumedTyping = await th.waitForTypingEvent({ timeout: 9_000 })
      expect(resumedTyping).toBeDefined()

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'permission-flow-done',
        timeout: 12_000,
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 12_000,
        afterMessageIncludes: 'permission-flow-done',
        afterAuthorId: ctx.discord.botUserId,
      })

      const timeline = await th.text({
        showTyping: true,
        showInteractions: true,
      })
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (queue-permission-tester)
        PERMISSION_TYPING_MARKER
        --- from: assistant (TestBot)
        ⚠️ **Permission Required**
        **Type:** \`external_directory\`
        **Pattern:** \`/Users/morse/*\`
        ✅ Permission **accepted**
        ⬥ requesting external read permission
        [user clicks button]
        [bot typing]
        ⬥ permission-flow-done
        [bot typing]
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
    },
    20_000,
  )
})
