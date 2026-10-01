// Pure scheduling: which tasks and sleep wakes are due at a given clock time,
// and the next run of each (spec 30, Phase 8 "Fake clock").

import { expect, test } from 'vitest'

import { dueTasks, nextCronRun, parseSendAt, parseWakeAt, type Task } from './scheduler.ts'

const at = (iso: string) => Date.parse(iso)
const iso = (value: number | Error | null) => (typeof value === 'number' ? new Date(value).toISOString() : value instanceof Error ? `Error: ${value.message}` : value)

function show(result: ReturnType<typeof dueTasks>) {
  return result.map(({ task, nextRunAt }) => ({
    due: task.kind === 'task' ? `task #${task.id}` : `wake ${task.sessionId}`,
    nextRunAt: iso(nextRunAt),
  }))
}

test('one-shot, cron and sleep wakes due at a clock time', () => {
  const tasks: Task[] = [
    { kind: 'task', id: 1, status: 'planned', schedule: 'at', dueAt: at('2026-01-01T10:00:00Z'), cronExpr: null, timezone: null },
    { kind: 'task', id: 2, status: 'planned', schedule: 'cron', dueAt: at('2026-01-01T09:00:00Z'), cronExpr: '0 * * * *', timezone: 'UTC' },
    // Not due yet.
    { kind: 'task', id: 3, status: 'planned', schedule: 'at', dueAt: at('2026-01-01T10:00:01Z'), cronExpr: null, timezone: null },
    // Only planned rows run.
    { kind: 'task', id: 4, status: 'running', schedule: 'at', dueAt: at('2026-01-01T08:00:00Z'), cronExpr: null, timezone: null },
    { kind: 'task', id: 5, status: 'cancelled', schedule: 'cron', dueAt: at('2026-01-01T08:00:00Z'), cronExpr: '0 * * * *', timezone: null },
    // V1 rows may carry another timezone; no timezone means UTC.
    { kind: 'task', id: 6, status: 'planned', schedule: 'cron', dueAt: at('2026-01-01T08:00:00Z'), cronExpr: '30 9 * * *', timezone: 'Europe/Rome' },
    { kind: 'task', id: 7, status: 'planned', schedule: 'cron', dueAt: at('2026-01-01T08:00:00Z'), cronExpr: '30 9 * * *', timezone: null },
    { kind: 'task', id: 8, status: 'planned', schedule: 'cron', dueAt: at('2026-01-01T08:00:00Z'), cronExpr: 'not a cron', timezone: null },
    { kind: 'wake', sessionId: 'ses_due', status: 'planned', dueAt: at('2026-01-01T09:59:00Z'), lastAttemptAt: null },
    { kind: 'wake', sessionId: 'ses_later', status: 'planned', dueAt: at('2026-01-01T11:00:00Z'), lastAttemptAt: null },
    { kind: 'wake', sessionId: 'ses_cancelled', status: 'cancelled', dueAt: at('2026-01-01T09:00:00Z'), lastAttemptAt: null },
    // A failed wake attempt waits 30s before the next one.
    { kind: 'wake', sessionId: 'ses_retry_wait', status: 'planned', dueAt: at('2026-01-01T09:00:00Z'), lastAttemptAt: at('2026-01-01T09:59:45Z') },
    { kind: 'wake', sessionId: 'ses_retry_now', status: 'planned', dueAt: at('2026-01-01T09:00:00Z'), lastAttemptAt: at('2026-01-01T09:59:30Z') },
  ]
  expect(show(dueTasks({ tasks, now: at('2026-01-01T10:00:00Z') }))).toMatchInlineSnapshot(`
    [
      {
        "due": "task #6",
        "nextRunAt": "2026-01-02T08:30:00.000Z",
      },
      {
        "due": "task #7",
        "nextRunAt": "2026-01-02T09:30:00.000Z",
      },
      {
        "due": "task #8",
        "nextRunAt": "Error: Invalid cron expression: not a cron",
      },
      {
        "due": "task #2",
        "nextRunAt": "2026-01-01T11:00:00.000Z",
      },
      {
        "due": "wake ses_retry_now",
        "nextRunAt": null,
      },
      {
        "due": "wake ses_due",
        "nextRunAt": null,
      },
      {
        "due": "task #1",
        "nextRunAt": null,
      },
    ]
  `)
})

test('a cron task fires once per occurrence as the clock moves', () => {
  const fired: string[] = []
  const state = { dueAt: at('2026-01-01T10:00:00Z') }
  for (const now of ['2026-01-01T09:30:00Z', '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z', '2026-01-01T10:59:59Z', '2026-01-01T13:20:00Z']) {
    const task: Task = { kind: 'task', id: 1, status: 'planned', schedule: 'cron', dueAt: state.dueAt, cronExpr: '0 * * * *', timezone: 'UTC' }
    const [due] = dueTasks({ tasks: [task], now: at(now) })
    if (!due || typeof due.nextRunAt !== 'number') continue
    fired.push(`${now} -> next ${iso(due.nextRunAt)}`)
    state.dueAt = due.nextRunAt
  }
  // Missed occurrences while the bot was down fire once, not once per hour.
  expect(fired).toMatchInlineSnapshot(`
    [
      "2026-01-01T10:00:00Z -> next 2026-01-01T11:00:00.000Z",
      "2026-01-01T13:20:00Z -> next 2026-01-01T14:00:00.000Z",
    ]
  `)
})

test('--send-at and sleep wake times resolve against the clock', () => {
  const now = at('2026-01-01T09:00:00Z')
  const sendAt = ['2026-01-01T10:00:00Z', '2026-01-01T10:00Z', '2026-01-01T08:00:00Z', '2026-01-01T10:00:00+01:00', '0 9 * * 1', '@hourly', 'tomorrow', ' ']
  expect(Object.fromEntries(sendAt.map((value) => {
    const parsed = parseSendAt({ value, now })
    if (parsed instanceof Error) return [value, `Error: ${parsed.message}`]
    return [value, parsed.kind === 'at' ? `at ${iso(parsed.runAt)}` : `cron ${parsed.cronExpr} next ${iso(parsed.nextRunAt)}`]
  }))).toMatchInlineSnapshot(`
    {
      " ": "Error: --send-at cannot be empty",
      "0 9 * * 1": "cron 0 9 * * 1 next 2026-01-05T09:00:00.000Z",
      "2026-01-01T08:00:00Z": "Error: --send-at must be in the future (UTC): 2026-01-01T08:00:00Z",
      "2026-01-01T10:00:00+01:00": "Error: --send-at date must be UTC ISO format ending with Z (example: 2026-03-01T09:00:00Z). Received: 2026-01-01T10:00:00+01:00",
      "2026-01-01T10:00:00Z": "at 2026-01-01T10:00:00.000Z",
      "2026-01-01T10:00Z": "at 2026-01-01T10:00:00.000Z",
      "@hourly": "cron @hourly next 2026-01-01T10:00:00.000Z",
      "tomorrow": "Error: Invalid --send-at value: "tomorrow". Use a UTC ISO date ending in Z or a cron expression.",
    }
  `)

  const wakes = [
    { duration: '2h' },
    { duration: '90s' },
    { duration: '1.5d' },
    { duration: '0m' },
    { duration: 'soon' },
    { until: '2026-01-02T00:00:00Z' },
    { until: '2025-12-31T00:00:00Z' },
    { duration: '1h', until: '2026-01-02T00:00:00Z' },
    {},
  ]
  expect(wakes.map((input) => `${JSON.stringify(input)} -> ${iso(parseWakeAt({ ...input, now }))}`)).toMatchInlineSnapshot(`
    [
      "{"duration":"2h"} -> 2026-01-01T11:00:00.000Z",
      "{"duration":"90s"} -> 2026-01-01T09:01:30.000Z",
      "{"duration":"1.5d"} -> 2026-01-02T21:00:00.000Z",
      "{"duration":"0m"} -> Error: --duration must be greater than 0",
      "{"duration":"soon"} -> Error: Invalid --duration "soon". Use a number plus ms, s, m, h, or d (example: 2h)",
      "{"until":"2026-01-02T00:00:00Z"} -> 2026-01-02T00:00:00.000Z",
      "{"until":"2025-12-31T00:00:00Z"} -> Error: --until must be in the future (UTC): 2025-12-31T00:00:00Z",
      "{"duration":"1h","until":"2026-01-02T00:00:00Z"} -> Error: Pass either --duration or --until, not both",
      "{} -> Error: Pass --duration or --until",
    ]
  `)
  expect(iso(nextCronRun({ cronExpr: '0 9 * * *', timezone: 'UTC', from: at('2026-01-01T09:00:00Z') }))).toBe('2026-01-02T09:00:00.000Z')
})
