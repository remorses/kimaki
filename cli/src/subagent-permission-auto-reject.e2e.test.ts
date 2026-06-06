// E2e regression test for auto-rejecting permission requests created inside task subagents.

import { describe, expect, test } from 'vitest'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001023'

describe('subagent permission auto-reject', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-subagent-permission-e2e',
    dirName: 'qa-subagent-permission-e2e',
    username: 'subagent-permission-tester',
  })

  test('rejects permission requests from task subagent sessions without user interaction', async () => {
    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'SUBAGENT_PERMISSION_AUTO_REJECT_MARKER',
    })

    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => {
        return t.name === 'SUBAGENT_PERMISSION_AUTO_REJECT_MARKER'
      },
    })

    const th = ctx.discord.thread(thread.id)

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'subagent-permission-auto-reject-done',
      timeout: 12_000,
    })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 4_000,
      afterMessageIncludes: 'subagent-permission-auto-reject-done',
      afterAuthorId: ctx.discord.botUserId,
    })

    const text = await th.text()
    expect(text).toMatchInlineSnapshot(`
      "--- from: user (subagent-permission-tester)
      SUBAGENT_PERMISSION_AUTO_REJECT_MARKER
      --- from: assistant (TestBot)
      *using deterministic-provider/deterministic-v2*
      ⬦ info: Aborting general so the parent task can recover: permission denied (external_directory: /Users/morse/*)
      ⬥ subagent-permission-auto-reject-done
      *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
    `)
    expect(text).not.toContain('Permission Required')
  }, 20_000)
})
