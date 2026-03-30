// E2e tests for thread-scoped external directory preapproval via /add-directory.

import { describe, expect, test } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001014'

describe('/add-directory', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'add-directory-e2e',
    dirName: 'add-directory-e2e',
    username: 'add-directory-tester',
  })

  test(
    'preapproves external directory access for the current thread',
    async () => {
      await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: add-directory-setup',
      })

      const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (candidate) => {
          return candidate.name === 'Reply with exactly: add-directory-setup'
        },
      })
      const th = ctx.discord.thread(thread.id)

      await th.waitForBotReply({ timeout: 4_000 })
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      const slashCommand = await th.user(TEST_USER_ID).runSlashCommand({
        name: 'add-directory',
        options: [{ name: 'path', type: 3, value: '/Users/morse' }],
      })
      await th.waitForInteractionAck({
        interactionId: slashCommand.id,
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'PERMISSION_TYPING_MARKER add-directory-flow first',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'permission-flow-done',
        timeout: 8_000,
      })
      await waitForFooterMessage({
        discord: ctx.discord,
        threadId: thread.id,
        timeout: 12_000,
        afterMessageIncludes: 'permission-flow-done',
        afterAuthorId: ctx.discord.botUserId,
      })

      for (let attempt = 0; attempt < 10; attempt++) {
        const messages = await th.getMessages()
        const hasPermissionPrompt = messages.some((message) => {
          return message.content.includes('Permission Required')
        })
        expect(hasPermissionPrompt).toBe(false)
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20)
        })
      }

      await th.user(TEST_USER_ID).sendMessage({
        content: 'PERMISSION_TYPING_MARKER add-directory-flow second',
      })

      await waitForBotMessageContaining({
        discord: ctx.discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Permission Required',
        timeout: 8_000,
      })

      const timeline = await th.text()
      expect(timeline).toMatchInlineSnapshot(`
        "--- from: user (add-directory-tester)
        Reply with exactly: add-directory-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        Directory preapproved for the next message in this thread.
        \`/Users/morse\`
        Kimaki will auto-accept matching external directory requests for \`/Users/morse/*\` during the next run only.
        --- from: user (add-directory-tester)
        PERMISSION_TYPING_MARKER add-directory-flow first
        --- from: assistant (TestBot)
        ⬥ requesting external read permission
        ⬥ permission-flow-done
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (add-directory-tester)
        PERMISSION_TYPING_MARKER add-directory-flow second
        --- from: assistant (TestBot)
        ⚠️ **Permission Required**
        **Type:** \`external_directory\`
        Agent is accessing files outside the project. [Learn more](https://opencode.ai/docs/permissions/#external-directories)
        **Pattern:** \`/Users/morse/*\`
        ⬥ requesting external read permission"
      `)
    },
    20_000,
  )
})
