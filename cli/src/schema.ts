// Drizzle schema for Kimaki's local SQLite database.
// Mirrors the existing generated tables so user databases keep working.

import { defineRelations } from 'drizzle-orm'
import * as orm from 'drizzle-orm'
import * as sqliteCore from 'drizzle-orm/sqlite-core'
import crypto from 'node:crypto'

const datetime = sqliteCore.customType<{
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

export const thread_sessions = sqliteCore.sqliteTable('thread_sessions', {
  thread_id: sqliteCore.text('thread_id').primaryKey().notNull(),
  session_id: sqliteCore.text('session_id').notNull(),
  source: sqliteCore.text('source', { enum: ['kimaki', 'external_poll'] }).notNull().default('kimaki'),
  last_synced_name: sqliteCore.text('last_synced_name'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
})

export const session_events = sqliteCore.sqliteTable('session_events', {
  id: sqliteCore.integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }).notNull(),
  session_id: sqliteCore.text('session_id').notNull(),
  thread_id: sqliteCore.text('thread_id').notNull().references(() => thread_sessions.thread_id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  timestamp: sqliteCore.integer('timestamp', { mode: 'number' }).notNull(),
  event_index: sqliteCore.integer('event_index', { mode: 'number' }).notNull(),
  event_json: sqliteCore.text('event_json').notNull(),
}, (table) => [
  sqliteCore.index('session_events_session_id_timestamp_event_index_id_idx').on(table.session_id, table.timestamp, table.event_index, table.id),
  sqliteCore.index('session_events_thread_id_timestamp_event_index_id_idx').on(table.thread_id, table.timestamp, table.event_index, table.id),
])

export const part_messages = sqliteCore.sqliteTable('part_messages', {
  part_id: sqliteCore.text('part_id').primaryKey().notNull(),
  message_id: sqliteCore.text('message_id').notNull(),
  thread_id: sqliteCore.text('thread_id').notNull().references(() => thread_sessions.thread_id, { onUpdate: 'cascade' }),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
})

export const bot_tokens = sqliteCore.sqliteTable('bot_tokens', {
  app_id: sqliteCore.text('app_id').primaryKey().notNull(),
  token: sqliteCore.text('token').notNull(),
  bot_mode: sqliteCore.text('bot_mode', { enum: ['self_hosted', 'gateway'] }).notNull().default('self_hosted'),
  client_id: sqliteCore.text('client_id'),
  client_secret: sqliteCore.text('client_secret'),
  proxy_url: sqliteCore.text('proxy_url'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  last_used_at: datetime('last_used_at'),
})

export const channel_directories = sqliteCore.sqliteTable('channel_directories', {
  channel_id: sqliteCore.text('channel_id').primaryKey().notNull(),
  directory: sqliteCore.text('directory').notNull(),
  channel_type: sqliteCore.text('channel_type', { enum: ['text', 'voice'] }).notNull(),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
})

export const bot_api_keys = sqliteCore.sqliteTable('bot_api_keys', {
  app_id: sqliteCore.text('app_id').primaryKey().notNull().references(() => bot_tokens.app_id, { onUpdate: 'cascade' }),
  gemini_api_key: sqliteCore.text('gemini_api_key'),
  openai_api_key: sqliteCore.text('openai_api_key'),
  xai_api_key: sqliteCore.text('xai_api_key'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
})

export const thread_worktrees = sqliteCore.sqliteTable('thread_worktrees', {
  thread_id: sqliteCore.text('thread_id').primaryKey().notNull().references(() => thread_sessions.thread_id, { onUpdate: 'cascade' }),
  worktree_name: sqliteCore.text('worktree_name').notNull(),
  worktree_directory: sqliteCore.text('worktree_directory'),
  project_directory: sqliteCore.text('project_directory').notNull(),
  status: sqliteCore.text('status', { enum: ['pending', 'ready', 'error'] }).notNull().default('pending'),
  error_message: sqliteCore.text('error_message'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
})

export const channel_models = sqliteCore.sqliteTable('channel_models', {
  channel_id: sqliteCore.text('channel_id').primaryKey().notNull().references(() => channel_directories.channel_id, { onUpdate: 'cascade' }),
  model_id: sqliteCore.text('model_id').notNull(),
  variant: sqliteCore.text('variant'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const session_models = sqliteCore.sqliteTable('session_models', {
  session_id: sqliteCore.text('session_id').primaryKey().notNull(),
  model_id: sqliteCore.text('model_id').notNull(),
  variant: sqliteCore.text('variant'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
})

export const channel_agents = sqliteCore.sqliteTable('channel_agents', {
  channel_id: sqliteCore.text('channel_id').primaryKey().notNull().references(() => channel_directories.channel_id, { onUpdate: 'cascade' }),
  agent_name: sqliteCore.text('agent_name').notNull(),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const session_agents = sqliteCore.sqliteTable('session_agents', {
  session_id: sqliteCore.text('session_id').primaryKey().notNull(),
  agent_name: sqliteCore.text('agent_name').notNull(),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
})

export const channel_worktrees = sqliteCore.sqliteTable('channel_worktrees', {
  channel_id: sqliteCore.text('channel_id').primaryKey().notNull().references(() => channel_directories.channel_id, { onUpdate: 'cascade' }),
  enabled: sqliteCore.integer('enabled', { mode: 'number' }).notNull().default(0),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const channel_verbosity = sqliteCore.sqliteTable('channel_verbosity', {
  channel_id: sqliteCore.text('channel_id').primaryKey().notNull().references(() => channel_directories.channel_id, { onUpdate: 'cascade' }),
  verbosity: sqliteCore.text('verbosity', { enum: ['tools_and_text', 'text_and_essential_tools', 'text_only'] }).notNull().default('tools_and_text'),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const channel_mention_mode = sqliteCore.sqliteTable('channel_mention_mode', {
  channel_id: sqliteCore.text('channel_id').primaryKey().notNull().references(() => channel_directories.channel_id, { onUpdate: 'cascade' }),
  enabled: sqliteCore.integer('enabled', { mode: 'number' }).notNull().default(0),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const global_models = sqliteCore.sqliteTable('global_models', {
  app_id: sqliteCore.text('app_id').primaryKey().notNull().references(() => bot_tokens.app_id, { onUpdate: 'cascade' }),
  model_id: sqliteCore.text('model_id').notNull(),
  variant: sqliteCore.text('variant'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
})

export const scheduled_tasks = sqliteCore.sqliteTable('scheduled_tasks', {
  id: sqliteCore.integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }).notNull(),
  status: sqliteCore.text('status', { enum: ['planned', 'running', 'completed', 'cancelled', 'failed'] }).notNull().default('planned'),
  schedule_kind: sqliteCore.text('schedule_kind', { enum: ['at', 'cron'] }).notNull(),
  run_at: datetime('run_at'),
  cron_expr: sqliteCore.text('cron_expr'),
  timezone: sqliteCore.text('timezone'),
  next_run_at: datetime('next_run_at').notNull(),
  running_started_at: datetime('running_started_at'),
  last_run_at: datetime('last_run_at'),
  last_error: sqliteCore.text('last_error'),
  attempts: sqliteCore.integer('attempts', { mode: 'number' }).notNull().default(0),
  payload_json: sqliteCore.text('payload_json').notNull(),
  prompt_preview: sqliteCore.text('prompt_preview').notNull(),
  channel_id: sqliteCore.text('channel_id').references(() => channel_directories.channel_id, { onDelete: 'set null', onUpdate: 'cascade' }),
  thread_id: sqliteCore.text('thread_id').references(() => thread_sessions.thread_id, { onDelete: 'set null', onUpdate: 'cascade' }),
  session_id: sqliteCore.text('session_id'),
  project_directory: sqliteCore.text('project_directory'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
}, (table) => [
  sqliteCore.index('scheduled_tasks_status_next_run_at_idx').on(table.status, table.next_run_at),
  sqliteCore.index('scheduled_tasks_channel_id_status_idx').on(table.channel_id, table.status),
  sqliteCore.index('scheduled_tasks_thread_id_status_idx').on(table.thread_id, table.status),
])

export const session_start_sources = sqliteCore.sqliteTable('session_start_sources', {
  session_id: sqliteCore.text('session_id').primaryKey().notNull(),
  schedule_kind: sqliteCore.text('schedule_kind', { enum: ['at', 'cron'] }).notNull(),
  scheduled_task_id: sqliteCore.integer('scheduled_task_id', { mode: 'number' }).references(() => scheduled_tasks.id, { onDelete: 'set null', onUpdate: 'cascade' }),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
}, (table) => [
  sqliteCore.index('session_start_sources_scheduled_task_id_idx').on(table.scheduled_task_id),
])

export const forum_sync_configs = sqliteCore.sqliteTable('forum_sync_configs', {
  id: sqliteCore.integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }).notNull(),
  app_id: sqliteCore.text('app_id').notNull().references(() => bot_tokens.app_id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  forum_channel_id: sqliteCore.text('forum_channel_id').notNull(),
  output_dir: sqliteCore.text('output_dir').notNull(),
  direction: sqliteCore.text('direction').notNull().default('bidirectional'),
  created_at: datetime('created_at').default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
}, (table) => [
  sqliteCore.uniqueIndex('forum_sync_configs_app_id_forum_channel_id_key').on(table.app_id, table.forum_channel_id),
])

export const ipc_requests = sqliteCore.sqliteTable('ipc_requests', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => crypto.randomUUID()),
  type: sqliteCore.text('type', { enum: ['file_upload', 'action_buttons'] }).notNull(),
  session_id: sqliteCore.text('session_id').notNull(),
  thread_id: sqliteCore.text('thread_id').notNull().references(() => thread_sessions.thread_id, { onUpdate: 'cascade' }),
  payload: sqliteCore.text('payload').notNull(),
  response: sqliteCore.text('response'),
  status: sqliteCore.text('status', { enum: ['pending', 'processing', 'completed', 'cancelled'] }).notNull().default('pending'),
  created_at: datetime('created_at').notNull().default(orm.sql`CURRENT_TIMESTAMP`),
  updated_at: datetime('updated_at').notNull().default(orm.sql`CURRENT_TIMESTAMP`).$onUpdate(() => new Date()),
}, (table) => [
  sqliteCore.index('ipc_requests_status_created_at_idx').on(table.status, table.created_at),
])

export const relations = defineRelations({
  thread_sessions,
  session_events,
  part_messages,
  bot_tokens,
  bot_api_keys,
  thread_worktrees,
  channel_directories,
  channel_models,
  session_models,
  channel_agents,
  session_agents,
  channel_worktrees,
  channel_verbosity,
  channel_mention_mode,
  global_models,
  scheduled_tasks,
  session_start_sources,
  forum_sync_configs,
  ipc_requests,
}, (r) => ({
  thread_sessions: {
    session_events: r.many.session_events(),
    part_messages: r.many.part_messages(),
    scheduled_tasks: r.many.scheduled_tasks(),
    thread_worktree: r.one.thread_worktrees({ from: r.thread_sessions.thread_id, to: r.thread_worktrees.thread_id }),
    ipc_requests: r.many.ipc_requests(),
  },
  session_events: {
    thread: r.one.thread_sessions({ from: r.session_events.thread_id, to: r.thread_sessions.thread_id }),
  },
  part_messages: {
    thread: r.one.thread_sessions({ from: r.part_messages.thread_id, to: r.thread_sessions.thread_id }),
  },
  bot_tokens: {
    api_keys: r.one.bot_api_keys({ from: r.bot_tokens.app_id, to: r.bot_api_keys.app_id }),
    forum_sync_configs: r.many.forum_sync_configs(),
    global_model: r.one.global_models({ from: r.bot_tokens.app_id, to: r.global_models.app_id }),
  },
  bot_api_keys: {
    bot: r.one.bot_tokens({ from: r.bot_api_keys.app_id, to: r.bot_tokens.app_id }),
  },
  thread_worktrees: {
    thread: r.one.thread_sessions({ from: r.thread_worktrees.thread_id, to: r.thread_sessions.thread_id }),
  },
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
  session_models: {},
  channel_agents: {
    channel: r.one.channel_directories({ from: r.channel_agents.channel_id, to: r.channel_directories.channel_id }),
  },
  session_agents: {},
  channel_worktrees: {
    channel: r.one.channel_directories({ from: r.channel_worktrees.channel_id, to: r.channel_directories.channel_id }),
  },
  channel_verbosity: {
    channel: r.one.channel_directories({ from: r.channel_verbosity.channel_id, to: r.channel_directories.channel_id }),
  },
  channel_mention_mode: {
    channel: r.one.channel_directories({ from: r.channel_mention_mode.channel_id, to: r.channel_directories.channel_id }),
  },
  global_models: {
    bot: r.one.bot_tokens({ from: r.global_models.app_id, to: r.bot_tokens.app_id }),
  },
  scheduled_tasks: {
    channel: r.one.channel_directories({ from: r.scheduled_tasks.channel_id, to: r.channel_directories.channel_id }),
    thread: r.one.thread_sessions({ from: r.scheduled_tasks.thread_id, to: r.thread_sessions.thread_id }),
    session_start_sources: r.many.session_start_sources(),
  },
  session_start_sources: {
    scheduled_task: r.one.scheduled_tasks({ from: r.session_start_sources.scheduled_task_id, to: r.scheduled_tasks.id }),
  },
  forum_sync_configs: {
    bot: r.one.bot_tokens({ from: r.forum_sync_configs.app_id, to: r.bot_tokens.app_id }),
  },
  ipc_requests: {
    thread: r.one.thread_sessions({ from: r.ipc_requests.thread_id, to: r.thread_sessions.thread_id }),
  },
}))

export type BotMode = typeof bot_tokens.$inferSelect.bot_mode
export type ChannelType = typeof channel_directories.$inferSelect.channel_type
export type IpcRequestType = typeof ipc_requests.$inferSelect.type
export type SessionEvent = typeof session_events.$inferSelect
export type ThreadSessionSource = typeof thread_sessions.$inferSelect.source
export type VerbosityLevel = typeof channel_verbosity.$inferSelect.verbosity
export type WorktreeStatus = typeof thread_worktrees.$inferSelect.status
