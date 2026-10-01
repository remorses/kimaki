// OpenCode loads agents lazily: user agents missing at startup get their
// /<agent>-agent command when agent.updated arrives.

import fs from 'node:fs'
import path from 'node:path'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitForFooter,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const matchers: DeterministicMatcher[] = [
  { id: 'late', priority: 500, when: { latestUserTextIncludes: 'late-marker' }, then: { parts: textParts('late reply') } },
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers, agents: { late: { description: 'Late agent', mode: 'primary' } } }), startTwin()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function registeredNames() {
  const commands = await twin.discord.getRegisteredCommands()
  return commands.map((command) => command.name)
}

test('agents loaded after startup get their slash commands', async () => {
  // A cold OpenCode has no user agents when the bot first registers commands;
  // agent.updated fires when the catalog finishes loading; the refresh follows it.
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && !(await registeredNames()).includes('late-agent')) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  expect(await registeredNames()).toContain('late-agent')

  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord
    .channel(channelId)
    .user(TEST_USER_ID)
    .runSlashCommand({ name: 'late-agent', options: [{ name: 'prompt', type: 3, value: 'Go late-marker' }] })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (found) => !before.has(found.id) })
  await waitForFooter({ discord, threadId: thread.id })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **tommy:** Go late-marker
    -# *using deterministic-provider/deterministic-v2 ⋅ late*
    late reply
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ late*"
  `)
})
