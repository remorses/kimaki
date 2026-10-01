// Scheduled tasks end to end (spec 30, Phase 8): `kimaki send --send-at` runs
// one-shot, cron, thread and pre-run tasks against the twin and a real
// OpenCode server. Time is a manual clock; nothing waits for real time.

import fs from 'node:fs'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  manualClock,
  schedulingKit,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const dataDir = tempDataDir()
const clock = manualClock(Date.parse('2030-01-01T09:00:00Z'))
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
const { cli, schedule, tick, listTasks, request } = schedulingKit({ suite: () => ({ bot, twin, server }), dataDir, clock })

beforeAll(async () => {
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server, clock, schedulerIntervalMs: null })
  await warmUp({ server })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('a one-shot task starts a thread at its time, then is gone', async () => {
  // The real command once; later tests call the same lock-server route directly.
  const task = JSON.parse(await cli(['send', '--channel', twin.channelId, '--prompt', 'Check the deploy once', '--send-at', '2030-01-01T10:00:00Z', '--name', 'Deploy check'])) as { taskId: number; nextRunAt: string }
  expect(task.nextRunAt).toBe('2030-01-01T10:00:00.000Z')
  expect(await tick('2030-01-01T09:59:59Z')).toEqual([])
  const [threadId] = await tick('2030-01-01T10:00:00Z')
  await waitForFooter({ discord: twin.discord, threadId: threadId! })
  expect(await twin.discord.thread(threadId!).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **task #1:** Check the deploy once
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  const thread = (await twin.discord.channel(twin.channelId).getThreads()).find((candidate) => candidate.id === threadId)
  expect(thread?.name).toBe('Deploy check')
  const sessionId = bot.store.getState().roots[threadId!]!
  const info = await (await server.client()).session.get({ sessionID: sessionId })
  expect(info.metadata?.['kimaki']).toMatchObject({ source: 'task', taskId: task.taskId })
  // The instruction entry tells the agent it runs for a task and must not sleep until the next run.
  const entries = await (await server.client()).session.instructions.entry.list({ sessionID: sessionId })
  const text = entries.map((entry) => String(entry.value)).join('\n')
  expect(text.slice(text.indexOf('## scheduled task session'), text.indexOf('## archiving'))).toMatchInlineSnapshot(`
    "## scheduled task session

    This session was started automatically by kimaki scheduled task #1.
    This task runs once and does not repeat. When your run is done, just stop.
    Do NOT use \`kimaki sleep\` to wait for the next run. Sleeping pins this session and never triggers the next one; each firing of the task starts a new session on its own.

    "
  `)
  expect((await listTasks()).filter((row) => row.id === task.taskId)).toEqual([])
})

test('a cron task fires once per occurrence, in a new thread each time', async () => {
  clock.set(Date.parse('2030-01-01T10:30:00Z'))
  const task = await schedule({ prompt: 'Hourly report', sendAt: '0 * * * *' })
  expect(task.nextRunAt).toBe('2030-01-01T11:00:00.000Z')
  const first = await tick('2030-01-01T11:00:00Z')
  await waitForFooter({ discord: twin.discord, threadId: first[0]! })
  expect(await tick('2030-01-01T11:30:00Z')).toEqual([])
  const second = await tick('2030-01-01T12:00:05Z')
  await waitForFooter({ discord: twin.discord, threadId: second[0]! })
  expect([first.length, second.length]).toEqual([1, 1])
  expect(await twin.discord.thread(second[0]!).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **task #2:** Hourly report
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect((await listTasks()).find((row) => row.id === task.taskId)).toMatchObject({ status: 'planned', nextRunAt: '2030-01-01T13:00:00.000Z' })
  await request('/kimaki/task/delete', { id: task.taskId })
})

test('a task for an existing thread prompts that thread, with or without . queue', async () => {
  const started = await bot.actions.send({ channelId: twin.channelId, prompt: 'Thread for a reminder' })
  if (started instanceof Error) throw started
  await waitForFooter({ discord: twin.discord, threadId: started.threadId })
  await request('/kimaki/send', { threadId: started.threadId, prompt: 'Reminder: check the logs', sendAt: '2030-01-01T14:00:00Z' })
  await request('/kimaki/send', { threadId: started.threadId, prompt: 'Then summarize them. queue', sendAt: '2030-01-01T15:00:00Z' })
  expect(await tick('2030-01-01T14:00:00Z')).toEqual([])
  await waitForFooter({ discord: twin.discord, threadId: started.threadId, count: 2 })
  expect(await tick('2030-01-01T15:00:00Z')).toEqual([])
  await waitForFooter({ discord: twin.discord, threadId: started.threadId, count: 3 })
  expect(await twin.discord.thread(started.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** Thread for a reminder
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    » **task #3:** Reminder: check the logs
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    » **task #4:** Then summarize them
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
})

test('--pre-run: a failing command skips the run, output is appended to the prompt', async () => {
  clock.set(Date.parse('2030-01-01T15:00:00Z'))
  const skipped = await schedule({ prompt: 'Skipped task', sendAt: '2030-01-01T16:00:00Z', preRun: 'echo nothing to do; exit 3' })
  const ran = await schedule({ prompt: 'Summarize the new issues', sendAt: '2030-01-01T16:00:00Z', preRun: 'echo issue 42 is new' })
  const created = await tick('2030-01-01T16:00:00Z')
  expect(created.length).toBe(1)
  await waitForFooter({ discord: twin.discord, threadId: created[0]! })
  expect(await twin.discord.thread(created[0]!).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **task #6:** Summarize the new issues

    ## Pre-run command output

    issue 42 is new
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  // A skipped one-shot is done too, like V1.
  expect((await listTasks()).filter((row) => row.id === skipped.taskId || row.id === ran.taskId)).toEqual([])
})
