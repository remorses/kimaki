// Tests Drizzle access through the in-process Hrana/libSQL HTTP server.

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'
import Database from 'libsql'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as orm from 'drizzle-orm'
import {
  createLibsqlHandler,
  createLibsqlNodeHandler,
  libsqlExecutor,
} from 'libsqlproxy'
import * as schema from './schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function migrateSchema(client: Client) {
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
    await client.execute(statement)
  }
}

describe('hrana-server', () => {
  let testServer: http.Server | null = null
  let testDb: Database.Database | null = null
  let client: Client | null = null
  const dbPath = path.join(
    process.cwd(),
    `tmp/test-hrana-${crypto.randomUUID().slice(0, 8)}.db`,
  )

  afterAll(async () => {
    client?.close()
    if (testServer) {
      await new Promise<void>((resolve) => {
        testServer!.close(() => resolve())
      })
    }
    testDb?.close()
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        fs.unlinkSync(file)
      } catch {
        // Test cleanup best effort.
      }
    }
  })

  test('Drizzle CRUD through hrana server', async () => {
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

    client = createClient({ url: `http://127.0.0.1:${port}` })
    const db = drizzle({ client, schema, relations: schema.relations })
    await migrateSchema(client)

    const [created] = await db.insert(schema.thread_sessions)
      .values({ thread_id: 'hrana-test-thread', session_id: 'hrana-test-session' })
      .returning()
    expect(created?.thread_id).toMatchInlineSnapshot(`"hrana-test-thread"`)
    expect(created?.session_id).toMatchInlineSnapshot(`"hrana-test-session"`)

    const found = await db.query.thread_sessions.findFirst({
      where: { thread_id: 'hrana-test-thread' },
    })
    expect(found?.session_id).toMatchInlineSnapshot(`"hrana-test-session"`)

    await db.update(schema.thread_sessions)
      .set({ session_id: 'updated-session' })
      .where(orm.eq(schema.thread_sessions.thread_id, 'hrana-test-thread'))
    const updated = await db.query.thread_sessions.findFirst({
      where: { thread_id: 'hrana-test-thread' },
    })
    expect(updated?.session_id).toMatchInlineSnapshot(`"updated-session"`)

    await db.delete(schema.thread_sessions).where(
      orm.eq(schema.thread_sessions.thread_id, 'hrana-test-thread'),
    )
    const deleted = await db.query.thread_sessions.findFirst({
      where: { thread_id: 'hrana-test-thread' },
    })
    expect(deleted).toBeUndefined()
  }, 30_000)
})
