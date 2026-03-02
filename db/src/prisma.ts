// Prisma client factory for the website Cloudflare Worker.
// Uses @prisma/adapter-pg with the pg library since the Worker has nodejs_compat.
// DATABASE_URL must be set as a secret in the Worker environment.
//
// CF Workers cannot reuse TCP connections across requests — a singleton
// pg.Pool / PrismaClient causes ~40% of requests to hang with error 1101
// ("Worker code had hung"). Instead we export a factory that creates a
// fresh PrismaClient + pg.Pool per request.

import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client.js'

export function createPrisma(): PrismaClient {
  const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}
