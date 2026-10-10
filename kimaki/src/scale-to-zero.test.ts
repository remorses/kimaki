// Cloud scale-to-zero: the idle exit never drops a stored alarm, and the wake
// route answers gateway-proxy only after the bot is ready.

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import * as orm from 'drizzle-orm'
import { expect, test } from 'vitest'

import { openDb } from './db.ts'
import { startLockServer } from './lock-server.ts'
import { attemptExit, scheduledWork, shouldExit } from './scale-to-zero.ts'
import * as schema from './schema.ts'

const IDLE = 600_000

test('shouldExit waits for idle time and for wakes outside the window', () => {
  const cases = [
    { busy: true, idleForMs: IDLE, wakeInMs: null },
    { busy: false, idleForMs: IDLE - 1, wakeInMs: null },
    { busy: false, idleForMs: IDLE, wakeInMs: IDLE },
    { busy: false, idleForMs: IDLE, wakeInMs: -1 },
    { busy: false, idleForMs: IDLE, wakeInMs: IDLE + 1 },
    { busy: false, idleForMs: IDLE, wakeInMs: null },
  ]
  expect(cases.map((input) => shouldExit({ ...input, idleMs: IDLE }))).toEqual([false, false, false, false, true, true])
})

test('attemptExit stays up on a failed alarm sync, work during the sync, or a running task', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-idle-'))
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  const bot = { db: opened.db }
  const task = { status: 'planned' as const, schedule_kind: 'at' as const, next_run_at: new Date(IDLE * 3), payload_json: '{}', prompt_preview: 'check' }
  const [row] = await opened.db.insert(schema.scheduled_tasks).values(task).returning()
  const run = async ({ sync = async () => {}, busyAfterSync = false }: { sync?: () => Promise<Error | void>; busyAfterSync?: boolean } = {}) => {
    const state = { synced: null as Date | null, exited: false }
    const result = await attemptExit({
      idleMs: IDLE,
      now: () => IDLE,
      busy: () => busyAfterSync && state.synced !== null,
      idleSince: () => 0,
      work: () => scheduledWork(bot),
      sync: async (nextWakeAt) => {
        state.synced = nextWakeAt
        return sync()
      },
      exit: () => { state.exited = true },
    })
    return { result: result instanceof Error ? result.message : result, synced: state.synced?.toISOString() ?? null, exited: state.exited }
  }
  const results = {
    syncFails: await run({ sync: async () => new Error('website down') }),
    busyDuringSync: await run({ busyAfterSync: true }),
    idle: await run(),
  }
  // `kimaki task run` during its pre-run: no thread runs yet, the scheduler loop is idle.
  await opened.db.update(schema.scheduled_tasks).set({ status: 'running' }).where(orm.eq(schema.scheduled_tasks.id, row!.id))
  const runningTask = await run()
  opened.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  expect({ ...results, runningTask }).toMatchInlineSnapshot(`
    {
      "busyDuringSync": {
        "exited": false,
        "result": "stayed",
        "synced": "1970-01-01T00:30:00.000Z",
      },
      "idle": {
        "exited": true,
        "result": "exited",
        "synced": "1970-01-01T00:30:00.000Z",
      },
      "runningTask": {
        "exited": false,
        "result": "stayed",
        "synced": null,
      },
      "syncFails": {
        "exited": false,
        "result": "website down",
        "synced": "1970-01-01T00:30:00.000Z",
      },
    }
  `)
})

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return typeof address === 'object' && address ? address.port : 0
}

test('POST /kimaki/wake waits for ready, then checks the bot token', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-wake-'))
  const lock = await startLockServer({ port: await freePort(), dataDir, evict: false })
  if (lock instanceof Error) throw lock
  const wake = (token: string) => fetch(`http://127.0.0.1:${lock.port}/kimaki/wake`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    .then(async (response) => ({ status: response.status, body: await response.json() }))
  const early = wake('client:secret')
  expect(await Promise.race([early.then(() => 'answered'), sleep(50).then(() => 'waiting')])).toBe('waiting')
  lock.ready({ wakeToken: 'client:secret' })
  expect(await Promise.all([early, wake('client:wrong')])).toMatchInlineSnapshot(`
    [
      {
        "body": {
          "ready": true,
        },
        "status": 200,
      },
      {
        "body": {
          "error": "Not authorized",
        },
        "status": 401,
      },
    ]
  `)
  await lock.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
