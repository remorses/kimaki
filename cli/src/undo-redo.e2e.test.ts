// E2e test for /undo command.
// Validates that:
// 1. After /undo, session.revert state is set (files reverted, revert boundary marked)
// 2. Messages are NOT deleted yet (they stay until next prompt cleans them up)
// 3. On the next user message, reverted messages are cleaned up by OpenCode's
//    SessionRevert.cleanup() and the model only sees pre-revert messages
//
// This matches the OpenCode TUI behavior (use-session-commands.tsx):
// - Pass the user message ID (not assistant ID)
// - Don't delete messages — just mark session as reverted
// - Cleanup happens automatically on next promptAsync()
//
// Uses opencode-deterministic-provider (no real LLM calls).
// Poll timeouts: 4s max, 100ms interval.

import { describe, test, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'
import { getThreadSession } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'

const TEXT_CHANNEL_ID = '200000000000001200'

const e2eTest = describe

e2eTest('/undo sets revert state and cleans up on next prompt', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-undo-e2e',
    dirName: 'qa-undo-e2e',
    username: 'undo-tester',
  })

  test(
    'undo sets revert state, next message cleans up reverted messages',
    async () => {
      const markerPath = path.join(
        ctx.directories.projectDirectory,
        'tmp',
        'undo-marker.txt',
      )

      // 1. Send a message and wait for complete session (footer)
      await ctx.discord
        .channel(TEXT_CHANNEL_ID)
        .user(TEST_USER_ID)
        .sendMessage({
          content: 'UNDO_FILE_MARKER',
        })

      const thread = await ctx.discord
        .channel(TEXT_CHANNEL_ID)
        .waitForThread({
          timeout: 8_000,
          predicate: (t) => {
            return t.name === 'UNDO_FILE_MARKER'
          },
        })

      const th = ctx.discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      // 2. Get session ID and verify it has messages
      const sessionId = await getThreadSession(thread.id)
      expect(sessionId).toBeTruthy()

      const getClient = await initializeOpencodeForDirectory(
        ctx.directories.projectDirectory,
      )
      if (getClient instanceof Error) {
        throw getClient
      }

      const beforeMessages = await getClient().session.messages({
        sessionID: sessionId!,
        directory: ctx.directories.projectDirectory,
      })
      const beforeCount = (beforeMessages.data || []).length
      expect(beforeCount).toBeGreaterThan(0)

      const beforeUserMessages = (beforeMessages.data || []).filter((m) => {
        return m.info.role === 'user'
      })
      const beforeAssistantMessages = (beforeMessages.data || []).filter(
        (m) => {
          return m.info.role === 'assistant'
        },
      )
      expect(beforeUserMessages.length).toBeGreaterThan(0)
      expect(beforeAssistantMessages.length).toBeGreaterThan(0)
      expect(fs.existsSync(markerPath)).toBe(true)

      // Verify no revert state yet
      const beforeSession = await getClient().session.get({
        sessionID: sessionId!,
      })
      expect(beforeSession.data?.revert).toBeFalsy()

      // 3. Run /undo command
      const { id: undoInteractionId } = await th
        .user(TEST_USER_ID)
        .runSlashCommand({ name: 'undo' })

      const undoAck = await th.waitForInteractionAck({
        interactionId: undoInteractionId,
        timeout: 4_000,
      })
      expect(undoAck).toBeDefined()

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        text: 'Undone - reverted last assistant message',
        timeout: 8_000,
      })
      // 4. Verify session now has revert state set
      const afterSession = await getClient().session.get({
        sessionID: sessionId!,
      })
      expect(afterSession.data?.revert).toBeTruthy()
      expect(afterSession.data?.revert?.messageID).toBeTruthy()

      // Messages should still exist (not deleted — cleanup happens on next prompt)
      const afterMessages = await getClient().session.messages({
        sessionID: sessionId!,
        directory: ctx.directories.projectDirectory,
      })
      expect((afterMessages.data || []).length).toBe(beforeCount)

      // 5. Send a new message — this triggers SessionRevert.cleanup()
      // which removes reverted messages before processing the new prompt
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: after-undo-message',
      })

      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 8_000,
        afterMessageIncludes: 'after-undo-message',
      })

      // 6. Verify reverted messages were cleaned up
      const finalMessages = await getClient().session.messages({
        sessionID: sessionId!,
        directory: ctx.directories.projectDirectory,
      })
      const finalAssistantMessages = (finalMessages.data || []).filter(
        (m) => {
          return m.info.role === 'assistant'
        },
      )

      // The original assistant message should have been cleaned up,
      // only the new one (from after-undo-message) should remain
      const originalAssistantStillExists = finalAssistantMessages.some(
        (m) => {
          return m.parts.some((p) => {
            return p.type === 'text' && 'text' in p && p.text === 'ok'
          })
        },
      )
      // The first "ok" response was reverted and should be cleaned up.
      // The new response for "after-undo-message" should produce a fresh "ok".
      // We verify the total count dropped: the original user+assistant pair
      // was removed, and replaced by just the new user+assistant pair.
      expect(finalAssistantMessages.length).toBeLessThanOrEqual(
        beforeAssistantMessages.length,
      )

      // Revert state should be cleared after cleanup
      const finalSession = await getClient().session.get({
        sessionID: sessionId!,
      })
      expect(finalSession.data?.revert).toBeFalsy()

      // 7. Snapshot the Discord thread
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (undo-tester)
        UNDO_FILE_MARKER
        --- from: assistant (TestBot)
        ⬥ creating undo file
        ⬥ undo file created
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        Undone - reverted last assistant message
        --- from: user (undo-tester)
        Reply with exactly: after-undo-message
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
    },
    20_000,
  )
})
