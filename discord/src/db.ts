import fs from 'node:fs'
import path from 'node:path'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient, Prisma } from './generated/client.js'

export type { Prisma }

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

async function migrateSchema(prisma: PrismaClient) {
    const schemaPath = path.join(__dirname, 'schema.sql')
    const sql = fs.readFileSync(schemaPath, 'utf-8')
    const statements = sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
    for (const statement of statements) {
        await prisma.$executeRawUnsafe(statement)
    }
}
