// SQLite setup and the one-time V1 import (migrations.ts). Every test uses its
// own temp data dir with fake databases; the V1 schema comes from
// fixtures/v1-schema.sql and the rows copy the value formats of a real V1
// install (mixed datetime formats, NULL guild_id, 'self-hosted' bot_mode).

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, expect, test } from 'vitest'

import { openDb, verbosityFromV1, verbosityToV1 } from './db.ts'
import { LEGACY_DB_FILE } from './migrations.ts'

const tempDirs: string[] = []

function tempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-db-'))
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

function fileHash(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const V1_ROWS = `
  INSERT INTO bot_tokens (app_id, token, created_at, bot_mode, last_used_at)
    VALUES ('1422625037164350001', 'fake-self-hosted-token', '2025-09-30 15:18:00', 'self-hosted', NULL);
  INSERT INTO bot_tokens (app_id, token, created_at, bot_mode, client_id, client_secret, proxy_url, last_used_at)
    VALUES ('1477605701202481173', 'client-1:secret-1', '2026-03-06T22:55:21.334+00:00', 'gateway', 'client-1', 'secret-1', 'https://discord-gateway.kimaki.dev', '2026-10-01T06:45:31.252Z');
  INSERT INTO bot_api_keys (app_id, gemini_api_key) VALUES ('1422625037164350001', 'fake-gemini-key');
  INSERT INTO guild_categories (guild_id, category_id, created_at) VALUES ('1422625037164351000', '1479220924090670000', '2026-09-17 09:41:32');
  INSERT INTO channel_directories (channel_id, directory, channel_type, created_at)
    VALUES ('1422625308523100001', '/Users/fake/projects/website', 'text', '2025-09-30 16:45:03');
  INSERT INTO channel_directories (channel_id, directory, channel_type, guild_id, created_at)
    VALUES ('1422625308523100002', '/Users/fake/.kimaki/projects/kimaki', 'text', '1422625037164351000', '2026-09-17 09:41:33');
  INSERT INTO channel_verbosity (channel_id, verbosity) VALUES ('1422625308523100001', 'text_only');
  INSERT INTO channel_models (channel_id, model_id, variant, updated_at) VALUES ('1422625308523100001', 'anthropic/claude-opus-4-6', 'high', '2026-09-23 06:59:00');
  INSERT INTO thread_sessions (thread_id, session_id, created_at, source, updated_at)
    VALUES ('1555112336879250001', 'ses_f09bb9229ffeAAAAAAAAAAAAAA', '2026-10-01 07:15:53', 'kimaki', '2026-10-01T07:21:00.492Z');
  INSERT INTO thread_sessions (thread_id, session_id, created_at, source, updated_at)
    VALUES ('1555112336879250002', 'ses_f09bb9229ffeBBBBBBBBBBBBBB', '2026-10-01 07:09:50', 'kimaki', NULL);
  INSERT INTO scheduled_tasks (status, schedule_kind, cron_expr, next_run_at, payload_json, prompt_preview, channel_id)
    VALUES ('planned', 'cron', '0 9 * * 1', '2026-10-05T09:00:00.000Z', '{"prompt":"weekly tests"}', 'weekly tests', '1422625308523100001');
  INSERT INTO session_sleeps (session_id, wake_at, status, delivery_id, created_at)
    VALUES ('ses_f09bb9229ffeAAAAAAAAAAAAAA', '2026-10-02T09:00:00.000Z', 'planned', 'wake-1', '2026-10-01 07:20:00');
  INSERT INTO session_sleeps (session_id, wake_at, status, delivery_id, created_at)
    VALUES ('ses_f09bb9229ffeCCCCCCCCCCCCCC', '2026-08-26T14:59:20.917Z', 'failed', 'wake-0', '2026-08-26 14:39:20');
  INSERT INTO part_messages (part_id, message_id, thread_id) VALUES ('prt_1', '1555112336879259999', '1555112336879250001');
`

async function writeLegacyDb({ dataDir, sql }: { dataDir: string; sql: string }): Promise<string> {
  const file = path.join(dataDir, LEGACY_DB_FILE)
  const legacy = createClient({ url: `file:${file}` })
  await legacy.executeMultiple(sql)
  legacy.close()
  return file
}

test('fresh install gets kimaki.db with the kimaki tables; subcommands never create it', async () => {
  const dataDir = tempDataDir()

  // Subcommands never migrate: a missing file is reported, not created.
  const notMigrated = await openDb({ dataDir, migrate: false })
  expect(notMigrated instanceof Error && notMigrated.message).toMatchInlineSnapshot(`"Kimaki database is not set up (kimaki.db is missing). Run kimaki once to set up the database"`)
  expect(fs.readdirSync(dataDir)).toEqual([])

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
  expect(fs.existsSync(path.join(dataDir, LEGACY_DB_FILE))).toBe(false)
})

test('first start imports the V1 database once and leaves it unchanged', async () => {
  const dataDir = tempDataDir()
  fs.chmodSync(dataDir, 0o755)
  const schemaSql = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/v1-schema.sql'), 'utf8')
  // Like a real install: WAL mode, rows still in the -wal file, V1 connection open.
  const legacyFile = path.join(dataDir, LEGACY_DB_FILE)
  const v1 = createClient({ url: `file:${legacyFile}` })
  await v1.execute('PRAGMA journal_mode = WAL')
  await v1.execute('PRAGMA wal_autocheckpoint = 0')
  await v1.executeMultiple(`${schemaSql}\n${V1_ROWS}`)
  const before = { db: fileHash(legacyFile), wal: fileHash(`${legacyFile}-wal`) }

  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700)
  // The import opened the V1 file read-only: neither file changed.
  expect({ db: fileHash(legacyFile), wal: fileHash(`${legacyFile}-wal`) }).toEqual(before)
  v1.close()
  const { db } = opened
  const bots = await db.query.bot_tokens.findMany({ orderBy: { app_id: 'asc' }, with: { api_keys: true } })
  const channels = await db.query.channel_directories.findMany({
    orderBy: { channel_id: 'asc' },
    with: { channel_verbosity: true, channel_model: true },
  })
  const threads = await db.query.thread_sessions.findMany({ orderBy: { thread_id: 'asc' } })
  const tasks = await db.query.scheduled_tasks.findMany()
  const sleeps = await db.query.session_sleeps.findMany({ orderBy: { session_id: 'asc' } })
  const categories = await db.query.guild_categories.findMany()
  expect({
    bots: bots.map((row) => ({ app: row.app_id, mode: row.bot_mode, lastUsed: row.last_used_at?.toISOString() ?? null, gemini: row.api_keys?.gemini_api_key ?? null })),
    categories: categories.map((row) => ({ guild: row.guild_id, category: row.category_id, created: row.created_at?.toISOString() })),
    channels: channels.map((row) => ({
      directory: row.directory,
      guild: row.guild_id,
      created: row.created_at?.toISOString(),
      verbosity: verbosityFromV1(row.channel_verbosity?.verbosity),
      model: row.channel_model ? `${row.channel_model.model_id} ${row.channel_model.variant}` : null,
    })),
    threads: threads.map((row) => ({ thread: row.thread_id, session: row.session_id, created: row.created_at?.toISOString(), updated: row.updated_at?.toISOString() ?? null })),
    tasks: tasks.map((row) => ({ status: row.status, cron: row.cron_expr, next: row.next_run_at.toISOString(), channel: row.channel_id })),
    sleeps: sleeps.map((row) => ({ session: row.session_id, status: row.status, wake: row.wake_at.toISOString(), delivery: row.delivery_id })),
  }).toMatchInlineSnapshot(`
    {
      "bots": [
        {
          "app": "1422625037164350001",
          "gemini": "fake-gemini-key",
          "lastUsed": null,
          "mode": "self_hosted",
        },
        {
          "app": "1477605701202481173",
          "gemini": null,
          "lastUsed": "2026-10-01T06:45:31.252Z",
          "mode": "gateway",
        },
      ],
      "categories": [
        {
          "category": "1479220924090670000",
          "created": "2026-09-17T09:41:32.000Z",
          "guild": "1422625037164351000",
        },
      ],
      "channels": [
        {
          "created": "2025-09-30T16:45:03.000Z",
          "directory": "/Users/fake/projects/website",
          "guild": null,
          "model": "anthropic/claude-opus-4-6 high",
          "verbosity": "text",
        },
        {
          "created": "2026-09-17T09:41:33.000Z",
          "directory": "/Users/fake/.kimaki/projects/kimaki",
          "guild": "1422625037164351000",
          "model": null,
          "verbosity": "tools",
        },
      ],
      "sleeps": [
        {
          "delivery": "wake-1",
          "session": "ses_f09bb9229ffeAAAAAAAAAAAAAA",
          "status": "planned",
          "wake": "2026-10-02T09:00:00.000Z",
        },
        {
          "delivery": "wake-0",
          "session": "ses_f09bb9229ffeCCCCCCCCCCCCCC",
          "status": "failed",
          "wake": "2026-08-26T14:59:20.917Z",
        },
      ],
      "tasks": [
        {
          "channel": "1422625308523100001",
          "cron": "0 9 * * 1",
          "next": "2026-10-05T09:00:00.000Z",
          "status": "planned",
        },
      ],
      "threads": [
        {
          "created": "2026-10-01T07:15:53.000Z",
          "session": "ses_f09bb9229ffeAAAAAAAAAAAAAA",
          "thread": "1555112336879250001",
          "updated": "2026-10-01T07:21:00.492Z",
        },
        {
          "created": "2026-10-01T07:09:50.000Z",
          "session": "ses_f09bb9229ffeBBBBBBBBBBBBBB",
          "thread": "1555112336879250002",
          "updated": null,
        },
      ],
    }
  `)
  // V1-only tables are not copied.
  expect(await tableNames(opened.client)).not.toContain('part_messages')
  opened.close()

  expect(fs.readdirSync(dataDir).filter((name) => name.startsWith('kimaki')).sort()).toMatchInlineSnapshot(`
    [
      "kimaki.db",
      "kimaki.db-shm",
      "kimaki.db-wal",
    ]
  `)

  // Later starts never import again, even if V1 keeps writing its own file.
  const later = createClient({ url: `file:${legacyFile}` })
  await later.execute(`INSERT INTO thread_sessions (thread_id, session_id) VALUES ('1555112336879250003', 'ses_new_in_v1')`)
  later.close()
  const reopened = await openDb({ dataDir, migrate: true })
  if (reopened instanceof Error) throw reopened
  expect(await reopened.db.query.thread_sessions.findFirst({ where: { thread_id: '1555112336879250003' } })).toBe(undefined)
  reopened.close()
})

test('a V1 database from an older version imports with defaults for missing columns', async () => {
  const dataDir = tempDataDir()
  // Early V1 shape: no source/updated_at on thread_sessions, no bot_mode columns.
  await writeLegacyDb({
    dataDir,
    sql: `
      CREATE TABLE thread_sessions (thread_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE bot_tokens (app_id TEXT PRIMARY KEY, token TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO thread_sessions (thread_id, session_id, created_at) VALUES ('1422625308523200001', 'ses_old', '2025-09-30 16:45:03');
      INSERT INTO bot_tokens (app_id, token, created_at) VALUES ('1422625037164350001', 'fake-token', '2025-09-30 15:18:00');
    `,
  })
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  const thread = await opened.db.query.thread_sessions.findFirst()
  const bot = await opened.db.query.bot_tokens.findFirst()
  expect({ source: thread?.source, mode: bot?.bot_mode, token: bot?.token }).toMatchInlineSnapshot(`
    {
      "mode": "self_hosted",
      "source": "kimaki",
      "token": "fake-token",
    }
  `)
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
