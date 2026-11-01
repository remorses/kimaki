// Phase 1: a channel message creates a thread and a session, the reply and a
// footer appear, and follow-ups continue the same session.

import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { MessageFlags } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { sessionEventsFile } from './session-events.ts'
import {
  OTHER_USER_ID,
  TEST_USER_ID,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
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
let helloThreadId: string

const MEDIA_URL = 'https://cdn.discordapp.com/attachments/1012345678900020080/1234567891233211234/shot.png?ex=65d903de&is=65c68ede&hm=2481f30d&'

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({
      matchers: [
        {
          id: 'hello',
          when: { latestUserTextIncludes: 'hello-marker' },
          then: {
            parts: [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'Hello from the deterministic model.' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ],
          },
        },
        {
          // The thread name (in the per-turn context) still contains hello-marker.
          id: 'follow-up',
          priority: 10,
          when: { latestUserTextIncludes: 'second-marker' },
          then: {
            parts: [
              { type: 'text-start', id: 't2' },
              { type: 'text-delta', id: 't2', delta: 'Second answer, same session.' },
              { type: 'text-end', id: 't2' },
              { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ],
          },
        },
        {
          id: 'media',
          priority: 10,
          when: { latestUserTextIncludes: 'media-marker' },
          then: {
            parts: [
              { type: 'text-start', id: 't3' },
              { type: 'text-delta', id: 't3', delta: `Here is the screenshot: ${MEDIA_URL}` },
              { type: 'text-end', id: 't3' },
              { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ],
          },
        },
      ],
    }),
    startTwin(),
  ])
  await seedProjectChannel({
    dataDir,
    channelId: twin.channelId,
    guildId: twin.discord.guildId,
    directory: server.projectDirectory,
  })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// Polls for 200ms that no new thread appears in the channel.
async function expectNoNewThread({ channelId, before }: { channelId: string; before: number }) {
  for (let index = 0; index < 10; index++) {
    await sleep(20)
    const threads = await twin.discord.channel(channelId).getThreads()
    expect(threads.length).toBe(before)
  }
}

test('channel message creates a thread with reply and footer, follow-up continues the session', async () => {
  const { discord, channelId } = twin
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Say hello hello-marker' })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000 })
  helloThreadId = thread.id
  await waitForFooter({ discord, threadId: thread.id })

  await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'Again please second-marker' })
  await waitForFooter({ discord, threadId: thread.id, count: 2 })

  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Say hello hello-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Hello from the deterministic model.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    Again please second-marker
    --- from: assistant (TestBot)
    Second answer, same session.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(thread.name).toBe('Say hello hello-marker')

  // Like V1: bot messages hide link previews; only the footer notifies.
  const messages = await discord.thread(thread.id).getMessages()
  const flags = messages
    .filter((message) => message.author.bot)
    .map((message) => ({
      text: message.content.slice(0, 20),
      suppressEmbeds: Boolean((message.flags ?? 0) & MessageFlags.SuppressEmbeds),
      silent: Boolean((message.flags ?? 0) & MessageFlags.SuppressNotifications),
    }))
  expect(flags).toMatchInlineSnapshot(`
    [
      {
        "silent": true,
        "suppressEmbeds": true,
        "text": "-# *using determinis",
      },
      {
        "silent": true,
        "suppressEmbeds": true,
        "text": "Hello from the deter",
      },
      {
        "silent": false,
        "suppressEmbeds": true,
        "text": "-# *main ⋅ <1s ⋅ 0% ",
      },
      {
        "silent": true,
        "suppressEmbeds": true,
        "text": "Second answer, same ",
      },
      {
        "silent": false,
        "suppressEmbeds": true,
        "text": "-# *main ⋅ <1s ⋅ 0% ",
      },
    ]
  `)

  const rows = await bot.db.query.thread_sessions.findMany()
  expect(rows.map((row) => ({ thread: row.thread_id === thread.id, source: row.source }))).toEqual([
    { thread: true, source: 'kimaki' },
  ])

  // Posted to Discord, so OpenCode clients (TUI tabs, app) no longer show it unread.
  const session = await waitFor({
    label: 'session marked viewed',
    check: async () => {
      const info = await bot.opencode.endpoint!.client.session.get({ sessionID: rows[0]!.session_id })
      return info.time.viewed !== undefined && info.time.viewed === info.time.idle && info
    },
  })
  expect(session.time.idle).toBeGreaterThan(0)
})

test('a reply with a Discord media URL keeps its embed, other lines stay suppressed', async () => {
  const { discord, channelId } = twin
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Show the shot media-marker' })
  const thread = await discord.channel(channelId).waitForThread({ predicate: (thread) => thread.name?.startsWith('Show the shot') ?? false })
  await waitForFooter({ discord, threadId: thread.id })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Show the shot media-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Here is the screenshot: https://cdn.discordapp.com/attachments/1012345678900020080/1234567891233211234/shot.png?ex=65d903de&is=65c68ede&hm=2481f30d&
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)

  const messages = await discord.thread(thread.id).getMessages()
  const flags = messages
    .filter((message) => message.author.bot)
    .map((message) => ({
      text: message.content.slice(0, 20),
      suppressEmbeds: Boolean((message.flags ?? 0) & MessageFlags.SuppressEmbeds),
    }))
  expect(flags).toMatchInlineSnapshot(`
    [
      {
        "suppressEmbeds": true,
        "text": "-# *using determinis",
      },
      {
        "suppressEmbeds": false,
        "text": "Here is the screensh",
      },
      {
        "suppressEmbeds": true,
        "text": "-# *main ⋅ <1s ⋅ 0% ",
      },
    ]
  `)
})

test('message from a user without permission creates no thread', async () => {
  const { discord, channelId } = twin
  const before = (await discord.channel(channelId).getThreads()).length
  await discord.channel(channelId).user(OTHER_USER_ID).sendMessage({ content: 'let me in hello-marker' })
  await expectNoNewThread({ channelId, before })
})

test('another bot needs the Kimaki role, and no-kimaki still denies it', async () => {
  const { discord, channelId } = twin
  const helperBotId = '200000000000000050'
  const guildId = discord.guildId
  await discord.prisma.user.create({ data: { id: helperBotId, username: 'helper-bot', bot: true } })
  await discord.prisma.guildMember.create({ data: { guildId, userId: helperBotId } })
  const member = { guildId_userId: { guildId, userId: helperBotId } }
  const helper = discord.channel(channelId).user(helperBotId)

  const before = (await discord.channel(channelId).getThreads()).length
  await helper.sendMessage({ content: 'no role bot-marker hello-marker' })
  await expectNoNewThread({ channelId, before })

  const guild = await bot.discord.guilds.fetch(guildId)
  const kimakiRole = await guild.roles.create({ name: 'Kimaki' })
  const denyRole = await guild.roles.create({ name: 'no-kimaki' })
  await discord.prisma.guildMember.update({ where: member, data: { roles: JSON.stringify([kimakiRole.id]) } })
  await helper.sendMessage({ content: 'with role bot-marker hello-marker' })
  const thread = await discord.channel(channelId).waitForThread({ predicate: (thread) => thread.name?.startsWith('with role bot-marker') ?? false })
  await waitForFooter({ discord, threadId: thread.id })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: assistant (helper-bot)
    with role bot-marker hello-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Hello from the deterministic model.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)

  const withRole = (await discord.channel(channelId).getThreads()).length
  await discord.prisma.guildMember.update({ where: member, data: { roles: JSON.stringify([kimakiRole.id, denyRole.id]) } })
  await helper.sendMessage({ content: 'denied bot-marker hello-marker' })
  await expectNoNewThread({ channelId, before: withRole })
})

test('message in a channel without a project creates no thread', async () => {
  const { discord, unregisteredChannelId } = twin
  await discord.channel(unregisteredChannelId).user(TEST_USER_ID).sendMessage({ content: 'hello-marker' })
  await expectNoNewThread({ channelId: unregisteredChannelId, before: 0 })
})

test('/session-id shows the session, thread and attach command; events are recorded per thread', async () => {
  const { discord } = twin
  const [binding] = await bot.db.query.thread_sessions.findMany({ where: { thread_id: helloThreadId } })
  const { id: interactionId } = await discord.thread(helloThreadId).user(TEST_USER_ID).runSlashCommand({ name: 'session-id' })
  await discord.thread(helloThreadId).waitForInteractionAck({ interactionId, timeout: 4_000 })
  const response = await discord.thread(helloThreadId).getInteractionResponse(interactionId)
  const content = (JSON.parse(response?.data ?? '{}') as { content?: string }).content ?? ''
  const redacted = content
    .replaceAll(binding!.session_id, 'ses_X')
    .replaceAll(helloThreadId, 'THREAD')
    .replaceAll(server.projectDirectory, 'PROJECT')
  expect(redacted).toMatchInlineSnapshot(`
    "**Session ID:** \`ses_X\`
    **Thread ID:** \`THREAD\`
    **Attach command:**
    \`\`\`bash
    opencode PROJECT --session ses_X
    \`\`\`"
  `)

  const lines = fs.readFileSync(sessionEventsFile({ dataDir, threadId: helloThreadId }), 'utf8').trim().split('\n')
  const types = lines.map((line) => (JSON.parse(line) as { event: { type: string } }).event.type)
  expect([...new Set(types)].sort()).toMatchInlineSnapshot(`
    [
      "session.execution.started",
      "session.execution.succeeded",
      "session.inbox.delivered",
      "session.inbox.enqueued",
      "session.instructions.updated",
      "session.step.ended",
      "session.step.started",
      "session.text.ended",
      "session.text.started",
      "session.usage.updated",
      "session.viewed",
    ]
  `)
})
