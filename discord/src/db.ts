// Prisma client initialization with libsql adapter.
// Uses KIMAKI_DB_URL env var when set (plugin process → Hrana HTTP),
// otherwise falls back to direct file: access (bot process, CLI subcommands).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient, Prisma } from './generated/client.js'
import { getDataDir } from './config.js'
import { createLogger, formatErrorWithStack, LogPrefix } from './logger.js'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export type { Prisma }
export { PrismaClient }

// Under vitest, clear any inherited KIMAKI_DB_URL from the parent bot process
// so tests default to file-based access using the auto-isolated temp data dir.
// Tests that need Hrana (like the e2e test) can set KIMAKI_DB_URL explicitly
// after import — getDbUrl() reads process.env dynamically on each call.
if (process.env.KIMAKI_VITEST) {
  delete process.env['KIMAKI_DB_URL']
}

const dbLogger = createLogger(LogPrefix.DB)

let prismaInstance: PrismaClient | null = null
let initPromise: Promise<PrismaClient> | null = null

/**
 * Get the singleton Prisma client instance.
 * Initializes the database on first call, running schema setup if needed.
 */
export function getPrisma(): Promise<PrismaClient> {
  if (prismaInstance) {
    return Promise.resolve(prismaInstance)
  }
  if (initPromise) {
    return initPromise
  }
  initPromise = initializePrisma()
  return initPromise
}

/**
 * Build the libsql connection URL.
 * KIMAKI_DB_URL is set by the bot when spawning opencode plugin processes,
 * pointing them at the in-process Hrana HTTP server. Future-proof for remote
 * opencode processes on different machines.
 * Without the env var (bot process, CLI subcommands), uses direct file: access.
 */
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

async function initializePrisma(): Promise<PrismaClient> {
  const dbUrl = getDbUrl()
  const isFileMode = dbUrl.startsWith('file:')

  if (isFileMode) {
    const dataDir = getDataDir()
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch (e) {
      dbLogger.error(
        `Failed to create data directory ${dataDir}:`,
        (e as Error).message,
      )
    }
  }

  dbLogger.log(`Opening database via: ${dbUrl}`)

  const dbAuthToken = getDbAuthToken()
  const adapter = new PrismaLibSql({
    url: dbUrl,
    ...(dbAuthToken && { authToken: dbAuthToken }),
  })
  const prisma = new PrismaClient({ adapter })

  try {
    if (isFileMode) {
      // WAL mode allows concurrent reads while writing instead of blocking.
      // busy_timeout makes SQLite retry for 5s instead of immediately failing with SQLITE_BUSY.
      // The Hrana server (serving the plugin process) sets the same pragmas on its own connection.
      // PRAGMAs are skipped for HTTP connections — they're connection-scoped and the Hrana
      // server already configures them on its own libsql Database handle.
      await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL')
      await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000')
    }

    // Always run migrations - schema.sql uses IF NOT EXISTS so it's idempotent
    dbLogger.log('Running schema migrations...')
    await migrateSchema(prisma)
    dbLogger.log('Schema migration complete')
  } catch (error) {
    dbLogger.error('Prisma init failed:', formatErrorWithStack(error))
    throw error
  }

  prismaInstance = prisma
  return prisma
}

async function migrateSchema(prisma: PrismaClient): Promise<void> {
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
    // Make CREATE INDEX idempotent
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

  // Migration: add variant column to model tables (for thinking/reasoning level).
  // ALTERs throw if column already exists, so each is wrapped in try/catch.
  const alterStatements = [
    'ALTER TABLE channel_models ADD COLUMN variant TEXT',
    'ALTER TABLE session_models ADD COLUMN variant TEXT',
    'ALTER TABLE global_models ADD COLUMN variant TEXT',
  ]
  for (const stmt of alterStatements) {
    try {
      await prisma.$executeRawUnsafe(stmt)
    } catch {
      // Column already exists – expected on subsequent runs
    }
  }

  // Migration: add openai_api_key column to bot_api_keys.
  try {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE bot_api_keys ADD COLUMN openai_api_key TEXT',
    )
  } catch {
    // Column already exists
  }

  // Migration: add gateway bot mode columns to bot_tokens.
  // bot_mode distinguishes "self_hosted" (user's own bot) from "gateway" (gateway Kimaki bot).
  // client_id + client_secret are the credentials used for gateway proxy auth.
  // proxy_url stores the gateway-proxy REST base URL.
  const botTokenAlters = [
    "ALTER TABLE bot_tokens ADD COLUMN bot_mode TEXT DEFAULT 'self_hosted'",
    'ALTER TABLE bot_tokens ADD COLUMN client_id TEXT',
    'ALTER TABLE bot_tokens ADD COLUMN client_secret TEXT',
    'ALTER TABLE bot_tokens ADD COLUMN proxy_url TEXT',
    'ALTER TABLE bot_tokens ADD COLUMN last_used_at DATETIME',
  ]
  for (const stmt of botTokenAlters) {
    try {
      await prisma.$executeRawUnsafe(stmt)
    } catch {
      // Column already exists
    }
  }

  // Migration: move session_thinking data into session_models.variant.
  // session_thinking table is left in place (not dropped) so older kimaki versions
  // that still reference it won't crash on the same database.
  try {
    // For sessions that already have a model row, copy the thinking value
    await prisma.$executeRawUnsafe(`
      UPDATE session_models SET variant = (
        SELECT thinking_value FROM session_thinking
        WHERE session_thinking.session_id = session_models.session_id
      ) WHERE variant IS NULL AND EXISTS (
        SELECT 1 FROM session_thinking WHERE session_thinking.session_id = session_models.session_id
      )
    `)
  } catch {
    // session_thinking table may not exist in fresh installs
  }

  // Migration: rename hyphenated verbosity values to underscored for Prisma enum.
  // Old DBs have 'tools-and-text', 'text-and-essential-tools', 'text-only'.
  const verbosityRenames = [
    "UPDATE channel_verbosity SET verbosity = 'tools_and_text' WHERE verbosity = 'tools-and-text'",
    "UPDATE channel_verbosity SET verbosity = 'text_and_essential_tools' WHERE verbosity = 'text-and-essential-tools'",
    "UPDATE channel_verbosity SET verbosity = 'text_only' WHERE verbosity = 'text-only'",
  ]
  for (const stmt of verbosityRenames) {
    try {
      await prisma.$executeRawUnsafe(stmt)
    } catch {
      // Table may not exist on first run
    }
  }

  // Defensive migration: rename legacy 'self-hosted' bot_mode to 'self_hosted'.
  // Also fix NULL worktree status rows that predate the required enum.
  const defensiveMigrations = [
    "UPDATE bot_tokens SET bot_mode = 'self_hosted' WHERE bot_mode = 'self-hosted'",
    "UPDATE thread_worktrees SET status = 'pending' WHERE status IS NULL",
  ]
  for (const stmt of defensiveMigrations) {
    try {
      await prisma.$executeRawUnsafe(stmt)
    } catch {
      // Table may not exist on first run
    }
  }

  // Migration: ensure every bot row has service auth credentials.
  // These credentials are used for local/internet control-plane auth.
  try {
    const botRows = await prisma.bot_tokens.findMany({
      select: {
        app_id: true,
        client_id: true,
        client_secret: true,
      },
    })
    for (const botRow of botRows) {
      if (botRow.client_id && botRow.client_secret) {
        continue
      }
      await prisma.bot_tokens.update({
        where: { app_id: botRow.app_id },
        data: {
          client_id: crypto.randomUUID(),
          client_secret: crypto.randomBytes(32).toString('hex'),
        },
      })
    }
  } catch {
    // Defensive migration only; ignore if table shape is not ready yet.
  }

}

/**
 * Close the Prisma connection.
 */
export async function closePrisma(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect()
    prismaInstance = null
    initPromise = null
    dbLogger.log('Prisma connection closed')
  }
}
