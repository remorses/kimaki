// Tests for scheduled task date/cron parsing and UTC validation rules.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import {
  completeScheduledTaskRunsForSession,
  createScheduledTask,
  createScheduledTaskRun,
  getActiveScheduledTaskRuns,
  getScheduledTask,
  startScheduledTaskRunSession,
} from './database.js'
import { closeDb } from './db.js'
import { runTaskCommand } from './task-runner.js'
import {
  appendTaskCommandOutput,
  parseScheduledTaskPayload,
  parseSendAtValue,
} from './task-schedule.js'

describe('parseSendAtValue', () => {
  test('accepts UTC ISO date ending with Z', () => {
    const now = new Date('2026-02-22T13:00:00Z')
    const result = parseSendAtValue({
      value: '2026-03-01T09:00:00Z',
      now,
      timezone: 'UTC',
    })

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) {
      throw result
    }

    expect(result.scheduleKind).toBe('at')
    expect(result.runAt?.toISOString()).toBe('2026-03-01T09:00:00.000Z')
    expect(result.nextRunAt.toISOString()).toBe('2026-03-01T09:00:00.000Z')
  })

  test('rejects ISO date with non-UTC offset', () => {
    const now = new Date('2026-02-22T13:00:00Z')
    const result = parseSendAtValue({
      value: '2026-03-01T09:00:00+01:00',
      now,
      timezone: 'UTC',
    })

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain('must be UTC ISO format ending with Z')
    }
  })

  test('rejects local ISO date without timezone suffix', () => {
    const now = new Date('2026-02-22T13:00:00Z')
    const result = parseSendAtValue({
      value: '2026-03-01T09:00:00',
      now,
      timezone: 'UTC',
    })

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain('must be UTC ISO format ending with Z')
    }
  })

  test('rejects UTC dates in the past', () => {
    const now = new Date('2026-02-22T13:00:00Z')
    const result = parseSendAtValue({
      value: '2026-02-22T12:59:59Z',
      now,
      timezone: 'UTC',
    })

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain('must be in the future (UTC)')
    }
  })

  test('accepts cron expressions', () => {
    const now = new Date('2026-02-22T13:00:00Z')
    const result = parseSendAtValue({
      value: '0 9 * * 1',
      now,
      timezone: 'UTC',
    })

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) {
      throw result
    }

    expect(result.scheduleKind).toBe('cron')
    expect(result.cronExpr).toBe('0 9 * * 1')
    expect(result.nextRunAt.toISOString()).toBe('2026-02-23T09:00:00.000Z')
  })
})

describe('scheduled task execution options', () => {
  const tempDirectories: string[] = []

  afterEach(() => {
    for (const directory of tempDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test('defaults old payloads to no command and no concurrency', () => {
    const payload = parseScheduledTaskPayload(JSON.stringify({
      kind: 'thread',
      threadId: 'thread-1',
      prompt: 'Handle support requests',
    }))

    expect(payload).toMatchInlineSnapshot(`
      {
        "agent": null,
        "allowConcurrency": false,
        "injectionGuardPatterns": null,
        "kind": "thread",
        "model": null,
        "parentSessionId": null,
        "permissions": null,
        "preRunCommand": null,
        "prompt": "Handle support requests",
        "threadId": "thread-1",
        "userId": null,
        "username": null,
      }
    `)
  })

  test('adds command stdout to the prompt', () => {
    expect(appendTaskCommandOutput({
      prompt: 'Handle support requests',
      stdout: '{"ticketId":"ticket-123"}\n',
    })).toMatchInlineSnapshot(`
      "Handle support requests

      ## Pre-run command output

      {"ticketId":"ticket-123"}"
    `)
  })

  test('runs the pre-run command in the project directory', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-task-'))
    tempDirectories.push(directory)
    fs.writeFileSync(
      path.join(directory, 'should-run.ts'),
      "process.stdout.write(JSON.stringify({ cwd: process.cwd(), ticketId: 'ticket-123' }))\n",
    )
    const taskId = await createScheduledTask({
      scheduleKind: 'cron',
      cronExpr: '*/5 * * * *',
      timezone: 'UTC',
      nextRunAt: new Date('2026-08-12T18:00:00Z'),
      payloadJson: JSON.stringify({
        kind: 'thread',
        threadId: 'thread-1',
        prompt: 'Handle support requests',
        preRunCommand: 'tsx should-run.ts',
      }),
      promptPreview: 'Handle support requests',
      projectDirectory: directory,
    })
    const task = await getScheduledTask(taskId)
    if (!task) throw new Error('Expected scheduled task')
    const payload = parseScheduledTaskPayload(task.payload_json)
    if (payload instanceof Error) throw payload

    const result = await runTaskCommand({ task, payload })
    const realDirectory = fs.realpathSync(directory)

    expect(result instanceof Error || result.kind === 'skip' ? result : {
      ...result,
      prompt: result.prompt.replace(realDirectory, '<project-directory>'),
    }).toMatchInlineSnapshot(`
      {
        "kind": "run",
        "prompt": "Handle support requests

      ## Pre-run command output

      {"cwd":"<project-directory>","ticketId":"ticket-123"}",
      }
    `)
  })

  test('skips the task when the pre-run command exits nonzero', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-task-'))
    tempDirectories.push(directory)
    const taskId = await createScheduledTask({
      scheduleKind: 'cron',
      cronExpr: '*/5 * * * *',
      timezone: 'UTC',
      nextRunAt: new Date('2026-08-12T18:00:00Z'),
      payloadJson: JSON.stringify({
        kind: 'thread',
        threadId: 'thread-skip',
        prompt: 'Handle support requests',
        preRunCommand: "node -e \"process.stdout.write('nothing pending'); process.exit(1)\"",
      }),
      promptPreview: 'Handle support requests',
      projectDirectory: directory,
    })
    const task = await getScheduledTask(taskId)
    if (!task) throw new Error('Expected scheduled task')
    const payload = parseScheduledTaskPayload(task.payload_json)
    if (payload instanceof Error) throw payload

    expect(await runTaskCommand({ task, payload })).toMatchInlineSnapshot(`
      {
        "kind": "skip",
      }
    `)
  })

  test('tracks active runs until their OpenCode session completes', async () => {
    const taskId = await createScheduledTask({
      scheduleKind: 'cron',
      cronExpr: '*/5 * * * *',
      timezone: 'UTC',
      nextRunAt: new Date('2026-08-12T18:00:00Z'),
      payloadJson: JSON.stringify({
        kind: 'thread',
        threadId: 'thread-2',
        prompt: 'Handle support requests',
      }),
      promptPreview: 'Handle support requests',
    })
    const runId = await createScheduledTaskRun({
      taskId,
      startedAt: new Date('2026-08-12T18:00:00Z'),
    })
    await startScheduledTaskRunSession({
      runId,
      sessionId: 'session-1',
      projectDirectory: '/project',
    })

    expect(await getActiveScheduledTaskRuns(taskId)).toHaveLength(1)
    await completeScheduledTaskRunsForSession('session-1')
    expect(await getActiveScheduledTaskRuns(taskId)).toHaveLength(0)
  })
})

afterAll(async () => {
  await closeDb()
})
