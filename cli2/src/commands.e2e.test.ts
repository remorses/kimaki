// Slash command registration and the dynamic commands built from the
// OpenCode catalog: /<agent>-agent, /<cmd>-cmd, /<skill>-skill, and
// /queue-command. MCP prompts get no slash command; they run as messages.

import fs from 'node:fs'
import path from 'node:path'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  slowTextMatcher,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitForBotMessageContaining,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

function reply(marker: string, text: string): DeterministicMatcher {
  return { id: marker, priority: 500, when: { latestUserTextIncludes: marker }, then: { parts: textParts(text) } }
}

const matchers: DeterministicMatcher[] = [
  slowTextMatcher({ marker: 'slow-marker', text: 'slow-done', delayMs: 2_000 }),
  reply('plan-marker', 'plan reply'),
  reply('build-marker', 'build reply'),
  reply('hello-template', 'command reply'),
  reply('skill-marker', 'skill reply'),
  reply('mcp-marker', 'mcp reply'),
  reply('queued-template', 'queued command reply'),
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
      commands: {
        hello: { template: 'hello-template $ARGUMENTS', description: 'Say hello' },
        later: { template: 'queued-template $ARGUMENTS', description: 'Runs later' },
      },
      mcp: { servers: { fake: { type: 'local', command: [process.execPath, path.join(import.meta.dirname, 'test', 'fake-mcp-server.ts')] } } },
    }),
    startTwin(),
  ])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('the bot registers exactly the static and catalog commands in the guild', async () => {
  const commands = await twin.discord.getRegisteredCommands()
  expect(commands.map((command) => `/${command.name}: ${command.description}`)).toMatchInlineSnapshot(`
    [
      "/abort: Stop the current run and clear the queue",
      "/agent: Set the agent for this session or channel",
      "/btw: Ask something without polluting or blocking the current session",
      "/build-agent: The default agent. Executes tools based on configured permissions.",
      "/clear-queue: Remove queued messages",
      "/compact: Compact the session context by summarizing the history",
      "/context-usage: Show token usage and context window percentage",
      "/diff: Show the git diff as a shareable URL",
      "/fork: Fork the session from a past user message",
      "/fork-subagent: Fork a subagent task session into a new thread",
      "/hello-cmd: Say hello",
      "/later-cmd: Runs later",
      "/login: Connect an OpenCode provider",
      "/model: Set the model for this session or channel",
      "/model-variant: Change the thinking level of the current model",
      "/new-session: Start a new OpenCode session",
      "/opencode-skill: Use this skill for any question about OpenCode itself, including how OpenCode works, using or config",
      "/plan-agent: Read-only agent for exploring the codebase and planning work before implementation.",
      "/queue: Send a message after the current run finishes",
      "/queue-command: Queue an OpenCode command to run after the current run finishes",
      "/redo: Redo previously undone changes",
      "/report-skill: Use when the user wants to report an opencode issue or bug. Collect standard diagnostics, add user-s",
      "/resume: Resume an existing OpenCode session in a new thread",
      "/review-cmd: review changes [commit|branch|pr], defaults to uncommitted",
      "/session-id: Show the OpenCode session ID of this thread and how to debug it",
      "/undo: Undo the last turn and revert its file changes",
      "/verbosity: Set what the bot shows in this channel",
    ]
  `)
  expect(await twin.discord.getRegisteredCommands({ guildId: null })).toEqual([])
})

function hideIds(text: string): string {
  return text.replace(/<#\d+>/g, '<#THREAD>')
}

async function newThread(send: () => Promise<unknown>) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await send()
  return discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (thread) => !before.has(thread.id) })
}

test('/<agent>-agent sets the channel agent, or starts a session with a prompt', async () => {
  const { discord, channelId } = twin
  const user = discord.channel(channelId).user(TEST_USER_ID)
  const { id } = await user.runSlashCommand({ name: 'plan-agent' })
  await discord.channel(channelId).waitForInteractionAck({ interactionId: id })
  const planned = await newThread(() => user.sendMessage({ content: 'Plan this plan-marker' }))
  await waitForFooter({ discord, threadId: planned.id })

  const built = await newThread(() =>
    user.runSlashCommand({ name: 'build-agent', options: [{ name: 'prompt', type: 3, value: 'Build it build-marker' }] }),
  )
  await waitForFooter({ discord, threadId: built.id })
  expect(hideIds(await discord.channel(channelId).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Switched to **plan** agent for this channel
    All new sessions will use this agent.
    --- from: user (tommy)
    Plan this plan-marker
    --- from: assistant (TestBot)
    Started a new session in <#THREAD>"
  `)
  expect(await discord.thread(planned.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Plan this plan-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ plan*
    plan reply
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ plan*"
  `)
  expect(await discord.thread(built.id).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **tommy:** Build it build-marker
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    build reply
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('/<cmd>-cmd, /<skill>-skill and a `/server:prompt` message run in the thread session', async () => {
  const { discord, channelId } = twin
  const thread = await newThread(() => discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Commands thread' }))
  await waitForFooter({ discord, threadId: thread.id })
  const user = discord.thread(thread.id).user(TEST_USER_ID)
  await user.runSlashCommand({ name: 'hello-cmd', options: [{ name: 'arguments', type: 3, value: 'world' }] })
  await waitForFooter({ discord, threadId: thread.id, count: 2 })
  await user.runSlashCommand({ name: 'opencode-skill', options: [{ name: 'arguments', type: 3, value: 'explain skill-marker' }] })
  await waitForFooter({ discord, threadId: thread.id, count: 3 })
  await user.sendMessage({ content: '/fake:greet World' })
  await waitForFooter({ discord, threadId: thread.id, count: 4 })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Commands thread
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ plan*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2 ⋅ plan*
    » **tommy:** /hello world
    command reply
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ plan*
    » **tommy:** /opencode explain skill-marker
    skill reply
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ plan*
    --- from: user (tommy)
    /fake:greet World
    --- from: assistant (TestBot)
    mcp reply
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ plan*"
  `)

  const sessionId = bot.store.getState().roots[thread.id]!
  const messages = await (await server.client()).message.list({ sessionID: sessionId, type: 'user', order: 'asc' })
  expect(
    messages.data.flatMap((message) => (message.type === 'user' ? [{ text: message.text.split('\n')[0], skills: message.skills?.map((skill) => skill.id) }] : [])),
  ).toMatchInlineSnapshot(`
    [
      {
        "skills": undefined,
        "text": "Commands thread",
      },
      {
        "skills": undefined,
        "text": "hello-template world",
      },
      {
        "skills": [
          "opencode",
        ],
        "text": "explain skill-marker",
      },
      {
        "skills": undefined,
        "text": "Say hello to World mcp-marker",
      },
    ]
  `)
})

test('/queue-command queues an OpenCode command after the current run', async () => {
  const { discord, channelId } = twin
  const thread = await newThread(() => discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Long run slow-marker' }))
  await waitForBotMessageContaining({ discord, threadId: thread.id, text: '*using ' })
  const user = discord.thread(thread.id).user(TEST_USER_ID)
  expect(await user.autocomplete({ name: 'queue-command', options: [{ name: 'command', type: 3, value: 'lat' }], focused: 'command' }))
    .toMatchInlineSnapshot(`
      [
        {
          "name": "/later - Runs later",
          "value": "later",
        },
      ]
    `)
  await user.runSlashCommand({
    name: 'queue-command',
    options: [
      { name: 'command', type: 3, value: 'later' },
      { name: 'arguments', type: 3, value: 'please' },
    ],
  })
  await waitForBotMessageContaining({ discord, threadId: thread.id, text: 'queued command reply' })
  await waitForFooter({ discord, threadId: thread.id })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Long run slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ plan*
    » **tommy:** /later please
    -# Queued message sent
    slow-done
    » **queued:** queued-template please
    queued command reply
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ plan*"
  `)
})
