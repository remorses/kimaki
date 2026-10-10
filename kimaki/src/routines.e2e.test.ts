// Routine management end to end (spec 30, Phase 8): non-overlapping runs,
// V1 task rows, `kimaki routine list/edit/run/delete` and /routines with its Run
// now and Delete buttons. Time is a manual clock.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { ComponentType, type APIMessage } from 'discord.js'
import * as orm from 'drizzle-orm'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import * as schema from './schema.ts'
import { abort } from './prompt.ts'
import {
  TEST_USER_ID,
  manualClock,
  schedulingKit,
  seedProjectChannel,
  slowTextMatcher,
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

const dataDir = tempDataDir()
const clock = manualClock(Date.parse('2030-01-01T17:00:00Z'))
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
const { cli, schedule, tick, listTasks, request, threadIds } = schedulingKit({ suite: () => ({ bot, twin, server }), dataDir, clock })

beforeAll(async () => {
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({ matchers: [slowTextMatcher({ marker: 'slow-task-marker', text: 'slow done', delayMs: 60_000 })] }),
    startTwin(),
  ])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server, clock, schedulerIntervalMs: null })
  await warmUp({ server })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('runs do not overlap by default; --allow-concurrency starts another session', async () => {
  const serial = await schedule({ prompt: 'slow-task-marker serial', sendAt: '0 * * * *' })
  const parallel = await schedule({ prompt: 'slow-task-marker parallel', sendAt: '0 * * * *', allowConcurrency: true })
  const first = await tick('2030-01-01T18:00:00Z')
  expect(first.length).toBe(2)
  const client = await server.client()
  const sessions = first.map((threadId) => bot.store.getState().roots[threadId]!)
  await waitFor({ label: 'both runs busy', check: async () => {
    const active = await client.session.active()
    return sessions.every((id) => id in active)
  } })
  const second = await tick('2030-01-01T19:00:00Z')
  expect(second.length).toBe(1)
  const info = await client.session.get({ sessionID: bot.store.getState().roots[second[0]!]! })
  expect(info.metadata?.['kimaki']).toMatchObject({ taskId: parallel.routineId })
  // The skipped occurrence still moves the serial task to its next run.
  expect((await listTasks()).find((row) => row.id === serial.routineId)).toMatchObject({ status: 'planned', nextRunAt: '2030-01-01T20:00:00.000Z' })
  for (const threadId of [...first, ...second]) {
    const aborted = await abort(bot, { threadId })
    if (aborted instanceof Error) throw aborted
  }
  for (const id of [serial.routineId, parallel.routineId]) await request('task.delete', { id })
})

test('a routine row written by V1 runs unchanged', async () => {
  // Exactly what V1 `kimaki send --send-at` stored (task-schedule.ts serializeScheduledTaskPayload).
  const payload = {
    kind: 'channel', channelId: twin.channelId, prompt: 'V1 weekly check', name: null, notifyOnly: false, worktreeName: null, cwd: null,
    agent: null, model: null, username: 'tommy', userId: TEST_USER_ID, permissions: null, injectionGuardPatterns: null, parentSessionId: null,
    preRunCommand: null, allowConcurrency: false,
  }
  const [row] = await bot.db.insert(schema.scheduled_tasks).values({
    status: 'planned', schedule_kind: 'cron', cron_expr: '0 9 * * 1', timezone: 'UTC', next_run_at: new Date('2030-01-07T09:00:00.000Z'),
    payload_json: JSON.stringify(payload), prompt_preview: 'V1 weekly check', channel_id: twin.channelId, project_directory: server.projectDirectory,
  }).returning()
  const [threadId] = await tick('2030-01-07T09:00:00Z')
  await waitForFooter({ discord: twin.discord, threadId: threadId! })
  expect(await twin.discord.thread(threadId!).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **routine #3:** V1 weekly check
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect((await listTasks()).find((task) => task.id === row!.id)).toMatchObject({ status: 'planned', nextRunAt: '2030-01-14T09:00:00.000Z' })
  // V1 history: finished rows only show with the V1 `task list --all`.
  await bot.db.update(schema.scheduled_tasks).set({ status: 'completed' }).where(orm.eq(schema.scheduled_tasks.id, row!.id))
  const listed = async (args: string[]) => (JSON.parse(await cli(['task', 'list', '--json', ...args])) as Array<{ id: number; status: string }>).map(({ id, status }) => ({ id, status }))
  expect({ default: await listed([]), all: await listed(['--all']) }).toMatchInlineSnapshot(`
    {
      "all": [
        {
          "id": 3,
          "status": "completed",
        },
      ],
      "default": [],
    }
  `)
  await request('task.delete', { id: row!.id })
})

function buttons(message: APIMessage) {
  const found: Array<{ label: string; customId: string }> = []
  const walk = (components: readonly unknown[]) => {
    for (const component of components) {
      if (!component || typeof component !== 'object') continue
      if ('type' in component && component.type === ComponentType.Button && 'custom_id' in component && typeof component.custom_id === 'string') {
        found.push({ label: 'label' in component && typeof component.label === 'string' ? component.label : '', customId: component.custom_id })
      }
      if ('components' in component && Array.isArray(component.components)) walk(component.components)
    }
  }
  walk(message.components ?? [])
  return found
}

test('routine list/edit/run/delete and /routines with Run now and Delete buttons', async () => {
  clock.set(Date.parse('2030-01-02T08:00:00Z'))
  const daily = await schedule({ prompt: 'Daily digest', sendAt: '0 9 * * *', preRun: 'true', user: TEST_USER_ID })
  const once = await schedule({ prompt: 'Renew the certificate', sendAt: '2030-01-05T09:00:00Z', notifyOnly: true })
  expect(await cli(['routine', 'edit', String(daily.routineId), '--prompt', 'Daily digest, short', '--send-at', '30 9 * * 1-5', '--agent', 'plan', '--pre-run', '', '--allow-concurrency', 'true', '--user', ''])).toMatchInlineSnapshot(`
    "{"routineId":4,"updated":["prompt","sendAt","agent","preRun","user","allowConcurrency"]}
    "
  `)
  expect(await cli(['task', 'list'])).toMatchInlineSnapshot(`
    "id | status | schedule | nextRunAt | channel | thread | user | agent | model | preRun | allowConcurrency | prompt
    4 | planned | cron 30 9 * * 1-5 | 2030-01-02T09:30:00.000Z | 200000000000000100 | - | - | plan | - | - | true | Daily digest, short
    5 | planned | once | 2030-01-05T09:00:00.000Z | 200000000000000100 | - | - | - | - | - | false | Renew the certificate
    "
  `)

  const { discord, channelId } = twin
  const user = discord.channel(channelId).user(TEST_USER_ID)
  const { id } = await user.runSlashCommand({ name: 'routines' })
  await discord.channel(channelId).waitForInteractionAck({ interactionId: id })
  const reply = await waitFor({ label: '/routines reply', check: async () => (await discord.channel(channelId).getMessages()).find((message) => buttons(message).some((button) => button.customId.startsWith('routine_'))) })
  expect(buttons(reply)).toMatchInlineSnapshot(`
    [
      {
        "customId": "routine_run:4",
        "label": "Run now",
      },
      {
        "customId": "routine_delete:4",
        "label": "Delete",
      },
      {
        "customId": "routine_run:5",
        "label": "Run now",
      },
      {
        "customId": "routine_delete:5",
        "label": "Delete",
      },
    ]
  `)
  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    **Routines** (2)
    **#4** cron 30 9 * * 1-5 ⋅ next <t:1893576600:R> ⋅ <#200000000000000100>
    Daily digest, short
    **#5** once ⋅ next <t:1893834000:R> ⋅ <#200000000000000100>
    Renew the certificate"
  `)

  // Run now: a notify-only task posts its thread without a session.
  const before = await threadIds()
  await user.clickButton({ messageId: reply.id, customId: `routine_run:${once.routineId}` })
  const notice = await waitFor({ label: 'notification thread', check: async () => [...(await threadIds())].find((threadId) => !before.has(threadId)) })
  expect(await discord.thread(notice).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Renew the certificate"
  `)
  await user.clickButton({ messageId: reply.id, customId: `routine_delete:${daily.routineId}` })
  await waitFor({ label: 'routine deleted', check: async () => (await discord.channel(channelId).text()).includes(`Deleted routine #${daily.routineId}`) })
  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Deleted routine #4
    No routines. Create one with \`kimaki send --send-at\`."
  `)
  expect(await listTasks()).toEqual([])

  // The hidden V1 `task run` alias takes the same path as the scheduler.
  const later = await schedule({ prompt: 'Run me now', sendAt: '2030-02-01T00:00:00Z' })
  const ranNow = JSON.parse(await cli(['task', 'run', String(later.routineId)])) as { threadId: string }
  await waitForFooter({ discord, threadId: ranNow.threadId })
  const failed = await promisify(execFile)(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'routine', 'delete', '999', '--data-dir', dataDir], {
    env: { ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port) },
  }).catch((error: { code: number; stderr: string }) => error)
  expect(failed.stderr).toMatchInlineSnapshot(`
    "Routine 999 not found. List routines with: kimaki routine list
    "
  `)
})
