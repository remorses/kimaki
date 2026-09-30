// Tests that cli2 opens V1 databases without changing them, and creates only
// the V1 table subset on a fresh install (spec section 17).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, test } from 'vitest'

import { dbPath, openDb, REQUIRED_TABLES, verbosityFromV1, verbosityToV1 } from './db.ts'

const tempDirs: string[] = []

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-cli2-db-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

async function tableNames(client: Client): Promise<string[]> {
  const rows = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  return rows.rows.map((row) => String(row.name))
}

async function dumpTable(client: Client, table: string): Promise<string> {
  const rows = await client.execute(`SELECT * FROM "${table}" ORDER BY rowid`)
  return JSON.stringify(rows.rows)
}

// One synthetic row per V1-only table, values chosen from the column type.
async function insertGenericRow(client: Client, table: string): Promise<void> {
  const info = await client.execute(`PRAGMA table_info("${table}")`)
  const columns = info.rows.map((row) => ({ name: String(row.name), type: String(row.type).toUpperCase() }))
  const values = columns.map((column) => {
    if (column.type.includes('INT')) return 1
    if (column.type.includes('DATETIME')) return '2026-01-01 10:00:00'
    return `v1-${table}-${column.name}`
  })
  await client.execute({
    sql: `INSERT INTO "${table}" (${columns.map((c) => `"${c.name}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    args: values,
  })
}

test('fresh database gets exactly the V1 table subset', async () => {
  const dataDir = tempDataDir()
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  expect(await tableNames(opened.client)).toMatchInlineSnapshot(`
    [
      "bot_api_keys",
      "bot_tokens",
      "channel_agents",
      "channel_directories",
      "channel_mention_mode",
      "channel_models",
      "channel_verbosity",
      "channel_worktrees",
      "guild_categories",
      "scheduled_tasks",
      "session_sleeps",
      "thread_sessions",
    ]
  `)
  opened.close()

  // Subcommands never migrate: an empty file is reported, not created.
  const emptyDir = tempDataDir()
  const notMigrated = await openDb({ dataDir: emptyDir, migrate: false })
  expect(notMigrated instanceof Error && notMigrated.message).toMatchInlineSnapshot(
    `"Database table bot_api_keys is missing. Run kimaki once to set up the database"`,
  )
})

test('real V1 database opens, V2 reads its rows, V1-only tables stay identical', async () => {
  const dataDir = tempDataDir()
  const legacy = createClient({ url: `file:${dbPath({ dataDir })}` })
  const schemaSql = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/v1-schema.sql'), 'utf8')
  await legacy.executeMultiple(schemaSql)
  // Synthetic rows do not satisfy V1 foreign keys; only row contents matter here.
  await legacy.execute('PRAGMA foreign_keys = OFF')

  const allTables = await tableNames(legacy)
  const v1OnlyTables = allTables.filter((table) => !REQUIRED_TABLES.includes(table))
  for (const table of v1OnlyTables) {
    await insertGenericRow(legacy, table)
  }
  await legacy.executeMultiple(`
    INSERT INTO bot_tokens (app_id, token) VALUES ('app-1', 'token-1');
    INSERT INTO channel_directories (channel_id, directory, channel_type, guild_id)
      VALUES ('chan-1', '/projects/website', 'text', 'guild-1');
    INSERT INTO channel_verbosity (channel_id, verbosity) VALUES ('chan-1', 'text_only');
    INSERT INTO thread_sessions (thread_id, session_id) VALUES ('thread-1', 'ses_old_v1');
    INSERT INTO scheduled_tasks (schedule_kind, next_run_at, payload_json, prompt_preview, channel_id)
      VALUES ('cron', '2026-02-01 09:00:00', '{"prompt":"weekly"}', 'weekly', 'chan-1');
    INSERT INTO session_sleeps (session_id, wake_at, delivery_id) VALUES ('ses_old_v1', '2026-02-02T09:00:00.000Z', 'wake-1');
  `)
  const before = new Map<string, string>()
  for (const table of v1OnlyTables) {
    before.set(table, await dumpTable(legacy, table))
  }
  legacy.close()

  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  const { db } = opened
  const channel = await db.query.channel_directories.findFirst({ with: { channel_verbosity: true } })
  const binding = await db.query.thread_sessions.findFirst({ where: { thread_id: 'thread-1' } })
  const task = await db.query.scheduled_tasks.findFirst()
  const sleep = await db.query.session_sleeps.findFirst()
  expect({
    channel: { directory: channel?.directory, verbosity: verbosityFromV1(channel?.channel_verbosity?.verbosity) },
    binding: { sessionId: binding?.session_id, source: binding?.source },
    task: { kind: task?.schedule_kind, nextRunAt: task?.next_run_at?.toISOString(), channel: task?.channel_id },
    sleep: { wakeAt: sleep?.wake_at.toISOString(), deliveryId: sleep?.delivery_id, status: sleep?.status },
  }).toMatchInlineSnapshot(`
    {
      "binding": {
        "sessionId": "ses_old_v1",
        "source": "kimaki",
      },
      "channel": {
        "directory": "/projects/website",
        "verbosity": "text",
      },
      "sleep": {
        "deliveryId": "wake-1",
        "status": "planned",
        "wakeAt": "2026-02-02T09:00:00.000Z",
      },
      "task": {
        "channel": "chan-1",
        "kind": "cron",
        "nextRunAt": "2026-02-01T09:00:00.000Z",
      },
    }
  `)

  for (const table of v1OnlyTables) {
    expect({ table, rows: await dumpTable(opened.client, table) }).toEqual({ table, rows: before.get(table) })
  }
  expect(v1OnlyTables.length).toBeGreaterThanOrEqual(12)
  opened.close()
})

test('verbosity maps between the V1 enum on disk and the two V2 levels', () => {
  expect({
    read: {
      text_only: verbosityFromV1('text_only'),
      text_and_essential_tools: verbosityFromV1('text_and_essential_tools'),
      tools_and_text: verbosityFromV1('tools_and_text'),
      missing: verbosityFromV1(undefined),
    },
    write: { text: verbosityToV1('text'), tools: verbosityToV1('tools') },
  }).toMatchInlineSnapshot(`
    {
      "read": {
        "missing": "tools",
        "text_and_essential_tools": "tools",
        "text_only": "text",
        "tools_and_text": "tools",
      },
      "write": {
        "text": "text_only",
        "tools": "text_and_essential_tools",
      },
    }
  `)
})
