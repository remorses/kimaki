// Cloudflare-targeted Prisma client factory for db package consumers.
// Uses the workerd runtime-generated Prisma client with @prisma/adapter-pg.

import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/cloudflare/client.js'

export function createPrisma(connectionString?: string): PrismaClient {
  const url = connectionString || process.env['DATABASE_URL']
  const pool = new pg.Pool({ connectionString: url })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}

export { PrismaClient }
export type { Prisma } from './generated/cloudflare/client.js'
