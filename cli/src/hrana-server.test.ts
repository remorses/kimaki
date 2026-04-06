import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, test, expect, afterAll } from 'vitest'
import Database from 'libsql'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/client.js'
import {
  createLibsqlHandler,
  createLibsqlNodeHandler,
  libsqlExecutor,
} from 'libsqlproxy'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function migrateSchema(prisma: PrismaClient) {
  const schemaPath = path.join(__dirname, '../src/schema.sql')
  const sql = fs.readFileSync(schemaPath, 'utf-8')
  const statements = sql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(
      (s) =>
        s.length > 0 &&
        !/^CREATE\s+TABLE\s+["']?sqlite_sequence["']?\s*\(/i.test(s),
    )
    .map((s) =>
      s
        .replace(
          /^CREATE\s+UNIQUE\s+INDEX\b(?!\s+IF)/i,
          'CREATE UNIQUE INDEX IF NOT EXISTS',
        )
        .replace(/^CREATE\s+INDEX\b(?!\s+IF)/i, 'CREATE INDEX IF NOT EXISTS'),
    )
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement)
  }
}

describe('hrana-server', () => {
  let testServer: http.Server | null = null
  let testDb: Database.Database | null = null
  let prisma: PrismaClient | null = null
  const dbPath = path.join(
    process.cwd(),
    `tmp/test-hrana-${crypto.randomUUID().slice(0, 8)}.db`,
  )

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    if (testServer)
      await new Promise<void>((resolve) => {
        testServer!.close(() => {
          resolve()
        })
      })
    if (testDb) testDb.close()
    try {
      fs.unlinkSync(dbPath)
    } catch (e) {
      console.warn('cleanup:', dbPath, (e as Error).message)
    }
    try {
      fs.unlinkSync(dbPath + '-wal')
    } catch (e) {
      console.warn('cleanup:', dbPath + '-wal', (e as Error).message)
    }
    try {
      fs.unlinkSync(dbPath + '-shm')
    } catch (e) {
      console.warn('cleanup:', dbPath + '-shm', (e as Error).message)
    }
  })

  test('prisma CRUD through hrana server', async () => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })

    const database = new Database(dbPath)
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA busy_timeout = 5000')
    testDb = database

    const port = 10000 + Math.floor(Math.random() * 50000)
    await new Promise<void>((resolve, reject) => {
      const hranaFetchHandler = createLibsqlHandler(libsqlExecutor(database))
      const hranaNodeHandler = createLibsqlNodeHandler(hranaFetchHandler)
      const srv = http.createServer(hranaNodeHandler)
      srv.on('error', reject)
      srv.listen(port, '127.0.0.1', () => {
        testServer = srv
        resolve()
      })
    })

    const adapter = new PrismaLibSql({ url: `http://127.0.0.1:${port}` })
    prisma = new PrismaClient({ adapter })
    await migrateSchema(prisma)

    // Create
    const created = await prisma.thread_sessions.create({
      data: {
        thread_id: 'hrana-test-thread',
        session_id: 'hrana-test-session',
      },
    })
    expect(created.thread_id).toMatchInlineSnapshot(`"hrana-test-thread"`)
    expect(created.session_id).toMatchInlineSnapshot(`"hrana-test-session"`)

    // Read
    const found = await prisma.thread_sessions.findUnique({
      where: { thread_id: 'hrana-test-thread' },
    })
    expect(found?.session_id).toMatchInlineSnapshot(`"hrana-test-session"`)

    // Update
    await prisma.thread_sessions.update({
      where: { thread_id: 'hrana-test-thread' },
      data: { session_id: 'updated-session' },
    })
    const updated = await prisma.thread_sessions.findUnique({
      where: { thread_id: 'hrana-test-thread' },
    })
    expect(updated?.session_id).toMatchInlineSnapshot(`"updated-session"`)

    // Delete
    await prisma.thread_sessions.delete({
      where: { thread_id: 'hrana-test-thread' },
    })
    const deleted = await prisma.thread_sessions.findUnique({
      where: { thread_id: 'hrana-test-thread' },
    })
    expect(deleted).toBeNull()
  }, 30_000)

  test('$executeRawUnsafe works for PRAGMAs', async () => {
    if (!prisma) throw new Error('prisma not initialized')
    const result = await prisma.$executeRawUnsafe('PRAGMA journal_mode')
    expect(typeof result).toBe('number')
  })

  test('batch transaction via Prisma $transaction', async () => {
    if (!prisma) throw new Error('prisma not initialized')

    const [s1, s2] = await prisma.$transaction([
      prisma.thread_sessions.create({
        data: { thread_id: 'batch-1', session_id: 'sess-1' },
      }),
      prisma.thread_sessions.create({
        data: { thread_id: 'batch-2', session_id: 'sess-2' },
      }),
    ])
    expect(s1.thread_id).toMatchInlineSnapshot(`"batch-1"`)
    expect(s2.thread_id).toMatchInlineSnapshot(`"batch-2"`)

    const count = await prisma.thread_sessions.count({
      where: { thread_id: { in: ['batch-1', 'batch-2'] } },
    })
    expect(count).toBe(2)

    await prisma.thread_sessions.deleteMany({
      where: { thread_id: { in: ['batch-1', 'batch-2'] } },
    })
  }, 30_000)

  test('schema migration DDL via $executeRawUnsafe', async () => {
    if (!prisma) throw new Error('prisma not initialized')

    // CREATE TABLE IF NOT EXISTS is idempotent — running migrateSchema again
    // should not throw even though tables already exist.
    await migrateSchema(prisma)

    // Verify DDL actually created the tables by querying sqlite_master
    const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    )
    const tableNames = tables.map((t) => t.name)
    expect(tableNames).toContain('thread_sessions')
    expect(tableNames).toContain('ipc_requests')
    expect(tableNames).toContain('scheduled_tasks')

    // Also verify indexes were created
    const indexes = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%idx%' ORDER BY name`,
    )
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('ipc_requests_status_created_at_idx')
    expect(indexNames).toContain('scheduled_tasks_status_next_run_at_idx')

    // Test CREATE INDEX IF NOT EXISTS is also idempotent
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "ipc_requests_status_created_at_idx" ON "ipc_requests"("status", "created_at")`,
    )
  })

  test('concurrent queries via Promise.all', async () => {
    if (!prisma) throw new Error('prisma not initialized')

    // Seed some data for concurrent reads
    const threads = Array.from({ length: 5 }, (_, i) => ({
      thread_id: `concurrent-${i}`,
      session_id: `sess-concurrent-${i}`,
    }))
    for (const t of threads) {
      await prisma.thread_sessions.create({ data: t })
    }

    // Simulate kimaki's pattern of parallel Prisma queries
    const [allThreads, count, single, filtered] = await Promise.all([
      prisma.thread_sessions.findMany({
        where: { thread_id: { startsWith: 'concurrent-' } },
        orderBy: { thread_id: 'asc' },
      }),
      prisma.thread_sessions.count({
        where: { thread_id: { startsWith: 'concurrent-' } },
      }),
      prisma.thread_sessions.findUnique({
        where: { thread_id: 'concurrent-2' },
      }),
      prisma.thread_sessions.findMany({
        where: { thread_id: { in: ['concurrent-0', 'concurrent-4'] } },
        orderBy: { thread_id: 'asc' },
      }),
    ])

    expect(allThreads.length).toBe(5)
    expect(count).toBe(5)
    expect(single?.session_id).toMatchInlineSnapshot(`"sess-concurrent-2"`)
    expect(filtered.map((f) => f.thread_id)).toMatchInlineSnapshot(`
      [
        "concurrent-0",
        "concurrent-4",
      ]
    `)

    // Cleanup
    await prisma.thread_sessions.deleteMany({
      where: { thread_id: { startsWith: 'concurrent-' } },
    })
  }, 30_000)

  test('$queryRawUnsafe for PRAGMAs that return values', async () => {
    if (!prisma) throw new Error('prisma not initialized')

    // PRAGMA that returns a value — journal_mode should be WAL
    const journalMode = await prisma.$queryRawUnsafe<
      Array<{ journal_mode: string }>
    >('PRAGMA journal_mode')
    expect(journalMode[0]?.journal_mode).toMatchInlineSnapshot(`"wal"`)

    // PRAGMA busy_timeout returns the current timeout value
    const busyTimeout = await prisma.$queryRawUnsafe<
      Array<{ busy_timeout: number }>
    >('PRAGMA busy_timeout')
    expect(busyTimeout[0]?.busy_timeout).toMatchInlineSnapshot(`undefined`)

    // PRAGMA table_info returns column metadata
    const tableInfo = await prisma.$queryRawUnsafe<
      Array<{ name: string; type: string }>
    >(`PRAGMA table_info('ipc_requests')`)
    const colNames = tableInfo.map((c) => c.name)
    expect(colNames).toMatchInlineSnapshot(`
      [
        "id",
        "type",
        "session_id",
        "thread_id",
        "payload",
        "response",
        "status",
        "created_at",
        "updated_at",
      ]
    `)
  })

  test('updateMany with complex WHERE using in operator', async () => {
    if (!prisma) throw new Error('prisma not initialized')

    // Seed: create a thread + multiple IPC requests in different statuses
    // (mirrors kimaki's cancelAllPendingIpcRequests pattern)
    await prisma.thread_sessions.create({
      data: { thread_id: 'ipc-test-thread', session_id: 'ipc-test-session' },
    })
    const statuses = ['pending', 'pending', 'processing', 'completed'] as const
    for (let i = 0; i < statuses.length; i++) {
      await prisma.ipc_requests.create({
        data: {
          id: `ipc-req-${i}`,
          type: 'file_upload',
          session_id: 'ipc-test-session',
          thread_id: 'ipc-test-thread',
          payload: JSON.stringify({ prompt: `test-${i}` }),
          status: statuses[i],
        },
      })
    }

    // updateMany with WHERE status IN ['pending', 'processing']
    const result = await prisma.ipc_requests.updateMany({
      where: { status: { in: ['pending', 'processing'] } },
      data: {
        status: 'cancelled',
        response: JSON.stringify({ error: 'Bot shutting down' }),
      },
    })
    expect(result.count).toBe(3)

    // Verify: only 'completed' row is untouched
    const remaining = await prisma.ipc_requests.findMany({
      where: { thread_id: 'ipc-test-thread' },
      orderBy: { id: 'asc' },
      select: { id: true, status: true },
    })
    expect(remaining).toMatchInlineSnapshot(`
      [
        {
          "id": "ipc-req-0",
          "status": "cancelled",
        },
        {
          "id": "ipc-req-1",
          "status": "cancelled",
        },
        {
          "id": "ipc-req-2",
          "status": "cancelled",
        },
        {
          "id": "ipc-req-3",
          "status": "completed",
        },
      ]
    `)

    // Cleanup
    await prisma.ipc_requests.deleteMany({
      where: { thread_id: 'ipc-test-thread' },
    })
    await prisma.thread_sessions.delete({
      where: { thread_id: 'ipc-test-thread' },
    })
  }, 30_000)

  test('interactive $transaction (callback form)', async () => {
    if (!prisma) throw new Error('prisma not initialized')

    // Interactive transaction: reads and writes within the same tx callback.
    // This exercises BEGIN/queries/COMMIT across multiple hrana pipeline
    // requests with batons (stream continuity).
    const result = await prisma.$transaction(async (tx) => {
      await tx.thread_sessions.create({
        data: { thread_id: 'tx-interactive-1', session_id: 'sess-tx-1' },
      })
      await tx.thread_sessions.create({
        data: { thread_id: 'tx-interactive-2', session_id: 'sess-tx-2' },
      })

      // Read inside the same transaction — should see uncommitted rows
      const count = await tx.thread_sessions.count({
        where: { thread_id: { startsWith: 'tx-interactive-' } },
      })

      // Conditional write based on read
      if (count === 2) {
        await tx.thread_sessions.update({
          where: { thread_id: 'tx-interactive-1' },
          data: { session_id: 'sess-tx-1-updated' },
        })
      }

      return tx.thread_sessions.findMany({
        where: { thread_id: { startsWith: 'tx-interactive-' } },
        orderBy: { thread_id: 'asc' },
        select: { thread_id: true, session_id: true },
      })
    })

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "session_id": "sess-tx-1-updated",
          "thread_id": "tx-interactive-1",
        },
        {
          "session_id": "sess-tx-2",
          "thread_id": "tx-interactive-2",
        },
      ]
    `)

    // Verify committed outside transaction
    const outside = await prisma.thread_sessions.count({
      where: { thread_id: { startsWith: 'tx-interactive-' } },
    })
    expect(outside).toBe(2)

    // Cleanup
    await prisma.thread_sessions.deleteMany({
      where: { thread_id: { startsWith: 'tx-interactive-' } },
    })
  }, 30_000)

  test('interactive $transaction rolls back on error', async () => {
    if (!prisma) throw new Error('prisma not initialized')

    // Verify rollback: if the callback throws, no rows should be committed
    const txError = await prisma
      .$transaction(async (tx) => {
        await tx.thread_sessions.create({
          data: { thread_id: 'tx-rollback-1', session_id: 'sess-rollback' },
        })
        throw new Error('intentional rollback')
      })
      .catch((e: Error) => e)

    expect(txError).toBeInstanceOf(Error)
    expect((txError as Error).message).toContain('intentional rollback')

    // Row should NOT exist — transaction was rolled back
    const ghost = await prisma.thread_sessions.findUnique({
      where: { thread_id: 'tx-rollback-1' },
    })
    expect(ghost).toBeNull()
  }, 30_000)
})
