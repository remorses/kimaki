// Every SQLite migration of cli2, in one place. Only the bot start runs it
// (openDb({ migrate: true })); subcommands never migrate.
//
//   <dataDir>/kimaki.db missing?
//     └─ <dataDir>/discord-sessions.db (V1) present?
//          yes ─▶ build kimaki.db.import from schema.sql + the V1 rows of the
//                 tables cli2 uses, then rename it to kimaki.db (atomic: a
//                 crash leaves no half-imported kimaki.db, the next start retries)
//          no  ─▶ empty kimaki.db
//   then: schema.sql (CREATE ... IF NOT EXISTS) on kimaki.db
//
// The V1 file is opened read-only and never changed or deleted, so V1 keeps
// working on its own data. There is no downgrade: changes made by cli2 stay in
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

// Parents first, so imported rows satisfy the foreign keys.
const IMPORTED_TABLES = [
  'bot_tokens',
  'bot_api_keys',
  'guild_categories',
  'channel_directories',
  'channel_models',
  'channel_agents',
  'channel_worktrees',
  'channel_verbosity',
  'channel_mention_mode',
  'thread_sessions',
  'scheduled_tasks',
  'session_sleeps',
] as const

// V1 values cli2 reads differently. Old V1 rows can carry the DDL default
// 'self-hosted' (hyphen) or NULL; cli2 only knows 'self_hosted' | 'gateway'.
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
  return rows.rows.map((row) => String(row.name))
}

// Copies the V1 rows into `client` (an empty file with schema.sql applied).
async function copyLegacyRows({ client, legacyFile }: { client: Client; legacyFile: string }): Promise<void> {
  await client.execute({ sql: 'ATTACH DATABASE ? AS legacy', args: [`file:${legacyFile}?mode=ro`] })
  for (const table of IMPORTED_TABLES) {
    const legacyColumns = await columnsOf({ client, schema: 'legacy', table })
    if (legacyColumns.length === 0) {
      logger.log(`import ${table}: not in ${LEGACY_DB_FILE}, skipped`)
      continue
    }
    // Columns an older V1 file lacks get the cli2 default.
    const columns = (await columnsOf({ client, schema: 'main', table })).filter((column) => legacyColumns.includes(column))
    const expressions = columns.map((column) => IMPORT_EXPRESSIONS[table]?.[column] ?? `"${column}"`)
    const inserted = await client.execute(
      `INSERT INTO main."${table}" (${columns.map((column) => `"${column}"`).join(', ')}) SELECT ${expressions.join(', ')} FROM legacy."${table}"`,
    )
    logger.log(`import ${table}: ${inserted.rowsAffected} rows`)
  }
  await client.execute('DETACH DATABASE legacy')
}

// Picks or creates the database file. Returns its path.
async function prepareDbFile({ dataDir }: { dataDir: string }): Promise<DbError | string> {
  const file = path.join(dataDir, DB_FILE)
  if (fs.existsSync(file)) return file
  const legacyFile = path.join(dataDir, LEGACY_DB_FILE)
  if (!fs.existsSync(legacyFile)) return file
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
