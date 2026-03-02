// Prisma client singleton for the website Cloudflare Worker.
// Uses @prisma/adapter-pg with the pg library since the Worker has nodejs_compat.
// DATABASE_URL must be set as a secret in the Worker environment.

import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client.js'

const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] })
const adapter = new PrismaPg(pool)

export const prisma = new PrismaClient({ adapter })
