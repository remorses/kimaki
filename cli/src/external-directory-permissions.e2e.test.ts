// E2e test for the default external_directory permission: every directory is
// allowed, so reading a file outside the project never shows a permission
// prompt. The old behaviour (allow-list + prompt) is now opt-in behind the
// --restrict-directories CLI flag.

import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import {
  EXTERNAL_DIRECTORY_PROBE_DIR,
  EXTERNAL_DIRECTORY_PROBE_FILE,
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001021'

describe('external directory permissions', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-external-directory-e2e',
    dirName: 'qa-external-directory-e2e',
    username: 'external-directory-tester',
  })

  test('reads outside the project without a permission prompt', async () => {
    fs.mkdirSync(EXTERNAL_DIRECTORY_PROBE_DIR, { recursive: true })
    fs.writeFileSync(EXTERNAL_DIRECTORY_PROBE_FILE, 'external directory file')

    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'EXTERNAL_DIRECTORY_PROBE_MARKER first',
    })

    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => {
        return t.name?.includes('EXTERNAL_DIRECTORY_PROBE_MARKER') ?? false
      },
    })
    const th = ctx.discord.thread(thread.id)

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'external-directory-probe-done',
      timeout: 8_000,
    })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 4_000,
      afterMessageIncludes: 'external-directory-probe-done',
      afterAuthorId: ctx.discord.botUserId,
    })

    await th.user(TEST_USER_ID).sendMessage({
      content: 'EXTERNAL_DIRECTORY_PROBE_MARKER followup',
    })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'external-directory-probe-done',
      afterUserMessageIncludes: 'followup',
      timeout: 8_000,
    })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 4_000,
      afterMessageIncludes: 'external-directory-probe-done',
      afterAuthorId: ctx.discord.botUserId,
    })

    const text = await th.text()
    expect(text).toMatchInlineSnapshot(`
      "--- from: user (external-directory-tester)
      EXTERNAL_DIRECTORY_PROBE_MARKER first
      --- from: assistant (TestBot)
      *using deterministic-provider/deterministic-v2*
      ⬥ reading external directory
      ┣ read *probe.txt*
      ⬥ external-directory-probe-done
      *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
      --- from: user (external-directory-tester)
      EXTERNAL_DIRECTORY_PROBE_MARKER followup
      --- from: assistant (TestBot)
      ⬥ reading external directory
      ┣ read *probe.txt*
      ⬥ external-directory-probe-done
      *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
    `)
    expect(text).not.toContain('Permission Required')
  })
})
