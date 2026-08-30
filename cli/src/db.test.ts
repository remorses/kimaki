// Tests for Drizzle client initialization and schema migration.
// Auto-isolated via VITEST guards in config.ts (temp data dir) and db.ts (clears KIMAKI_DB_URL).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { afterAll, describe, expect, test } from 'vitest'
import { closeDb, getDb } from './db.js'
import * as orm from 'drizzle-orm'
import * as schema from './schema.js'
import {
  appendSessionEventsSinceLastTimestamp,
  createPendingWorkspace,
  getDueSessionSleeps,
  getSessionEventSnapshot,
  getSessionModel,
  getSessionSleep,
  setSessionModel,
  upsertSessionSleep,
} from './database.js'
import { createClient } from '@libsql/client'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { chooseLockPort } from './test-utils.js'
import { copyCurrentSessionModel } from './commands/model.js'
import type { initializeOpencodeForDirectory } from './opencode.js'

afterAll(async () => {
  await closeDb()
})

describe('getDb', () => {
  test('schema.sql creates every drizzle table', () => {
    const schemaTs = fs.readFileSync(
      path.join(import.meta.dirname, 'schema.ts'),
      'utf8',
    )
    const schemaSql = fs.readFileSync(
      path.join(import.meta.dirname, 'schema.sql'),
      'utf8',
    )
    const tablesFromTs = [
      ...schemaTs.matchAll(/sqliteTable\('([^']+)'/g),
    ].map((match) => match[1])
    const tablesFromSql = [
      ...schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS `([^`]+)`/g),
    ].map((match) => match[1])
    expect(new Set(tablesFromSql)).toEqual(new Set(tablesFromTs))
    expect(tablesFromSql).toContain('session_sleeps')
  })

  test('adds session_sleeps delivery columns on databases created before that schema', async () => {
    await closeDb()

    const previousDbUrl = process.env['KIMAKI_DB_URL']
    const dbPath = path.join(
      process.cwd(),
      `tmp/test-db-legacy-sleeps-${crypto.randomUUID().slice(0, 8)}.db`,
    )

    try {
      const client = createClient({ url: `file:${dbPath}` })
      await client.execute(`
        CREATE TABLE thread_sessions (
          thread_id text PRIMARY KEY,
          session_id text NOT NULL
        )
      `)
      await client.execute(`
        CREATE TABLE session_sleeps (
          session_id text PRIMARY KEY,
          thread_id text NOT NULL,
          wake_at datetime NOT NULL,
          reason text,
          status text DEFAULT 'planned' NOT NULL,
          created_at datetime DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await client.execute(`
        INSERT INTO thread_sessions (thread_id, session_id)
        VALUES ('thr-legacy', 'ses-legacy')
      `)
      await client.execute(`
        INSERT INTO session_sleeps (session_id, thread_id, wake_at, status)
        VALUES ('ses-legacy', 'thr-legacy', '2020-01-01T00:00:00.000Z', 'planned')
      `)
      client.close()

      process.env['KIMAKI_DB_URL'] = `file:${dbPath}`
      await getDb()

      const due = await getDueSessionSleeps({
        now: new Date('2026-08-21T00:00:00Z'),
        retryAfterMs: 30_000,
        limit: 10,
      })
      const legacy = due.find((row) => row.session_id === 'ses-legacy')
      expect(legacy?.delivery_id).toBeTruthy()
      expect(legacy?.attempts).toBe(0)

      // The first table required thread_id. After the column was dropped from
      // the schema, inserts that omit it must still work on existing databases.
      await upsertSessionSleep({
        sessionId: 'ses-legacy-new',
        wakeAt: new Date('2026-08-26T00:00:00Z'),
        reason: 'check the reply',
      })
      const created = await getSessionSleep({ sessionId: 'ses-legacy-new' })
      expect(created?.status).toBe('planned')
      expect(created?.reason).toBe('check the reply')
      expect(created?.delivery_id).toBeTruthy()
    } finally {
      await closeDb()
      if (previousDbUrl === undefined) {
        delete process.env['KIMAKI_DB_URL']
      } else {
        process.env['KIMAKI_DB_URL'] = previousDbUrl
      }
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('rebuilds session_sleeps that still have posted_at from the intermediate schema', async () => {
    await closeDb()

    const previousDbUrl = process.env['KIMAKI_DB_URL']
    const dbPath = path.join(
      process.cwd(),
      `tmp/test-db-posted-sleeps-${crypto.randomUUID().slice(0, 8)}.db`,
    )

    try {
      const client = createClient({ url: `file:${dbPath}` })
      await client.execute(`
        CREATE TABLE thread_sessions (
          thread_id text PRIMARY KEY,
          session_id text NOT NULL
        )
      `)
      await client.execute(`
        CREATE TABLE session_sleeps (
          session_id text PRIMARY KEY,
          thread_id text NOT NULL,
          wake_at datetime NOT NULL,
          reason text,
          status text DEFAULT 'planned' NOT NULL,
          delivery_id text NOT NULL,
          attempts integer DEFAULT 0 NOT NULL,
          last_attempt_at datetime,
          posted_at datetime,
          created_at datetime DEFAULT CURRENT_TIMESTAMP
        )
      `)
      await client.execute(`
        INSERT INTO thread_sessions (thread_id, session_id)
        VALUES ('thr-posted', 'ses-posted')
      `)
      await client.execute(`
        INSERT INTO session_sleeps (
          session_id, thread_id, wake_at, status, delivery_id, posted_at
        )
        VALUES (
          'ses-posted',
          'thr-posted',
          '2020-01-01T00:00:00.000Z',
          'posted',
          'del-posted',
          '2020-01-01T00:00:01.000Z'
        )
      `)
      client.close()

      process.env['KIMAKI_DB_URL'] = `file:${dbPath}`
      await getDb()

      const due = await getDueSessionSleeps({
        now: new Date('2026-08-21T00:00:00Z'),
        retryAfterMs: 30_000,
        limit: 10,
      })
      const posted = due.find((row) => row.session_id === 'ses-posted')
      expect(posted?.status).toBe('planned')
      expect(posted?.delivery_id).toBe('del-posted')

      await upsertSessionSleep({
        sessionId: 'ses-posted',
        wakeAt: new Date('2026-08-26T00:00:00Z'),
        reason: 'retry after schema change',
      })
      const updated = await getSessionSleep({ sessionId: 'ses-posted' })
      expect(updated?.status).toBe('planned')
      expect(updated?.reason).toBe('retry after schema change')
      expect(updated?.delivery_id).not.toBe('del-posted')
    } finally {
      await closeDb()
      if (previousDbUrl === undefined) {
        delete process.env['KIMAKI_DB_URL']
      } else {
        process.env['KIMAKI_DB_URL'] = previousDbUrl
      }
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('creates sqlite file and migrates schema automatically', async () => {
    const db = await getDb()

    const [session] = await db.insert(schema.thread_sessions)
      .values({ thread_id: 'test-thread-123', session_id: 'test-session-456' })
      .returning()
    expect(session).toBeDefined()
    if (!session) throw new Error('Expected inserted session row')
    expect(session.thread_id).toBe('test-thread-123')
    expect(session.created_at).toBeInstanceOf(Date)

    const found = await db.query.thread_sessions.findFirst({
      where: { thread_id: session.thread_id },
    })
    expect(found?.session_id).toBe('test-session-456')

    // Cleanup test data
    await db.delete(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, 'test-thread-123'))
  })

  test('migrates fresh sqlite files through hrana', async () => {
    await closeDb()

    const previousDbUrl = process.env['KIMAKI_DB_URL']
    const previousLockPort = process.env['KIMAKI_LOCK_PORT']
    const dbPath = path.join(
      process.cwd(),
      `tmp/test-db-hrana-${crypto.randomUUID().slice(0, 8)}.db`,
    )

    try {
      process.env['KIMAKI_LOCK_PORT'] = String(chooseLockPort({ key: 'db-hrana-migration-test' }))
      const hranaResult = await startHranaServer({ dbPath })
      if (hranaResult instanceof Error) throw hranaResult
      process.env['KIMAKI_DB_URL'] = hranaResult

      const db = await getDb()
      const [created] = await db.insert(schema.bot_tokens)
        .values({ app_id: 'hrana-bot', token: 'test-token' })
        .returning({ appId: schema.bot_tokens.app_id })

      expect(created).toMatchInlineSnapshot(`
        {
          "appId": "hrana-bot",
        }
      `)
    } finally {
      await closeDb()
      await stopHranaServer()
      if (previousDbUrl === undefined) {
        delete process.env['KIMAKI_DB_URL']
      } else {
        process.env['KIMAKI_DB_URL'] = previousDbUrl
      }
      if (previousLockPort === undefined) {
        delete process.env['KIMAKI_LOCK_PORT']
      } else {
        process.env['KIMAKI_LOCK_PORT'] = previousLockPort
      }
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.unlinkSync(file)
        } catch {
          // Test cleanup best effort.
        }
      }
    }
  })

  test('createPendingWorkspace creates parent and child rows', async () => {
    const db = await getDb()
    const threadId = `test-workspace-${Date.now()}`

    await createPendingWorkspace({
      threadId,
      workspaceType: 'kimaki-worktree',
      workspaceName: 'regression-workspace',
      projectDirectory: '/tmp/regression-project',
    })

    const session = await db.query.thread_sessions.findFirst({
      where: { thread_id: threadId },
    })
    expect(session).toBeTruthy()
    expect(session?.session_id).toBe('')

    const workspace = await db.query.thread_workspaces.findFirst({
      where: { thread_id: threadId },
    })
    expect(workspace).toBeTruthy()
    expect(workspace?.workspace_name).toBe('regression-workspace')
    expect(workspace?.project_directory).toBe('/tmp/regression-project')
    expect(workspace?.status).toBe('pending')

    await db.delete(schema.thread_workspaces).where(orm.eq(schema.thread_workspaces.thread_id, threadId))
    await db.delete(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, threadId))
  })

  test('copyCurrentSessionModel snapshots source session model to forked session', async () => {
    const db = await getDb()
    const sourceSessionId = `test-source-session-${crypto.randomUUID()}`
    const targetSessionId = `test-target-session-${crypto.randomUUID()}`
    const getClient = (() => {
      throw new Error('provider lookup should not run for explicit session models')
    }) satisfies Exclude<Awaited<ReturnType<typeof initializeOpencodeForDirectory>>, Error>

    await setSessionModel({
      sessionId: sourceSessionId,
      modelId: 'anthropic/claude-opus-4-6',
      variant: 'thinking',
    })

    await copyCurrentSessionModel({
      sourceSessionId,
      targetSessionId,
      getClient,
    })

    await expect(getSessionModel(targetSessionId)).resolves.toMatchInlineSnapshot(`
      {
        "modelId": "anthropic/claude-opus-4-6",
        "variant": "thinking",
      }
    `)

    await db.delete(schema.session_models).where(orm.inArray(schema.session_models.session_id, [sourceSessionId, targetSessionId]))
  })

  test('session event persistence uses (timestamp, event_index) ordering for deterministic same-ms replay', async () => {
    const db = await getDb()
    const threadId = 'test-session-events-thread'
    const sessionId = 'test-session-events-session'

    await db.delete(schema.session_events).where(orm.eq(schema.session_events.session_id, sessionId))
    await db.delete(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, threadId))

    await db.insert(schema.thread_sessions).values({ thread_id: threadId, session_id: sessionId })

    const baseTimestamp = 1_700_000_000_000

    const inserted1 = await appendSessionEventsSinceLastTimestamp({
      sessionId,
      events: [
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 2,
          event_json: JSON.stringify({ id: 'e2' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 0,
          event_json: JSON.stringify({ id: 'e0' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 1,
          event_json: JSON.stringify({ id: 'e1' }),
        },
      ],
    })

    const inserted2 = await appendSessionEventsSinceLastTimestamp({
      sessionId,
      events: [
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 0,
          event_json: JSON.stringify({ id: 'e0' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 1,
          event_json: JSON.stringify({ id: 'e1' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 2,
          event_json: JSON.stringify({ id: 'e2' }),
        },
        {
          session_id: sessionId,
          thread_id: threadId,
          timestamp: baseTimestamp,
          event_index: 3,
          event_json: JSON.stringify({ id: 'e3' }),
        },
      ],
    })

    const rows = await getSessionEventSnapshot({ sessionId })
    const orderedIds = rows.map((row) => {
      const parsed = JSON.parse(row.event_json) as { id: string }
      return parsed.id
    })

    expect({ inserted1, inserted2, orderedIds }).toMatchInlineSnapshot(`
      {
        "inserted1": 3,
        "inserted2": 1,
        "orderedIds": [
          "e0",
          "e1",
          "e2",
          "e3",
        ],
      }
    `)

    await db.delete(schema.session_events).where(orm.eq(schema.session_events.session_id, sessionId))
    await db.delete(schema.thread_sessions).where(orm.eq(schema.thread_sessions.thread_id, threadId))
  })
})
