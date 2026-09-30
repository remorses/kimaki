// SQLite access through Drizzle + libSQL. Same file as V1
// (<dataDir>/discord-sessions.db), subset of V1 tables with identical DDL.
// Only the bot start opens with migrate: true, which runs the idempotent
// schema.sql. Subcommands open without migrating and fail with
// DbNotMigratedError when a table is missing.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type Client } from '@libsql/client'
import * as orm from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import * as s from 'drizzle-orm/sqlite-core'

import { DbError, DbNotMigratedError } from './errors.ts'
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
  return path.join(dataDir, 'discord-sessions.db')
}

// Works from src/ (tests, tsx) and dist/ (build): both resolve to src/schema.sql.
function schemaSqlPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/schema.sql')
}

export function schemaStatements(): string[] {
  return fs
    .readFileSync(schemaSqlPath(), 'utf8')
    .split(';')
    .map((statement) => {
      return statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
    })
    .filter((statement) => statement.length > 0)
}

export async function openDb({
  dataDir,
  migrate,
}: {
  dataDir: string
  migrate: boolean
}): Promise<DbError | DbNotMigratedError | OpenedDb> {
  fs.mkdirSync(dataDir, { recursive: true })
  const client = createClient({ url: `file:${dbPath({ dataDir })}` })
  const setup = await (async () => {
    await client.execute('PRAGMA journal_mode = WAL')
    await client.execute('PRAGMA busy_timeout = 5000')
    if (migrate) {
      for (const statement of schemaStatements()) {
        await client.execute(statement)
      }
    }
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
    return new DbNotMigratedError({ table: missing })
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
