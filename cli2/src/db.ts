// SQLite access through Drizzle + libSQL, file <dataDir>/kimaki.db. Only the
// bot start opens with migrate: true (migrations.ts: V1 import + schema).
// Subcommands open without migrating and fail with DbNotMigratedError when the
// file or a table is missing; they never create the file, so the next bot
// start still imports the V1 database.

import fs from 'node:fs'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import * as orm from 'drizzle-orm'
import * as errore from 'errore'
import { drizzle } from 'drizzle-orm/libsql'
import * as s from 'drizzle-orm/sqlite-core'

import { DbError, DbNotMigratedError } from './errors.ts'
import { DB_FILE, migrateDb } from './migrations.ts'
import * as schema from './schema.ts'

function createDrizzle(client: Client) {
  return drizzle({ client, schema, relations: schema.relations })
}

export type KimakiDb = ReturnType<typeof createDrizzle>

export type OpenedDb = {
  db: KimakiDb
  client: Client
  close: () => void
}

export const REQUIRED_TABLES: string[] = Object.values(schema)
  .flatMap((value) => (orm.is(value, s.SQLiteTable) ? [orm.getTableName(value)] : []))
  .sort()

export function dbPath({ dataDir }: { dataDir: string }): string {
  return path.join(dataDir, DB_FILE)
}

export async function openDb({
  dataDir,
  migrate,
}: {
  dataDir: string
  migrate: boolean
}): Promise<DbError | DbNotMigratedError | OpenedDb> {
  const created = errore.try(
    () => fs.mkdirSync(dataDir, { recursive: true }),
    (e) => new DbError({ operation: `create ${dataDir}`, cause: e }),
  )
  if (created instanceof Error) return created
  if (migrate) {
    const migrated = await migrateDb({ dataDir })
    if (migrated instanceof Error) return migrated
  }
  if (!fs.existsSync(dbPath({ dataDir }))) return new DbNotMigratedError({ missing: DB_FILE })
  const client = createClient({ url: `file:${dbPath({ dataDir })}` })
  const setup = await (async () => {
    await client.execute('PRAGMA journal_mode = WAL')
    await client.execute('PRAGMA busy_timeout = 5000')
    const rows = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    return new Set(rows.rows.map((row) => String(row.name)))
  })().catch((e) => new DbError({ operation: 'open', cause: e }))
  if (setup instanceof Error) {
    client.close()
    return setup
  }
  const missing = REQUIRED_TABLES.find((table) => !setup.has(table))
  if (missing) {
    client.close()
    return new DbNotMigratedError({ missing: `table ${missing}` })
  }
  return { db: createDrizzle(client), client, close: () => client.close() }
}

// V2 has two verbosity levels; the V1 enum stays on disk (spec section 17).
export type Verbosity = 'text' | 'tools'

export function verbosityFromV1(value: schema.V1Verbosity | null | undefined): Verbosity {
  if (value === 'text_only') return 'text'
  return 'tools'
}

export function verbosityToV1(value: Verbosity): schema.V1Verbosity {
  if (value === 'text') return 'text_only'
  return 'text_and_essential_tools'
}

export async function readChannelVerbosity({
  db,
  channelId,
}: {
  db: KimakiDb
  channelId: string
}): Promise<DbError | Verbosity> {
  const row = await db.query.channel_verbosity
    .findFirst({ where: { channel_id: channelId } })
    .catch((e) => new DbError({ operation: 'read channel_verbosity', cause: e }))
  if (row instanceof Error) return row
  return verbosityFromV1(row?.verbosity)
}
