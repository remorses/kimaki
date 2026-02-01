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

  // Always run migrations - schema.sql uses IF NOT EXISTS so it's idempotent
  dbLogger.log(exists ? 'Existing database, running migrations...' : 'New database, running schema setup...')
  await migrateSchema(prisma)
  dbLogger.log('Schema migration complete')

  prismaInstance = prisma
  return prisma
}

async function migrateSchema(prisma: PrismaClient): Promise<void> {
  const schemaPath = path.join(__dirname, '../src/schema.sql')
  const sql = fs.readFileSync(schemaPath, 'utf-8')
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
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


