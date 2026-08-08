// Regression test: a `deny` rule in the project's own opencode.json must still
// win over kimaki's allow-all default.
//
// This guards a real bug. opencode evaluates permissions with findLast() over
// merge(agent.permission, session.permission), so session rules are evaluated
// LAST and override user config. An earlier version of the allow-all default
// put `external_directory: '*' allow` into the session ruleset, which silently
// made every user `deny` rule a no-op. The allow now lives in the generated
// server config instead, where the project opencode.json deep-merges on top.

import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import {
  EXTERNAL_DIRECTORY_PROBE_DIR,
  EXTERNAL_DIRECTORY_PROBE_FILE,
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining } from './test-utils.js'

const TEXT_CHANNEL_ID = '200000000000001023'

describe('external directory project deny', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: TEXT_CHANNEL_ID,
    channelName: 'qa-external-directory-deny-e2e',
    dirName: 'qa-external-directory-deny-e2e',
    username: 'external-directory-deny-tester',
    // Exactly what a user would write in their own opencode.json to protect a
    // folder. Kimaki's generated config allows '*', this must still beat it.
    projectPermission: {
      external_directory: {
        [EXTERNAL_DIRECTORY_PROBE_DIR]: 'deny',
        [`${EXTERNAL_DIRECTORY_PROBE_DIR}/*`]: 'deny',
      },
    },
  })

  test('project opencode.json deny beats the allow-all default', async () => {
    fs.mkdirSync(EXTERNAL_DIRECTORY_PROBE_DIR, { recursive: true })
    fs.writeFileSync(EXTERNAL_DIRECTORY_PROBE_FILE, 'protected file')

    await ctx.discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'EXTERNAL_DIRECTORY_PROBE_MARKER denied',
    })

    const thread = await ctx.discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => {
        return t.name?.includes('EXTERNAL_DIRECTORY_PROBE_MARKER') ?? false
      },
    })
    const th = ctx.discord.thread(thread.id)

    // The deterministic matcher only emits this after the read comes back
    // rejected by a permission rule, so seeing it proves the deny applied.
    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'external-directory-probe-denied',
      timeout: 8_000,
    })

    const text = await th.text()
    expect(text).toMatchInlineSnapshot(`
      "--- from: user (external-directory-deny-tester)
      EXTERNAL_DIRECTORY_PROBE_MARKER denied
      --- from: assistant (TestBot)
      *using deterministic-provider/deterministic-v2*
      ⬥ reading external directory
      ┣ read *probe.txt*
      ⬥ external-directory-probe-denied"
    `)

    // A deny is silent: it must not fall back to asking the user.
    expect(text).not.toContain('Permission Required')
    // And the read must not have succeeded, which is what the old
    // session-level '*' allow rule caused.
    expect(text).not.toContain('external-directory-probe-done')
  })
})
