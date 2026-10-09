// First start in gateway mode (the twin plays gateway-proxy): the bot creates
// the default channel with an onboarding thread, the onboarding session adds a
// project channel with `kimaki project add` (real CLI process, run by the
// agent's shell tool, reading the saved gateway credentials), and the new
// channel answers without a bot restart.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { API } from '@discordjs/core/http-only'
import { ChannelType } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { kimakiShellCommand, runOnboarding } from './onboarding.ts'
import {
  TEST_USER_ID,
  scriptedTurn,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitFor,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string
let kimaki: string
let otherProject: string

beforeAll(async () => {
  dataDir = tempDataDir()
  twin = await startTwin({ gateway: true })
  const require = createRequire(import.meta.url)
  kimaki = kimakiShellCommand({
    command: [process.execPath, require.resolve('tsx/cli'), path.join(import.meta.dirname, 'cli.ts')],
  })
  otherProject = path.join(dataDir, 'other-project')
  fs.mkdirSync(otherProject)
  execFileSync('git', ['init', '-q'], { cwd: otherProject })
  server = await startOpencodeTestServer({
    matchers: [
      {
        id: 'onboarding-greeting',
        priority: 50,
        when: { latestUserTextIncludes: 'This is the Kimaki onboarding thread' },
        then: { parts: textParts('Want channels for your projects? I can search for git repositories.') },
      },
      ...scriptedTurn({
        marker: 'add-other-project',
        steps: [
          {
            id: 'call-project-add',
            tool: 'shell',
            input: { command: `${kimaki} project add ${otherProject}`, description: 'add project channel' },
          },
        ],
        finalText: 'Added the channel for other-project.',
      }),
    ],
  })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
}, 120_000)

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function guildChannels() {
  const channels = await new API(bot.discord.rest).guilds.getChannels(twin.discord.guildId)
  const names = new Map(channels.map((channel) => [channel.id, channel.name]))
  return channels.map((channel) => {
    const parent = channel.parent_id ? names.get(channel.parent_id) : null
    return `${channel.name}${parent ? ` (in ${parent})` : ''}`
  })
}

test('onboarding thread adds a project channel through the kimaki CLI, which answers at once', async () => {
  const { discord } = twin
  const guild = bot.discord.guilds.cache.get(discord.guildId)!
  const onboarded = await runOnboarding({ bot, dataDir, guild, kimaki, gateway: true, installerId: TEST_USER_ID, machine: 'test-machine' })
  if (!onboarded || onboarded instanceof Error) throw new Error(`onboarding failed: ${onboarded?.message}`, { cause: onboarded })
  await waitForFooter({ discord, threadId: onboarded.threadId })

  await discord.thread(onboarded.threadId).user(TEST_USER_ID).sendMessage({ content: 'yes, add-other-project' })
  await waitForFooter({ discord, threadId: onboarded.threadId, count: 2 })

  expect(await discord.channel(onboarded.channelId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    **Kimaki** lets you code from Discord. Each project channel is linked to a folder on your computer. A message there starts an AI coding session in that folder.
    Reply in the thread below to add channels for your projects. <@200000000000000001>"
  `)
  expect(await discord.thread(onboarded.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    **Kimaki** lets you code from Discord. Each project channel is linked to a folder on your computer. A message there starts an AI coding session in that folder.
    Reply in the thread below to add channels for your projects. <@200000000000000001>
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Want channels for your projects? I can search for git repositories.
    -# *kimaki ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    yes, add-other-project
    --- from: assistant (TestBot)
    -# ┣ shell _add project channel_

    Added the channel for other-project.
    -# *kimaki ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(await guildChannels()).toMatchInlineSnapshot(`
    [
      "project",
      "random",
      "quiet",
      "Kimaki test-machine",
      "kimaki (in Kimaki test-machine)",
      "other-project (in Kimaki test-machine)",
    ]
  `)

  const rows = await bot.db.query.channel_directories.findMany({ orderBy: { created_at: 'asc' } })
  expect(rows.map((row) => path.relative(dataDir, row.directory))).toMatchInlineSnapshot(`
    [
      "projects/kimaki",
      "other-project",
    ]
  `)

  // The new channel answers without restarting the bot.
  const added = rows.find((row) => row.directory === otherProject)!
  await discord.channel(added.channel_id).user(TEST_USER_ID).sendMessage({ content: 'hello new channel' })
  const thread = await discord.channel(added.channel_id).waitForThread({ timeout: 8_000 })
  await waitForFooter({ discord, threadId: thread.id })

  // Second start: nothing is created again.
  expect(await runOnboarding({ bot, dataDir, guild, kimaki, gateway: true, machine: 'test-machine' })).toBe(null)
  await waitFor({ label: 'no extra channels', check: async () => (await guildChannels()).length === 6 })

  // An empty default channel means an earlier onboarding failed: retry in the same channel.
  const defaultChannel = rows.find((row) => row.directory !== otherProject)!
  const channel = await bot.discord.channels.fetch(defaultChannel.channel_id)
  if (channel?.type !== ChannelType.GuildText) throw new Error('default channel is not a text channel')
  for (const message of (await channel.messages.fetch()).values()) await message.delete()
  const retried = await runOnboarding({ bot, dataDir, guild, kimaki, gateway: true, installerId: TEST_USER_ID, machine: 'test-machine' })
  if (retried instanceof Error || !retried) throw new Error(`expected a retried onboarding, got ${retried}`)
  expect(retried.channelId).toBe(defaultChannel.channel_id)
  await waitForFooter({ discord, threadId: retried.threadId })
  expect((await guildChannels()).length).toBe(6)
}, 30_000)

test('an upgraded setup with project mappings skips onboarding without selecting a server', async () => {
  const before = await guildChannels()
  expect(await runOnboarding({
    bot,
    dataDir: path.join(dataDir, 'upgraded-layout'),
    kimaki,
    gateway: true,
    machine: 'test-machine',
  })).toBe(null)
  expect(await guildChannels()).toEqual(before)
})
