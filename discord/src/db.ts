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
    dbLogger.log('New database, running schema migration...')
  } else {
    dbLogger.log('Existing database, ensuring schema is up to date...')
  }
  await migrateSchema(prisma)
  dbLogger.log('Schema migration complete')

  prismaInstance = prisma
  return prisma
}

async function migrateSchema(prisma: PrismaClient) {
  const schemaPath = path.join(__dirname, '../src/schema.sql')
  const sql = fs.readFileSync(schemaPath, 'utf-8')
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement)
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
  const exists = fs.existsSync(sqlitePath)
  const adapter = new PrismaLibSql({ url: `file:${sqlitePath}` })
  const prisma = new PrismaClient({ adapter })
  if (!exists) {
    await migrateSchema(prisma)
  }
  return prisma
}
