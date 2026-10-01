// /agent, /model, /model-variant and /verbosity. In a session thread they
// switch the session in OpenCode (next step); in a channel they set the
// default for new sessions.

import fs from 'node:fs'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  scriptedTurn,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  waitFor,
  waitForFooter,
  waitForSelectMenu,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const matchers: DeterministicMatcher[] = [
  ...scriptedTurn({
    marker: 'tools-marker',
    steps: [{ id: 'call-shell-1', tool: 'shell', input: { command: 'echo hi', description: 'Say hi', hasSideEffect: true } }],
    finalText: 'tools done',
  }),
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({
      matchers,
      models: {
        'deterministic-thinker': { name: 'Thinker', variants: [{ id: 'low' }, { id: 'high' }] },
        // The default model gets thinking levels too, for `/<agent>-agent variant:`.
        'deterministic-v2': { name: 'deterministic-v2', variants: [{ id: 'fast' }, { id: 'deep' }] },
      },
    }),
    startTwin(),
  ])
  for (const channelId of [twin.channelId, twin.quietChannelId]) {
    await seedProjectChannel({ dataDir, channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  }
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function newThread(channelId: string, content: string) {
  const { discord } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (candidate) => !before.has(candidate.id) })
  await waitForFooter({ discord, threadId: thread.id })
  return thread
}

// Picks `value` in the newest select whose custom ID starts with `prefix`,
// then waits until that message changed.
async function pick({ channelId, prefix, value }: { channelId: string; prefix: string; value: string }) {
  const { discord } = twin
  const { message, select } = await waitForSelectMenu({ discord, channelId, prefix })
  await discord.channel(channelId).user(TEST_USER_ID).selectMenu({ messageId: message.id, customId: select.custom_id, values: [value] })
  await waitFor({
    label: `select ${select.custom_id} handled`,
    check: async () => {
      const current = (await discord.channel(channelId).getMessages()).find((candidate) => candidate.id === message.id)
      return current && current.content !== message.content ? current : null
    },
  })
  return select.options.map((option) => option.label)
}

async function sessionModel(threadId: string) {
  const info = await (await server.client()).session.get({ sessionID: bot.store.getState().roots[threadId]! })
  return { agent: info.agent, model: info.model }
}

test('/agent switches the session agent in a thread and the default in a channel', async () => {
  const { discord, channelId } = twin
  const thread = await newThread(channelId, 'Agent thread')
  await discord.thread(thread.id).user(TEST_USER_ID).runSlashCommand({ name: 'agent' })
  expect(await pick({ channelId: thread.id, prefix: 'agent:', value: 'plan' })).toMatchInlineSnapshot(`
    [
      "Build",
      "Plan",
    ]
  `)
  await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'Next message' })
  await waitForFooter({ discord, threadId: thread.id, count: 2 })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Agent thread
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    Switched to **plan** agent for this session
    The agent changes from the next step.
    --- from: user (tommy)
    Next message
    --- from: assistant (TestBot)
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2 ⋅ plan*"
  `)
  expect((await sessionModel(thread.id)).agent).toBe('plan')

  await discord.channel(twin.quietChannelId).user(TEST_USER_ID).runSlashCommand({ name: 'agent' })
  await pick({ channelId: twin.quietChannelId, prefix: 'agent:', value: 'plan' })
  const planned = await newThread(twin.quietChannelId, 'Uses the channel agent')
  expect((await sessionModel(planned.id)).agent).toBe('plan')
  expect(await discord.channel(twin.quietChannelId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Switched to **plan** agent for this channel
    All new sessions will use this agent.
    --- from: user (tommy)
    Uses the channel agent"
  `)
})

test('/model switches the session model from the next step, /model-variant its thinking level', async () => {
  const { discord, channelId } = twin
  const thread = await newThread(channelId, 'Model thread')
  const user = discord.thread(thread.id).user(TEST_USER_ID)
  await user.runSlashCommand({ name: 'model' })
  expect(await pick({ channelId: thread.id, prefix: 'model:', value: 'deterministic-provider' })).toMatchInlineSnapshot(`
    [
      "Deterministic Provider",
      "OpenCode Zen",
    ]
  `)
  expect(await pick({ channelId: thread.id, prefix: 'model:', value: 'deterministic-thinker' })).toMatchInlineSnapshot(`
    [
      "deterministic-v2",
      "Thinker",
    ]
  `)
  expect(await pick({ channelId: thread.id, prefix: 'model:', value: 'high' })).toMatchInlineSnapshot(`
    [
      "None (default)",
      "low",
      "high",
    ]
  `)
  expect(await pick({ channelId: thread.id, prefix: 'model:', value: 'session' })).toMatchInlineSnapshot(`
    [
      "This session",
      "This channel",
    ]
  `)
  await user.sendMessage({ content: 'With the new model' })
  await waitForFooter({ discord, threadId: thread.id, count: 2 })
  expect(await sessionModel(thread.id)).toMatchInlineSnapshot(`
    {
      "agent": undefined,
      "model": {
        "id": "deterministic-thinker",
        "providerID": "deterministic-provider",
        "variant": "high",
      },
    }
  `)

  await user.runSlashCommand({ name: 'model-variant' })
  expect(await pick({ channelId: thread.id, prefix: 'model:', value: 'low' })).toMatchInlineSnapshot(`
    [
      "None (default)",
      "low",
      "high",
    ]
  `)
  await pick({ channelId: thread.id, prefix: 'model:', value: 'session' })
  expect((await sessionModel(thread.id)).model).toMatchInlineSnapshot(`
    {
      "id": "deterministic-thinker",
      "providerID": "deterministic-provider",
      "variant": "low",
    }
  `)
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Model thread
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    Model set for this session:
    **Deterministic Provider** / **deterministic-thinker** (high)
    \`deterministic-provider/deterministic-thinker (high)\`
    Applies from the next step.
    --- from: user (tommy)
    With the new model
    --- from: assistant (TestBot)
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-thinker*
    Model set for this session:
    **Deterministic Provider** / **deterministic-thinker** (low)
    \`deterministic-provider/deterministic-thinker (low)\`
    Applies from the next step."
  `)
})

test('/model with channel scope sets the model of new sessions', async () => {
  const { discord } = twin
  const channelId = twin.quietChannelId
  await discord.channel(channelId).user(TEST_USER_ID).runSlashCommand({ name: 'model' })
  await pick({ channelId, prefix: 'model:', value: 'deterministic-provider' })
  await pick({ channelId, prefix: 'model:', value: 'deterministic-thinker' })
  await pick({ channelId, prefix: 'model:', value: '__none__' })
  expect(await pick({ channelId, prefix: 'model:', value: 'channel' })).toMatchInlineSnapshot(`
    [
      "This channel",
    ]
  `)
  const thread = await newThread(channelId, 'Channel model')
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Channel model
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-thinker ⋅ plan*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-thinker ⋅ plan*"
  `)
  const row = await bot.db.db.query.channel_models.findFirst({ where: { channel_id: channelId } })
  expect({ model: row?.model_id, variant: row?.variant }).toMatchInlineSnapshot(`
    {
      "model": "deterministic-provider/deterministic-thinker",
      "variant": null,
    }
  `)
})

test('/verbosity applies to running sessions of the channel at once', async () => {
  const { discord, channelId } = twin
  const thread = await newThread(channelId, 'Show tools-marker')
  await discord.channel(channelId).user(TEST_USER_ID).runSlashCommand({ name: 'verbosity' })
  expect(await pick({ channelId, prefix: 'verbosity:', value: 'text' })).toMatchInlineSnapshot(`
    [
      "Text and tools",
      "Text only",
    ]
  `)
  await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'Again tools-marker' })
  await waitForFooter({ discord, threadId: thread.id, count: 2 })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Show tools-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# ┣ shell _Say hi_

    tools done
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    Again tools-marker
    --- from: assistant (TestBot)
    tools done
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Agent thread
    Model thread
    Show tools-marker
    --- from: assistant (TestBot)
    Verbosity set to \`text\` for this channel.
    Text, file edits and errors. Hides the other tools.
    Applies immediately, including active sessions."
  `)
})

test('/<agent>-agent variant: sets the thinking level with the agent, per session or channel', async () => {
  const { discord } = twin
  const channelId = twin.channelId
  const thread = await newThread(channelId, 'Variant thread')
  const user = discord.thread(thread.id).user(TEST_USER_ID)
  expect(await user.autocomplete({ name: 'plan-agent', options: [{ name: 'variant', type: 3, value: 'de' }], focused: 'variant' }))
    .toMatchInlineSnapshot(`
      [
        {
          "name": "deep (deterministic-provider/deterministic-v2)",
          "value": "deep",
        },
      ]
    `)
  await user.runSlashCommand({
    name: 'plan-agent',
    options: [
      { name: 'prompt', type: 3, value: 'Think hard' },
      { name: 'variant', type: 3, value: 'deep' },
    ],
  })
  await waitForFooter({ discord, threadId: thread.id, count: 2 })
  expect(await sessionModel(thread.id)).toMatchInlineSnapshot(`
    {
      "agent": "plan",
      "model": {
        "id": "deterministic-v2",
        "providerID": "deterministic-provider",
        "variant": "deep",
      },
    }
  `)

  const { id } = await user.runSlashCommand({ name: 'build-agent', options: [{ name: 'variant', type: 3, value: 'nope' }] })
  await discord.thread(thread.id).waitForInteractionAck({ interactionId: id })
  await waitFor({ label: 'variant error', check: async () => (await discord.thread(thread.id).text()).includes('no thinking level') })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Variant thread
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    » **tommy:** (plan, deep) Think hard
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2 ⋅ plan*
    \`deterministic-provider/deterministic-v2\` has no thinking level \`nope\`. Available: \`fast\`, \`deep\`"
  `)

  // Channel without a prompt: agent and thinking level for new sessions.
  const ack = await discord.channel(channelId).user(TEST_USER_ID).runSlashCommand({
    name: 'build-agent',
    options: [{ name: 'variant', type: 3, value: 'fast' }],
  })
  await discord.channel(channelId).waitForInteractionAck({ interactionId: ack.id })
  const fresh = await newThread(channelId, 'Uses the channel variant')
  expect(await sessionModel(fresh.id)).toMatchInlineSnapshot(`
    {
      "agent": "build",
      "model": {
        "id": "deterministic-v2",
        "providerID": "deterministic-provider",
        "variant": "fast",
      },
    }
  `)
  const messages = await discord.channel(channelId).getMessages()
  expect(messages.at(-2)?.content).toMatchInlineSnapshot(`
    "Switched to **build** agent for this channel
    All new sessions will use this agent.
    Thinking level: **fast** (\`deterministic-provider/deterministic-v2 (fast)\`)"
  `)
})
