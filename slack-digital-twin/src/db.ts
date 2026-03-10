// Prisma client initialization with in-memory libsql.
// Uses cache=shared so libsql's transaction() doesn't create a separate
// empty in-memory DB (see discord-digital-twin/src/db.ts for details).

import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/client.js'

export { PrismaClient }

export function createPrismaClient(dbUrl?: string): PrismaClient {
  const url = dbUrl ?? 'file::memory:?cache=shared'
  const adapter = new PrismaLibSql({ url })
  return new PrismaClient({ adapter })
}
