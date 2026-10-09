// Every SQLite migration of kimaki, in one place. Only the bot start runs it
// (openDb({ migrate: true })); subcommands never migrate.
//
//   <dataDir>/kimaki.db present without the DB_VERSION marker, next to a V1 file?
//     └─ not made by kimaki: rename it to kimaki.db.unknown-<time> (never deleted)
//   <dataDir>/kimaki.db missing?
//     └─ <dataDir>/discord-sessions.db (V1) present?
//          yes ─▶ build kimaki.db.import from schema.sql + the V1 rows of the
//                 tables kimaki uses, then rename it to kimaki.db (atomic: a
//                 crash leaves no half-imported kimaki.db, the next start retries)
//          no  ─▶ empty kimaki.db
//   then: schema.sql (CREATE ... IF NOT EXISTS) + the marker on kimaki.db
//
// The V1 file is opened read-only and never changed or deleted, so V1 keeps
// working on its own data. There is no downgrade: changes made by kimaki stay in
// kimaki.db. Future schema changes (ALTER TABLE ... ADD COLUMN) go in
// migrateSchema() below.

import fs from 'node:fs'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import * as errore from 'errore'

import { DbError } from './errors.ts'
import { createLogger } from './logger.ts'
import { SCHEMA_SQL } from './schema-sql.ts'

const logger = createLogger('DB')

export const DB_FILE = 'kimaki.db'
export const LEGACY_DB_FILE = 'discord-sessions.db'

// PRAGMA user_version of every kimaki.db written by migrateSchema(). A stray
// kimaki.db without it (an empty file from another tool, a pre-marker dev
// build) must not block the V1 import: then the user gets onboarding again.
export const DB_VERSION = 1

// Parents first, so imported rows satisfy the foreign keys.
const IMPORTED_TABLES = [
  'bot_tokens',
  'bot_api_keys',
  'guild_categories',
  'channel_directories',
  'channel_models',
  'global_models',
  'channel_agents',
  'channel_worktrees',
  'channel_verbosity',
  'channel_mention_mode',
  'thread_sessions',
  'scheduled_tasks',
  'session_sleeps',
] as const

// V1 values kimaki reads differently. Old V1 rows can carry the DDL default
// 'self-hosted' (hyphen) or NULL; kimaki only knows 'self_hosted' | 'gateway'.
const IMPORT_EXPRESSIONS: Partial<Record<(typeof IMPORTED_TABLES)[number], Record<string, string>>> = {
  bot_tokens: { bot_mode: `CASE WHEN bot_mode = 'gateway' THEN 'gateway' ELSE 'self_hosted' END` },
}

export function schemaStatements(): string[] {
  return SCHEMA_SQL.split(';')
    .map((statement) => {
      return statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
    })
    .filter((statement) => statement.length > 0)
}

async function columnsOf({ client, schema, table }: { client: Client; schema: 'main' | 'legacy'; table: string }) {
  const rows = await client.execute(`PRAGMA ${schema}.table_info("${table}")`)
  return rows.rows.map((row) => ({ name: String(row.name), notNull: Number(row.notnull) === 1 || Number(row.pk) > 0 }))
}

// One entry per FK column: the schema has only single-column foreign keys
// with an explicit parent column. A composite FK would need grouping by `id`.
async function foreignKeysOf({ client, table }: { client: Client; table: string }) {
  const rows = await client.execute(`PRAGMA main.foreign_key_list("${table}")`)
  return rows.rows.map((row) => ({ column: String(row.from), parent: String(row.table), parentColumn: String(row.to) }))
}

// Copies the V1 rows into `client` (an empty file with schema.sql applied).
// Most V1 tables have no foreign keys, so real installs hold rows that point
// at deleted channels or threads: a required reference skips the row, an
// optional one becomes NULL (like ON DELETE SET NULL).
async function copyLegacyRows({ client, legacyFile }: { client: Client; legacyFile: string }): Promise<void> {
  await client.execute({ sql: 'ATTACH DATABASE ? AS legacy', args: [`file:${legacyFile}?mode=ro`] })
  for (const table of IMPORTED_TABLES) {
    const legacyColumns = (await columnsOf({ client, schema: 'legacy', table })).map((column) => column.name)
    if (legacyColumns.length === 0) {
      logger.log(`import ${table}: not in ${LEGACY_DB_FILE}, skipped`)
      continue
    }
    // Columns an older V1 file lacks get the kimaki default.
    const columns = (await columnsOf({ client, schema: 'main', table })).filter((column) => legacyColumns.includes(column.name))
    const foreignKeys = (await foreignKeysOf({ client, table })).filter((key) => legacyColumns.includes(key.column))
    const existsIn = (key: (typeof foreignKeys)[number]) => `"${key.column}" IN (SELECT "${key.parentColumn}" FROM main."${key.parent}")`
    const expressions = columns.map((column) => {
      const custom = IMPORT_EXPRESSIONS[table]?.[column.name]
      if (custom) return custom
      const key = foreignKeys.find((candidate) => candidate.column === column.name)
      if (key && !column.notNull) return `CASE WHEN ${existsIn(key)} THEN "${column.name}" END`
      return `"${column.name}"`
    })
    const required = foreignKeys.filter((key) => columns.some((column) => column.name === key.column && column.notNull))
    const where = required.length > 0 ? ` WHERE ${required.map(existsIn).join(' AND ')}` : ''
    const inserted = await client.execute(
      `INSERT INTO main."${table}" (${columns.map((column) => `"${column.name}"`).join(', ')}) SELECT ${expressions.join(', ')} FROM legacy."${table}"${where}`,
    )
    const total = await client.execute(`SELECT count(*) FROM legacy."${table}"`)
    const skipped = Number(total.rows[0]?.[0] ?? 0) - inserted.rowsAffected
    logger.log(`import ${table}: ${inserted.rowsAffected} rows${skipped > 0 ? `, ${skipped} skipped (missing parent row)` : ''}`)
  }
  await client.execute('DETACH DATABASE legacy')
}

async function readDbVersion({ file }: { file: string }): Promise<DbError | number> {
  const client = createClient({ url: `file:${file}` })
  const version = await client
    .execute('PRAGMA user_version')
    .then((result) => Number(result.rows[0]?.[0] ?? 0))
    // Not an SQLite file at all: unmarked too, so it is set aside like any stray file.
    .catch((e) => (Reflect.get(e, 'code') === 'SQLITE_NOTADB' ? 0 : new DbError({ operation: `read version of ${file}`, cause: e })))
  client.close()
  return version
}

// Renames file and its WAL files. The WAL files go first and keep their
// suffix, so a crash never leaves a foreign -wal next to a new kimaki.db.
function setAside({ file }: { file: string }): DbError | string {
  const target = `${file}.unknown-${new Date().toISOString().replace(/[:.]/g, '-')}`
  return errore.try(
    () => {
      for (const suffix of ['-wal', '-shm', '']) {
        if (fs.existsSync(`${file}${suffix}`)) fs.renameSync(`${file}${suffix}`, `${target}${suffix}`)
      }
      return target
    },
    (e) => new DbError({ operation: `rename ${file}`, cause: e }),
  )
}

// Picks or creates the database file. Returns its path.
async function prepareDbFile({ dataDir }: { dataDir: string }): Promise<DbError | string> {
  const file = path.join(dataDir, DB_FILE)
  const legacyFile = path.join(dataDir, LEGACY_DB_FILE)
  const hasLegacy = fs.existsSync(legacyFile)
  if (fs.existsSync(file)) {
    // Without a V1 file there is nothing to import: keep it, migrateSchema() marks it.
    if (!hasLegacy) return file
    const version = await readDbVersion({ file })
    if (version instanceof Error) return version
    if (version >= DB_VERSION) return file
    const moved = setAside({ file })
    if (moved instanceof Error) return moved
    logger.warn(`${file} was not made by kimaki (no version marker), moved it to ${moved}`)
  }
  if (!hasLegacy) return file
  logger.log(`first start of this version: importing ${legacyFile} into ${file}`)
  const target = `${file}.import`
  fs.rmSync(target, { force: true })
  const client = createClient({ url: `file:${target}` })
  const imported = await migrateSchema({ client })
    .then(() => copyLegacyRows({ client, legacyFile }))
    .catch((e) => new DbError({ operation: `import ${legacyFile}`, cause: e }))
  client.close()
  if (imported instanceof Error) {
    fs.rmSync(target, { force: true })
    return imported
  }
  const renamed = errore.try(
    () => fs.renameSync(target, file),
    (e) => new DbError({ operation: `rename ${target}`, cause: e }),
  )
  if (renamed instanceof Error) return renamed
  logger.log(`import done, ${legacyFile} is kept unchanged`)
  return file
}

// Schema of an open kimaki.db: schema.sql is idempotent. Add future
// ALTER TABLE migrations here, before schema.sql when a new index needs them.
async function migrateSchema({ client }: { client: Client }): Promise<void> {
  for (const statement of schemaStatements()) await client.execute(statement)
  await client.execute(`PRAGMA user_version = ${DB_VERSION}`)
}

export async function migrateDb({ dataDir }: { dataDir: string }): Promise<DbError | string> {
  const file = await prepareDbFile({ dataDir })
  if (file instanceof Error) return file
  const client = createClient({ url: `file:${file}` })
  const migrated = await migrateSchema({ client }).catch((e) => new DbError({ operation: 'migrate schema', cause: e }))
  client.close()
  if (migrated instanceof Error) return migrated
  return file
}
