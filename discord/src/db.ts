import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient, Prisma } from './generated/client.js'
import { getDataDir } from './config.js'
import { createLogger, LogPrefix } from './logger.js'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export type { Prisma }
export { PrismaClient }

const dbLogger = createLogger(LogPrefix.DB)

let prismaInstance: PrismaClient | null = null
let initPromise: Promise<PrismaClient> | null = null

/**
 * Get the singleton Prisma client instance.
 * Initializes the database on first call, running migrations if needed.
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
 * Get the Prisma client synchronously. Throws if not initialized.
 * Use this only after getPrisma() has been awaited at least once.
 */
export function getPrismaSync(): PrismaClient {
  if (!prismaInstance) {
    throw new Error(
      'Prisma not initialized. Call getPrisma() first and await it.',
    )
  }
  return prismaInstance
}

async function initializePrisma(): Promise<PrismaClient> {
  const dataDir = getDataDir()

  try {
    fs.mkdirSync(dataDir, { recursive: true })
  } catch (e) {
    dbLogger.error(
      `Failed to create data directory ${dataDir}:`,
      (e as Error).message,
    )
  }

  const dbPath = path.join(dataDir, 'discord-sessions.db')
  const exists = fs.existsSync(dbPath)

  dbLogger.log(`Opening database at: ${dbPath}`)

  const adapter = new PrismaLibSql({ url: `file:${dbPath}` })
  const prisma = new PrismaClient({ adapter })

  if (!exists) {
    dbLogger.log('New database, running migrations...')
  } else {
    dbLogger.log('Existing database, ensuring migrations are up to date...')
  }
  await applyPrismaMigrations(prisma)
  dbLogger.log('Migration check complete')

  prismaInstance = prisma
  return prisma
}

async function executeSqlStatements({
  prisma,
  sql,
  source,
}: {
  prisma: PrismaClient
  sql: string
  source: string
}): Promise<void> {
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
  if (statements.length === 0) {
    dbLogger.log(`No SQL statements found in ${source}`)
    return
  }
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement)
  }
}

async function applyPrismaMigrations(prisma: PrismaClient): Promise<void> {
  const migrationsDir = path.join(__dirname, '../migrations')
  if (!fs.existsSync(migrationsDir)) {
    dbLogger.log('No Prisma migrations directory found; skipping migration apply')
    return
  }

  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS kimaki_migrations (
      name TEXT NOT NULL PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  )

  const appliedRows = await prisma.$queryRaw<Array<{ name: string }>>
    `SELECT name FROM kimaki_migrations`
  const appliedNames = new Set(appliedRows.map((row) => row.name))

  const migrationDirs = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  if (migrationDirs.length === 0) {
    return
  }

  const hasThreadSessionsTable = await prisma.$queryRaw<Array<{ name: string }>>
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_sessions'`
  const hasBaselineTables = hasThreadSessionsTable.length > 0

  for (const migrationName of migrationDirs) {
    if (appliedNames.has(migrationName)) {
      continue
    }

    const migrationPath = path.join(migrationsDir, migrationName, 'migration.sql')
    if (!fs.existsSync(migrationPath)) {
      continue
    }

    const migrationSql = fs.readFileSync(migrationPath, 'utf-8')
    if (!migrationSql.trim()) {
      const checksum = crypto.createHash('sha256').update(migrationSql).digest('hex')
      await prisma.$executeRaw`
        INSERT INTO kimaki_migrations (name, checksum)
        VALUES (${migrationName}, ${checksum})
      `
      continue
    }

    const isBaselineMigration =
      hasBaselineTables &&
      migrationName === migrationDirs[0] &&
      migrationSql.includes('CREATE TABLE "thread_sessions"')

    if (isBaselineMigration) {
      const checksum = crypto.createHash('sha256').update(migrationSql).digest('hex')
      await prisma.$executeRaw`
        INSERT INTO kimaki_migrations (name, checksum)
        VALUES (${migrationName}, ${checksum})
      `
      continue
    }

    dbLogger.log(`Applying Prisma migration: ${migrationName}`)
    await executeSqlStatements({
      prisma,
      sql: migrationSql,
      source: `prisma/migrations/${migrationName}/migration.sql`,
    })

    const checksum = crypto.createHash('sha256').update(migrationSql).digest('hex')
    await prisma.$executeRaw`
      INSERT INTO kimaki_migrations (name, checksum)
      VALUES (${migrationName}, ${checksum})
    `
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

/**
 * Create a Prisma client for a specific database path.
 * Used for custom database locations.
 */
export async function createPrisma({
  sqlitePath,
}: {
  sqlitePath: string
}): Promise<PrismaClient> {
  const adapter = new PrismaLibSql({ url: `file:${sqlitePath}` })
  const prisma = new PrismaClient({ adapter })
  await applyPrismaMigrations(prisma)
  return prisma
}
