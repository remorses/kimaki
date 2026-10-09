// Pure scheduling: the next run of cron tasks, --send-at and sleep wake
// times at a clock time, and the V1 task payload (spec 17, 30 Phase 8).

import { expect, test } from 'vitest'

import { decodeTaskPayload, encodeTaskPayload, nextCronRun, nextRunOf, parseSendAt } from './scheduler.ts'
import { parseWakeAt } from './sleeps.ts'

const at = (iso: string) => Date.parse(iso)
const iso = (value: number | Error | null) => (typeof value === 'number' ? new Date(value).toISOString() : value instanceof Error ? `Error: ${value.message}` : value)

test('next run of one-shot and cron tasks, V1 timezones included', () => {
  const now = at('2026-01-01T10:00:00Z')
  const rows = [
    { id: 1, schedule_kind: 'at' as const, cron_expr: null, timezone: null },
    { id: 2, schedule_kind: 'cron' as const, cron_expr: '0 * * * *', timezone: 'UTC' },
    // V1 rows may carry another timezone; no timezone means UTC.
    { id: 6, schedule_kind: 'cron' as const, cron_expr: '30 9 * * *', timezone: 'Europe/Rome' },
    { id: 7, schedule_kind: 'cron' as const, cron_expr: '30 9 * * *', timezone: null },
    { id: 8, schedule_kind: 'cron' as const, cron_expr: 'not a cron', timezone: null },
    { id: 9, schedule_kind: 'cron' as const, cron_expr: null, timezone: null },
  ]
  expect(Object.fromEntries(rows.map((row) => [`task #${row.id}`, iso(nextRunOf({ row, now }))]))).toMatchInlineSnapshot(`
    {
      "task #1": null,
      "task #2": "2026-01-01T11:00:00.000Z",
      "task #6": "2026-01-02T08:30:00.000Z",
      "task #7": "2026-01-02T09:30:00.000Z",
      "task #8": "Error: Invalid cron expression: not a cron",
      "task #9": "Error: Task 9 has no cron expression",
    }
  `)
})

test('V1 task payloads decode to the send input of each run and encode back unchanged', () => {
  const base = {
    prompt: 'Weekly check', agent: 'plan', model: 'anthropic/claude', username: 'tommy', userId: '100', permissions: ['bash:*:allow'],
    injectionGuardPatterns: ['secret'], parentSessionId: 'ses_parent', preRunCommand: 'git fetch', allowConcurrency: true,
  }
  const thread = { ...base, kind: 'thread', threadId: '300', permissions: null }
  const channel = { ...base, kind: 'channel', channelId: '200', name: 'Weekly', notifyOnly: false, worktreeName: '', cwd: null, baseBranch: 'main' }
  const decoded = [thread, channel].map((payload) => decodeTaskPayload(JSON.stringify(payload)))
  expect(decoded).toMatchInlineSnapshot(`
    [
      {
        "allowConcurrency": true,
        "injectionGuardPatterns": [
          "secret",
        ],
        "preRun": "git fetch",
        "send": {
          "agent": "plan",
          "model": "anthropic/claude",
          "parentSessionId": "ses_parent",
          "prompt": "Weekly check",
          "threadId": "300",
          "user": [
            "100",
          ],
        },
        "username": "tommy",
      },
      {
        "allowConcurrency": true,
        "injectionGuardPatterns": [
          "secret",
        ],
        "preRun": "git fetch",
        "send": {
          "agent": "plan",
          "baseBranch": "main",
          "channelId": "200",
          "model": "anthropic/claude",
          "name": "Weekly",
          "parentSessionId": "ses_parent",
          "permissions": [
            "bash:*:allow",
          ],
          "prompt": "Weekly check",
          "user": [
            "100",
          ],
          "worktree": "",
        },
        "username": "tommy",
      },
    ]
  `)
  // Rewriting keeps the V1 shape, including fields V2 does not use.
  const encoded = decoded.map((job) => {
    const json = job instanceof Error ? job : encodeTaskPayload(job)
    return json instanceof Error ? json : JSON.parse(json)
  })
  expect(encoded).toEqual([thread, channel])
  const empty = { ...channel, name: '', agent: '', model: '', userId: '', parentSessionId: '', permissions: [], cwd: '', baseBranch: '' }
  const emptyJob = decodeTaskPayload(JSON.stringify(empty))
  if (emptyJob instanceof Error) return expect.fail(emptyJob.message)
  const rewritten = encodeTaskPayload({ ...emptyJob, allowConcurrency: false })
  if (rewritten instanceof Error) return expect.fail(rewritten.message)
  expect(JSON.parse(rewritten)).toMatchInlineSnapshot(`
    {
      "agent": "",
      "allowConcurrency": false,
      "baseBranch": "",
      "channelId": "200",
      "cwd": "",
      "injectionGuardPatterns": [
        "secret",
      ],
      "kind": "channel",
      "model": "",
      "name": "",
      "notifyOnly": false,
      "parentSessionId": "",
      "permissions": [],
      "preRunCommand": "git fetch",
      "prompt": "Weekly check",
      "userId": "",
      "username": "tommy",
      "worktreeName": "",
    }
  `)
  expect(JSON.parse(rewritten)).toEqual({ ...empty, allowConcurrency: false })
  const invalid = ['{', '[]', '{"kind":"channel","prompt":"x"}', '{"kind":"thread","threadId":"1"}'].map((json) => {
    const job = decodeTaskPayload(json)
    return job instanceof Error ? job.message : job
  })
  expect(invalid).toMatchInlineSnapshot(`
    [
      "Task payload is not valid JSON",
      "Task payload must be an object",
      "Task payload has unknown kind channel or no target",
      "Task payload has no prompt",
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
