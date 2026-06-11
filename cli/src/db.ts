// Drizzle client initialization with libSQL.
// Uses KIMAKI_DB_URL env var when set (plugin process → Hrana HTTP),
// otherwise falls back to direct file: access (bot process, CLI subcommands).
// Schema bootstrap runs in both modes because tests and plugin children may be
// the first process to touch a fresh SQLite file through Hrana.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient, type Client } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as orm from 'drizzle-orm'
import { fileURLToPath } from 'node:url'

import { getDataDir } from './config.js'
import { createLogger, formatErrorWithStack, LogPrefix } from './logger.js'
import * as schema from './schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function createDrizzleClient(client: Client) {
  return drizzle({ client, schema, relations: schema.relations })
}

export type KimakiDb = ReturnType<typeof createDrizzleClient>

const dbLogger = createLogger(LogPrefix.DB)

let clientInstance: Client | null = null
let dbInstance: KimakiDb | null = null
let initPromise: Promise<KimakiDb> | null = null

// Under vitest, clear any inherited KIMAKI_DB_URL from the parent bot process
// so tests default to file-based access using the auto-isolated temp data dir.
// Tests that need Hrana can set KIMAKI_DB_URL explicitly after import.
if (process.env.KIMAKI_VITEST) {
  delete process.env['KIMAKI_DB_URL']
}

export function getDb(): Promise<KimakiDb> {
  if (dbInstance) {
    return Promise.resolve(dbInstance)
  }
  if (initPromise) {
    return initPromise
  }
  initPromise = initializeDb()
  return initPromise
}

function getDbUrl(): string {
  if (process.env.KIMAKI_DB_URL) {
    return process.env.KIMAKI_DB_URL
  }
  const dataDir = getDataDir()
  const dbPath = path.join(dataDir, 'discord-sessions.db')
  return `file:${dbPath}`
}

function getDbAuthToken(): string | undefined {
  const token = process.env.KIMAKI_DB_AUTH_TOKEN
  if (!token) {
    return undefined
  }
  return token
}

async function initializeDb(): Promise<KimakiDb> {
  const dbUrl = getDbUrl()
  const isFileMode = dbUrl.startsWith('file:')

  if (isFileMode) {
    const dataDir = getDataDir()
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch (e) {
      dbLogger.error(`Failed to create data directory ${dataDir}:`, (e as Error).message)
    }
  }

  dbLogger.log(`Opening database via: ${dbUrl}`)

  const dbAuthToken = getDbAuthToken()
  const client = createClient({
    url: dbUrl,
    ...(dbAuthToken && { authToken: dbAuthToken }),
  })
  const db = createDrizzleClient(client)

  try {
    if (isFileMode) {
      await client.execute('PRAGMA journal_mode = WAL')
      await client.execute('PRAGMA busy_timeout = 5000')
    }

    dbLogger.log('Running schema migrations...')
    await migrateSchema({ db, client })
    dbLogger.log('Schema migration complete')
  } catch (error) {
    dbLogger.error('Drizzle init failed:', formatErrorWithStack(error))
    throw error
  }

  clientInstance = client
  dbInstance = db
  return db
}

async function migrateSchema({ db, client }: { db: KimakiDb; client: Client }): Promise<void> {
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
    .filter((s) => s.length > 0 && !/^CREATE\s+TABLE\s+["']?sqlite_sequence["']?\s*\(/i.test(s))
    .map((s) =>
      s
        .replace(/^CREATE\s+UNIQUE\s+INDEX\b(?!\s+IF)/i, 'CREATE UNIQUE INDEX IF NOT EXISTS')
        .replace(/^CREATE\s+INDEX\b(?!\s+IF)/i, 'CREATE INDEX IF NOT EXISTS'),
    )
  for (const statement of statements) {
    await client.execute(statement)
  }

  const alterStatements = [
    'ALTER TABLE channel_models ADD COLUMN variant TEXT',
    'ALTER TABLE session_models ADD COLUMN variant TEXT',
    'ALTER TABLE global_models ADD COLUMN variant TEXT',
    'ALTER TABLE bot_api_keys ADD COLUMN openai_api_key TEXT',
    "ALTER TABLE bot_tokens ADD COLUMN bot_mode TEXT DEFAULT 'self_hosted'",
    'ALTER TABLE bot_tokens ADD COLUMN client_id TEXT',
    'ALTER TABLE bot_tokens ADD COLUMN client_secret TEXT',
    'ALTER TABLE bot_tokens ADD COLUMN proxy_url TEXT',
    'ALTER TABLE bot_tokens ADD COLUMN last_used_at DATETIME',
    "ALTER TABLE thread_sessions ADD COLUMN source TEXT DEFAULT 'kimaki'",
    'ALTER TABLE thread_sessions ADD COLUMN last_synced_name TEXT',
    'ALTER TABLE thread_sessions ADD COLUMN cleanup_prompted_at DATETIME',
  ]
  for (const stmt of alterStatements) {
    await client.execute(stmt).catch(() => undefined)
  }

  const migrationStatements = [
    `
      UPDATE session_models SET variant = (
        SELECT thinking_value FROM session_thinking
        WHERE session_thinking.session_id = session_models.session_id
      ) WHERE variant IS NULL AND EXISTS (
        SELECT 1 FROM session_thinking WHERE session_thinking.session_id = session_models.session_id
      )
    `,
    "UPDATE channel_verbosity SET verbosity = 'tools_and_text' WHERE verbosity = 'tools-and-text'",
    "UPDATE channel_verbosity SET verbosity = 'text_and_essential_tools' WHERE verbosity = 'text-and-essential-tools'",
    "UPDATE channel_verbosity SET verbosity = 'text_only' WHERE verbosity = 'text-only'",
    "UPDATE bot_tokens SET bot_mode = 'self_hosted' WHERE bot_mode = 'self-hosted'",
    "UPDATE bot_tokens SET proxy_url = REPLACE(proxy_url, 'discord-gateway.kimaki.xyz', 'discord-gateway.kimaki.dev') WHERE bot_mode = 'gateway' AND proxy_url LIKE '%discord-gateway.kimaki.xyz%'",
    "UPDATE thread_worktrees SET status = 'pending' WHERE status IS NULL",
  ]
  for (const stmt of migrationStatements) {
    await client.execute(stmt).catch(() => undefined)
  }

  const botRows = await db.query.bot_tokens
    .findMany({
      columns: {
        app_id: true,
        client_id: true,
        client_secret: true,
      },
    })
    .catch(() => [])
  for (const botRow of botRows) {
    if (botRow.client_id && botRow.client_secret) {
      continue
    }
    await db
      .update(schema.bot_tokens)
      .set({
        client_id: crypto.randomUUID(),
        client_secret: crypto.randomBytes(32).toString('hex'),
      })
      .where(orm.eq(schema.bot_tokens.app_id, botRow.app_id))
      .catch(() => undefined)
  }
}

export async function closeDb(): Promise<void> {
  if (clientInstance) {
    clientInstance.close()
    clientInstance = null
    dbInstance = null
    initPromise = null
    dbLogger.log('Drizzle connection closed')
  }
}
