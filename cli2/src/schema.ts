// Drizzle schema for Kimaki's local SQLite file (~/.kimaki/kimaki.db).
// The tables are the V1 tables cli2 still uses, with identical columns, so
// migrations.ts can import a V1 discord-sessions.db with INSERT ... SELECT.
// Every schema change needs a step in migrations.ts.

import { defineRelations } from 'drizzle-orm'
import * as orm from 'drizzle-orm'
import * as s from 'drizzle-orm/sqlite-core'
import crypto from 'node:crypto'

// Same custom type as V1: ISO strings on write, SQLite CURRENT_TIMESTAMP on read.
const datetime = s.customType<{
  data: Date
  driverData: string
}>({
  dataType() {
    return 'datetime'
  },
  toDriver(value) {
    return value.toISOString()
  },
  fromDriver(value) {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) {
      return new Date(`${value.replace(' ', 'T')}Z`)
    }
    return new Date(value)
  },
})

export const thread_sessions = s.sqliteTable('thread_sessions', {
  thread_id: s.text('thread_id').primaryKey().notNull(),
  session_id: s.text('session_id').notNull(),
  source: s.text('source', { enum: ['kimaki', 'external_poll'] }).notNull().default('kimaki'),
  last_synced_name: s.text('last_synced_name'),
  parent_session_id: s.text('parent_session_id'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const bot_tokens = s.sqliteTable('bot_tokens', {
  app_id: s.text('app_id').primaryKey().notNull(),
  token: s.text('token').notNull(),
  bot_mode: s.text('bot_mode', { enum: ['self_hosted', 'gateway'] }).notNull().default('self_hosted'),
  client_id: s.text('client_id'),
  client_secret: s.text('client_secret'),
  proxy_url: s.text('proxy_url'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  last_used_at: datetime('last_used_at'),
})

export const channel_directories = s.sqliteTable('channel_directories', {
  channel_id: s.text('channel_id').primaryKey().notNull(),
  directory: s.text('directory').notNull(),
  channel_type: s.text('channel_type', { enum: ['text', 'voice'] }).notNull(),
  guild_id: s.text('guild_id'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
})

export const guild_categories = s.sqliteTable('guild_categories', {
  guild_id: s.text('guild_id').primaryKey().notNull(),
  category_id: s.text('category_id'),
  audio_category_id: s.text('audio_category_id'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
})

export const bot_api_keys = s.sqliteTable('bot_api_keys', {
  app_id: s.text('app_id').primaryKey().notNull().references(() => bot_tokens.app_id, { onUpdate: 'cascade' }),
  gemini_api_key: s.text('gemini_api_key'),
  openai_api_key: s.text('openai_api_key'),
  xai_api_key: s.text('xai_api_key'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
})

export const channel_models = s.sqliteTable('channel_models', {
  channel_id: s.text('channel_id').primaryKey().notNull().references(() => channel_directories.channel_id, { onUpdate: 'cascade' }),
  model_id: s.text('model_id').notNull(),
  variant: s.text('variant'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const channel_agents = s.sqliteTable('channel_agents', {
  channel_id: s.text('channel_id').primaryKey().notNull().references(() => channel_directories.channel_id, { onUpdate: 'cascade' }),
  agent_name: s.text('agent_name').notNull(),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const channel_worktrees = s.sqliteTable('channel_worktrees', {
  channel_id: s.text('channel_id').primaryKey().notNull().references(() => channel_directories.channel_id, { onUpdate: 'cascade' }),
  enabled: s.integer('enabled', { mode: 'number' }).notNull().default(0),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const channel_verbosity = s.sqliteTable('channel_verbosity', {
  channel_id: s.text('channel_id').primaryKey().notNull().references(() => channel_directories.channel_id, { onUpdate: 'cascade' }),
  verbosity: s.text('verbosity', { enum: ['tools_and_text', 'text_and_essential_tools', 'text_only'] }).notNull().default('tools_and_text'),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const channel_mention_mode = s.sqliteTable('channel_mention_mode', {
  channel_id: s.text('channel_id').primaryKey().notNull().references(() => channel_directories.channel_id, { onUpdate: 'cascade' }),
  enabled: s.integer('enabled', { mode: 'number' }).notNull().default(0),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const scheduled_tasks = s.sqliteTable('scheduled_tasks', {
  id: s.integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }).notNull(),
  status: s.text('status', { enum: ['planned', 'running', 'completed', 'cancelled', 'failed'] }).notNull().default('planned'),
  schedule_kind: s.text('schedule_kind', { enum: ['at', 'cron'] }).notNull(),
  run_at: datetime('run_at'),
  cron_expr: s.text('cron_expr'),
  timezone: s.text('timezone'),
  next_run_at: datetime('next_run_at').notNull(),
  running_started_at: datetime('running_started_at'),
  last_run_at: datetime('last_run_at'),
  last_error: s.text('last_error'),
  attempts: s.integer('attempts', { mode: 'number' }).notNull().default(0),
  payload_json: s.text('payload_json').notNull(),
  prompt_preview: s.text('prompt_preview').notNull(),
  channel_id: s.text('channel_id').references(() => channel_directories.channel_id, { onDelete: 'set null', onUpdate: 'cascade' }),
  thread_id: s.text('thread_id').references(() => thread_sessions.thread_id, { onDelete: 'set null', onUpdate: 'cascade' }),
  session_id: s.text('session_id'),
  project_directory: s.text('project_directory'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
}, (table) => [
  s.index('scheduled_tasks_status_next_run_at_idx').on(table.status, table.next_run_at),
  s.index('scheduled_tasks_channel_id_status_idx').on(table.channel_id, table.status),
  s.index('scheduled_tasks_thread_id_status_idx').on(table.thread_id, table.status),
])

export const session_sleeps = s.sqliteTable('session_sleeps', {
  session_id: s.text('session_id').primaryKey().notNull(),
  wake_at: datetime('wake_at').notNull(),
  reason: s.text('reason'),
  status: s.text('status', { enum: ['planned', 'consumed', 'cancelled', 'failed'] }).notNull().default('planned'),
  delivery_id: s.text('delivery_id').notNull().$defaultFn(() => crypto.randomUUID()),
  attempts: s.integer('attempts', { mode: 'number' }).notNull().default(0),
  last_attempt_at: datetime('last_attempt_at'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
}, (table) => [
  s.index('session_sleeps_status_wake_at_idx').on(table.status, table.wake_at),
])

export const relations = defineRelations({
  thread_sessions,
  bot_tokens,
  bot_api_keys,
  channel_directories,
  guild_categories,
  channel_models,
  channel_agents,
  channel_worktrees,
  channel_verbosity,
  channel_mention_mode,
  scheduled_tasks,
  session_sleeps,
}, (r) => ({
  thread_sessions: {
    scheduled_tasks: r.many.scheduled_tasks(),
  },
  bot_tokens: {
    api_keys: r.one.bot_api_keys({ from: r.bot_tokens.app_id, to: r.bot_api_keys.app_id }),
  },
  bot_api_keys: {
    bot: r.one.bot_tokens({ from: r.bot_api_keys.app_id, to: r.bot_tokens.app_id }),
  },
  guild_categories: {},
  channel_directories: {
    channel_model: r.one.channel_models({ from: r.channel_directories.channel_id, to: r.channel_models.channel_id }),
    channel_agent: r.one.channel_agents({ from: r.channel_directories.channel_id, to: r.channel_agents.channel_id }),
    channel_worktree: r.one.channel_worktrees({ from: r.channel_directories.channel_id, to: r.channel_worktrees.channel_id }),
    channel_verbosity: r.one.channel_verbosity({ from: r.channel_directories.channel_id, to: r.channel_verbosity.channel_id }),
    channel_mention_mode: r.one.channel_mention_mode({ from: r.channel_directories.channel_id, to: r.channel_mention_mode.channel_id }),
    scheduled_tasks: r.many.scheduled_tasks(),
  },
  channel_models: {
    channel: r.one.channel_directories({ from: r.channel_models.channel_id, to: r.channel_directories.channel_id }),
  },
  channel_agents: {
    channel: r.one.channel_directories({ from: r.channel_agents.channel_id, to: r.channel_directories.channel_id }),
  },
  channel_worktrees: {
    channel: r.one.channel_directories({ from: r.channel_worktrees.channel_id, to: r.channel_directories.channel_id }),
  },
  channel_verbosity: {
    channel: r.one.channel_directories({ from: r.channel_verbosity.channel_id, to: r.channel_directories.channel_id }),
  },
  channel_mention_mode: {
    channel: r.one.channel_directories({ from: r.channel_mention_mode.channel_id, to: r.channel_directories.channel_id }),
  },
  scheduled_tasks: {
    channel: r.one.channel_directories({ from: r.scheduled_tasks.channel_id, to: r.channel_directories.channel_id }),
    thread: r.one.thread_sessions({ from: r.scheduled_tasks.thread_id, to: r.thread_sessions.thread_id }),
  },
  session_sleeps: {},
}))

export type V1Verbosity = typeof channel_verbosity.$inferSelect.verbosity
