// E2e tests for granting external_directory permissions from #channel references.

import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import {
  CHANNEL_REFERENCE_EXTERNAL_DIR,
  CHANNEL_REFERENCE_EXTERNAL_FILE,
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { setChannelDirectory } from './database.js'
import {
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001021'
const EXTERNAL_CHANNEL_ID = '200000000000001022'

describe('channel reference permissions', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-channel-reference-e2e',
    extraChannels: [{ id: EXTERNAL_CHANNEL_ID, name: 'external-project' }],
    dirName: 'qa-channel-reference-e2e',
    username: 'channel-reference-tester',
  })

  test('allows referenced project channel directories on new and existing sessions', async () => {
    fs.mkdirSync(CHANNEL_REFERENCE_EXTERNAL_DIR, { recursive: true })
    fs.writeFileSync(CHANNEL_REFERENCE_EXTERNAL_FILE, 'referenced channel file')
    await setChannelDirectory({
      channelId: EXTERNAL_CHANNEL_ID,
      directory: CHANNEL_REFERENCE_EXTERNAL_DIR,
      channelType: 'text',
    })

    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: `Use <#${EXTERNAL_CHANNEL_ID}> CHANNEL_REFERENCE_PERMISSION_MARKER first`,
    })

    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => {
        return t.name?.includes('CHANNEL_REFERENCE_PERMISSION_MARKER') ?? false
      },
    })
    const th = ctx.discord.thread(thread.id)

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'channel-reference-read-done',
      timeout: 8_000,
    })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 4_000,
      afterMessageIncludes: 'channel-reference-read-done',
      afterAuthorId: ctx.discord.botUserId,
    })

    await th.user(TEST_USER_ID).sendMessage({
      content: `Use <#${EXTERNAL_CHANNEL_ID}> CHANNEL_REFERENCE_PERMISSION_MARKER followup`,
    })
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'channel-reference-read-done',
      afterUserMessageIncludes: 'followup',
      timeout: 8_000,
    })
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 4_000,
      afterMessageIncludes: 'channel-reference-read-done',
      afterAuthorId: ctx.discord.botUserId,
    })

    const text = await th.text()
    expect(text).toMatchInlineSnapshot(`
      "--- from: user (channel-reference-tester)
      Use <#200000000000001022> CHANNEL_REFERENCE_PERMISSION_MARKER first
      --- from: assistant (TestBot)
      *using deterministic-provider/deterministic-v2*
      ⬥ reading referenced channel directory
      ⬥ channel-reference-read-done
      *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
      --- from: user (channel-reference-tester)
      Use <#200000000000001022> CHANNEL_REFERENCE_PERMISSION_MARKER followup
      --- from: assistant (TestBot)
      ⬥ reading referenced channel directory
      ⬥ channel-reference-read-done
      *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
    `)
    expect(text).not.toContain('Permission Required')
  })
})
