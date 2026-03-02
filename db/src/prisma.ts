// Prisma client factory for the website Cloudflare Worker.
// Uses @prisma/adapter-pg with the pg library since the Worker has nodejs_compat.
//
// CF Workers cannot reuse TCP connections across requests — a singleton
// pg.Pool / PrismaClient causes ~40% of requests to hang with error 1101
// ("Worker code had hung"). Instead we export a factory that creates a
// fresh PrismaClient + pg.Pool per request.
//
// The connectionString param should come from env.HYPERDRIVE.connectionString
// (Cloudflare Hyperdrive binding) for pooled low-latency connections.
// Falls back to DATABASE_URL env var if no string is provided.

import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client.js'

export function createPrisma(connectionString?: string): PrismaClient {
  const url = connectionString || process.env['DATABASE_URL']
  const pool = new pg.Pool({ connectionString: url })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}
