// Scheduled tasks (spec 26 #5, 30 Phase 8). Time is an input: `Clock.now()`
// is the only source of "now", so tests drive the scheduler with a manual
// clock and no timers.
//
//   kimaki send --send-at ─▶ createTask ─▶ scheduled_tasks (V1 table and payload)
//
//   createScheduler loop (every 5s, production only)
//     └─▶ runDueTasks ─▶ runDueWakes (sleeps.ts)
//                     └▶ due tasks: claim ─▶ busy check ─▶ pre-run ─▶ send
//
// Task runs are in-process calls of the same `send` action as `kimaki send`;
// the task ID goes in session metadata.

import { exec } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { CronExpressionParser } from 'cron-parser'
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SlashCommandBuilder,
  type APIMessageTopLevelComponent,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import * as errore from 'errore'
import * as orm from 'drizzle-orm'

import { oc, projectOf, threadOfSession, type Bot } from './bot.ts'
import type { KimakiDb } from './db.ts'
import { ConfigError, DbError, DiscordError } from './errors.ts'
import type { InteractionRoutes } from './interaction-context.ts'
import { createLogger } from './logger.ts'
import type { SendInput } from './lock-routes.ts'
import { send } from './prompt.ts'
import * as schema from './schema.ts'
import { parseFutureUtc, runDueWakes } from './sleeps.ts'

const logger = createLogger('TASK')
const execAsync = promisify(exec)

export type Clock = { now(): number }

export const systemClock: Clock = { now: () => Date.now() }

const DUE_BATCH = 20
// A hung pre-run command must not block every later task and wake.
const PRE_RUN_TIMEOUT_MS = 10 * 60_000
// /tasks rows: text + action row + 2 buttons each, under the 40-component limit.
const MAX_TASK_ROWS = 7

const TASK_RUN_PREFIX = 'task_run:'
const TASK_DELETE_PREFIX = 'task_delete:'

type TaskRow = typeof schema.scheduled_tasks.$inferSelect

// --- Pure time logic.

export function nextCronRun({ cronExpr, timezone, from }: { cronExpr: string; timezone: string; from: number }): ConfigError | number {
  return errore.try(
    () => CronExpressionParser.parse(cronExpr, { currentDate: new Date(from), tz: timezone }).next().getTime(),
    (cause) => new ConfigError({ reason: `Invalid cron expression: ${cronExpr}`, cause }),
  )
}

// The run after one that happens at `now`: null for one-shots. Missed cron
// occurrences fire once: the next run counts from `now`, not from the due time.
export function nextRunOf({ row, now }: { row: Pick<TaskRow, 'id' | 'schedule_kind' | 'cron_expr' | 'timezone'>; now: number }): ConfigError | number | null {
  if (row.schedule_kind === 'at') return null
  if (!row.cron_expr) return new ConfigError({ reason: `Task ${row.id} has no cron expression` })
  // V1 rows may carry a timezone; new tasks are UTC.
  return nextCronRun({ cronExpr: row.cron_expr, timezone: row.timezone || 'UTC', from: now })
}

export type SendAt = { kind: 'at'; runAt: number } | { kind: 'cron'; cronExpr: string; nextRunAt: number }

// `--send-at`: a UTC date ending in Z, or a cron expression evaluated in UTC.
export function parseSendAt({ value, now }: { value: string; now: number }): ConfigError | SendAt {
  const trimmed = value.trim()
  if (!trimmed) return new ConfigError({ reason: '--send-at cannot be empty' })
  if (trimmed.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const runAt = parseFutureUtc({ value: trimmed, now, flag: '--send-at' })
    if (runAt instanceof Error) return runAt
    return { kind: 'at', runAt }
  }
  const next = nextCronRun({ cronExpr: trimmed, timezone: 'UTC', from: now })
  if (next instanceof Error) {
    return new ConfigError({ reason: `Invalid --send-at value: "${trimmed}". Use a UTC ISO date ending in Z or a cron expression.`, cause: next })
  }
  return { kind: 'cron', cronExpr: trimmed, nextRunAt: next }
}


// --- Task payload. On disk it keeps V1's JSON shape (spec 17), so V1 rows run
// unchanged. It is decoded once into the `send` input of every run.
// `username` and `injectionGuardPatterns` are unused; kept so edits write them back.

export type TaskJob = {
  send: SendInput
  preRun: string | null
  allowConcurrency: boolean
  username: string | null
  injectionGuardPatterns: string[] | null
}

export function decodeTaskPayload(json: string): ConfigError | TaskJob {
  const parsed = errore.try(() => ({ value: JSON.parse(json) as unknown }), (cause) => new ConfigError({ reason: 'Task payload is not valid JSON', cause }))
  if (parsed instanceof Error) return parsed
  const value = parsed.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new ConfigError({ reason: 'Task payload must be an object' })
  const fields = new Map(Object.entries(value))
  const text = (key: string) => {
    const field = fields.get(key)
    return typeof field === 'string' ? field : null
  }
  const list = (key: string) => {
    const field = fields.get(key)
    return Array.isArray(field) ? field.filter((item): item is string => typeof item === 'string') : null
  }
  const prompt = text('prompt')
  if (!prompt) return new ConfigError({ reason: 'Task payload has no prompt' })
  const agent = text('agent')
  const model = text('model')
  const user = text('userId')
  const parentSessionId = text('parentSessionId')
  const permissions = list('permissions')
  const common = {
    prompt,
    ...(agent !== null && { agent }),
    ...(model !== null && { model }),
    ...(user !== null && { user: [user] }),
    ...(parentSessionId !== null && { parentSessionId }),
    ...(permissions !== null && { permissions }),
  }
  const job = (send: SendInput): TaskJob => ({
    send,
    preRun: text('preRunCommand'),
    allowConcurrency: fields.get('allowConcurrency') === true,
    username: text('username'),
    injectionGuardPatterns: list('injectionGuardPatterns'),
  })
  const kind = text('kind')
  const threadId = text('threadId')
  const channelId = text('channelId')
  if (kind === 'thread' && threadId) return job({ ...common, threadId })
  if (kind !== 'channel' || !channelId) return new ConfigError({ reason: `Task payload has unknown kind ${kind ?? '(none)'} or no target` })
  const name = text('name')
  const cwd = text('cwd')
  const worktree = text('worktreeName')
  const baseBranch = text('baseBranch')
  return job({
    ...common,
    channelId,
    ...(name !== null && { name }),
    ...(cwd !== null && { cwd }),
    // '' asks for an automatic worktree name.
    ...(worktree !== null && { worktree }),
    ...(baseBranch !== null && { baseBranch }),
    ...(fields.get('notifyOnly') === true && { notifyOnly: true }),
  })
}

// The V1 JSON shape: every field present, null when unset.
export function encodeTaskPayload({ send, preRun, allowConcurrency, username, injectionGuardPatterns }: TaskJob): ConfigError | string {
  const base = {
    prompt: send.prompt,
    agent: send.agent ?? null,
    model: send.model ?? null,
    username,
    userId: send.user?.[0] ?? null,
    permissions: send.permissions ?? null,
    injectionGuardPatterns,
    parentSessionId: send.parentSessionId ?? null,
    preRunCommand: preRun,
    allowConcurrency,
  }
  if (send.threadId) return JSON.stringify({ ...base, kind: 'thread', threadId: send.threadId })
  if (!send.channelId) return new ConfigError({ reason: 'A task needs a channel or a thread' })
  return JSON.stringify({
    ...base,
    kind: 'channel',
    channelId: send.channelId,
    name: send.name ?? null,
    notifyOnly: send.notifyOnly === true,
    worktreeName: send.worktree ?? null,
    cwd: send.cwd ?? null,
    ...(send.baseBranch !== undefined && { baseBranch: send.baseBranch }),
  })
}

function preview(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}...`
}

export type ScheduleOptions = { sendAt: string; preRun: string | null; allowConcurrency: boolean }

export type TaskEdit = {
  id: number
  prompt?: string
  sendAt?: string
  agent?: string
  model?: string
  preRun?: string
  allowConcurrency?: boolean
  user?: string
}

// Discord user ID from an ID or a mention; '' clears.
function userIdOf(value: string): ConfigError | string | null {
  if (!value) return null
  const id = value.replace(/^<@!?(\d+)>$/, '$1')
  if (!/^\d+$/.test(id)) return new ConfigError({ reason: `Use a Discord user ID or mention, not "${value}". Find IDs with: kimaki user list --guild <id> --query <name>` })
  return id
}

export type TaskListItem = {
  id: number
  status: TaskRow['status']
  schedule: string
  nextRunAt: string
  prompt: string
  channelId: string | null
  threadId: string | null
  agent: string | null
  model: string | null
  userId: string | null
  preRun: string | null
  allowConcurrency: boolean
  lastError: string | null
}

// Tasks that still matter: planned, running, and failed (to show the error).
// Rows V1 finished or cancelled are history, which V2 does not show.
// `guildId`: only tasks of that guild's channels (Discord /tasks). Channels
// stored before guild_id existed belong to every guild.
export async function listTasks({ db, guildId = null }: { db: KimakiDb; guildId?: string | null }): Promise<DbError | TaskListItem[]> {
  const rows = await db.query.scheduled_tasks
    .findMany({ where: { status: { in: ['planned', 'running', 'failed'] } }, orderBy: { next_run_at: 'asc', id: 'asc' }, with: { channel: true } })
    .catch((cause) => new DbError({ operation: 'read scheduled_tasks', cause }))
  if (rows instanceof Error) return rows
  const visible = guildId === null ? rows : rows.filter((row) => row.channel && (!row.channel.guild_id || row.channel.guild_id === guildId))
  return visible.map((row) => {
    const decoded = decodeTaskPayload(row.payload_json)
    const job = decoded instanceof Error ? null : decoded
    return {
      id: row.id,
      status: row.status,
      schedule: row.schedule_kind === 'cron' ? `cron ${row.cron_expr ?? '?'}${row.timezone && row.timezone !== 'UTC' ? ` (${row.timezone})` : ''}` : 'once',
      nextRunAt: row.next_run_at.toISOString(),
      prompt: row.prompt_preview,
      channelId: row.channel_id,
      threadId: job?.send.threadId ?? null,
      agent: job?.send.agent ?? null,
      model: job?.send.model ?? null,
      userId: job?.send.user?.[0] ?? null,
      preRun: job?.preRun ?? null,
      allowConcurrency: job?.allowConcurrency ?? false,
      lastError: row.last_error,
    }
  })
}

type RunOutcome =
  | { kind: 'ran'; threadId: string; sessionId: string | null }
  | { kind: 'busy'; sessionId: string }
  | { kind: 'skipped'; reason: string }

// Exit 0 runs the task with stdout appended; any other exit skips this occurrence.
async function preRun({ row, job }: { row: TaskRow; job: TaskJob }): Promise<ConfigError | { prompt: string } | { skip: string }> {
  const command = job.preRun
  const prompt = job.send.prompt
  if (!command) return { prompt }
  if (!row.project_directory) return new ConfigError({ reason: `Task ${row.id} has a pre-run command but no project directory` })
  const result = await execAsync(command, { cwd: row.project_directory, timeout: PRE_RUN_TIMEOUT_MS })
    .catch((cause: Error & { code?: number | string; stdout?: string; stderr?: string }) => cause)
  if (result.stderr) logger.log(`task ${row.id} pre-run stderr:\n${result.stderr}`)
  if (result instanceof Error) {
    logger.log(`task ${row.id} pre-run exited with ${result.code ?? 'an error'}, skipping this run`)
    return { skip: `pre-run exited with ${result.code ?? result.message}` }
  }
  const output = result.stdout.trim()
  logger.log(`task ${row.id} pre-run passed`)
  return { prompt: output ? `${prompt}\n\n## Pre-run command output\n\n${output}` : prompt }
}

async function execute(bot: Bot, row: TaskRow): Promise<Error | RunOutcome> {
  const job = decodeTaskPayload(row.payload_json)
  if (job instanceof Error) return job
  if (job.send.permissions?.length && (job.send.threadId || job.send.notifyOnly)) {
    return new ConfigError({ reason: `Task ${row.id}: --permission applies only to new sessions. Recreate the task for a project channel without --notify-only` })
  }
  // Non-overlap: the session of the previous run must be idle.
  const lastSession = row.session_id
  if (!job.allowConcurrency && lastSession) {
    const active = await oc(bot, 'session.active', (client) => client.session.active())
    if (active instanceof Error) return active
    if (lastSession in active) return { kind: 'busy', sessionId: lastSession }
  }
  const checked = await preRun({ row, job })
  if (checked instanceof Error) return checked
  if ('skip' in checked) return { kind: 'skipped', reason: checked.skip }
  // Deleted or edited during the pre-run: this occurrence no longer exists.
  const current = await bot.db.query.scheduled_tasks
    .findFirst({ where: { id: row.id }, columns: { status: true } })
    .catch((cause) => new DbError({ operation: `recheck task ${row.id}`, cause }))
  if (current instanceof Error) return current
  if (current?.status !== 'running') return { kind: 'skipped', reason: 'deleted while its pre-run ran' }
  const task = { id: row.id, cronExpr: row.schedule_kind === 'cron' ? row.cron_expr : null, timezone: row.timezone }
  const input = {
    ...job.send,
    prompt: checked.prompt,
    agent: job.send.agent || undefined,
    model: job.send.model || undefined,
    user: job.send.user?.length ? job.send.user : undefined,
    parentSessionId: job.send.parentSessionId || undefined,
    permissions: job.send.permissions?.length ? job.send.permissions : undefined,
    name: job.send.name || undefined,
    cwd: job.send.cwd || undefined,
    baseBranch: job.send.baseBranch || undefined,
  }
  const sent = await send(bot, input, { localOnly: true, task })
  if (sent instanceof Error) return sent
  return { kind: 'ran', threadId: sent.threadId, sessionId: sent.sessionId }
}

const running = orm.eq(schema.scheduled_tasks.status, 'running')

async function finish(
  bot: Bot,
  { row, nextRunAt, outcome }: { row: TaskRow; nextRunAt: ConfigError | number | null; outcome: Error | RunOutcome },
): Promise<DbError | void> {
  const at = new Date(bot.clock.now())
  const where = orm.and(orm.eq(schema.scheduled_tasks.id, row.id), running)
  const update = (set: Partial<typeof schema.scheduled_tasks.$inferInsert>) =>
    bot.db.update(schema.scheduled_tasks).set({ running_started_at: null, ...set }).where(where).then(() => undefined)
      .catch((cause) => new DbError({ operation: `finish task ${row.id}`, cause }))
  const next = nextRunAt instanceof Error || nextRunAt === null ? null : new Date(nextRunAt)
  if (outcome instanceof Error) {
    logger.warn(`task ${row.id} failed`, outcome)
    // The claim makes this process the only writer of the row until finish.
    const attempts = row.attempts + 1
    // A cron task tries again at its next occurrence.
    if (next) return update({ status: 'planned', next_run_at: next, last_run_at: at, last_error: outcome.message, attempts })
    return update({ status: 'failed', last_run_at: at, last_error: outcome.message, attempts })
  }
  if (outcome.kind === 'busy') {
    logger.log(`task ${row.id} skipped: its last session ${outcome.sessionId} is still running`)
    // One-shot: stays due and runs on a later tick. Cron: this occurrence is skipped.
    return update({ status: 'planned', ...(next && { next_run_at: next }) })
  }
  const ran = outcome.kind === 'ran' && outcome.sessionId ? { session_id: outcome.sessionId, thread_id: outcome.threadId } : {}
  if (row.schedule_kind === 'at') {
    const removed = await bot.db.delete(schema.scheduled_tasks).where(where)
      .catch((cause) => new DbError({ operation: `delete task ${row.id}`, cause }))
    if (removed instanceof Error) return removed
    return
  }
  if (!next) return update({ status: 'failed', last_run_at: at, last_error: nextRunAt instanceof Error ? nextRunAt.message : 'No next run' })
  return update({ status: 'planned', next_run_at: next, last_run_at: at, last_error: null, ...ran })
}

// claim ─▶ execute ─▶ finish. The claim returns the current row, so a task
// edited or run by another caller after the due list was read runs as it is
// now, once. `dueAt`: only claim the occurrence the due list saw; null runs now.
async function runTask(bot: Bot, { id, dueAt }: { id: number; dueAt: Date | null }): Promise<Error | RunOutcome> {
  const time = bot.clock.now()
  const claimed = await bot.db.update(schema.scheduled_tasks)
    .set({ status: 'running', running_started_at: new Date(time) })
    .where(orm.and(
      orm.eq(schema.scheduled_tasks.id, id),
      orm.eq(schema.scheduled_tasks.status, 'planned'),
      ...(dueAt ? [orm.eq(schema.scheduled_tasks.next_run_at, dueAt), orm.lte(schema.scheduled_tasks.next_run_at, new Date(time))] : []),
    ))
    .returning()
    .catch((cause) => new DbError({ operation: `claim task ${id}`, cause }))
  if (claimed instanceof Error) return claimed
  const row = claimed[0]
  if (!row) return new ConfigError({ reason: `Task #${id} is already running or no longer planned` })
  logger.log(`running task ${row.id}`)
  const outcome = await execute(bot, row)
  const finished = await finish(bot, { row, nextRunAt: nextRunOf({ row, now: time }), outcome })
  if (finished instanceof Error) return finished
  return outcome
}


// Wakes first: they are quick, while a task can wait for its pre-run.
// One at a time: runs share the OpenCode service and Discord rate limits.
async function runDueTasks(bot: Bot): Promise<void> {
  const time = bot.clock.now()
  await runDueWakes(bot, { time, limit: DUE_BATCH })
  const tasks = await bot.db.query.scheduled_tasks
    .findMany({ where: { status: 'planned', next_run_at: { lte: new Date(time) } }, orderBy: { next_run_at: 'asc', id: 'asc' }, limit: DUE_BATCH })
    .catch((cause) => new DbError({ operation: 'read due tasks', cause }))
  if (tasks instanceof Error) return logger.error(tasks)
  for (const row of tasks) {
    const ran = await runTask(bot, { id: row.id, dueAt: row.next_run_at })
    if (ran instanceof Error) logger.warn(ran)
  }
}

// --- Writers behind the lock server and /tasks.

export async function createTask(bot: Bot, { send: input, options }: { send: SendInput; options: ScheduleOptions }) {
  const when = parseSendAt({ value: options.sendAt, now: bot.clock.now() })
  if (when instanceof Error) return when
  if (input.files?.length) return new ConfigError({ reason: '--file cannot be scheduled. Put the file in the project and name it in the prompt.' })
  if ((input.user?.length ?? 0) > 1) return new ConfigError({ reason: 'A scheduled task takes one --user' })
  const user = userIdOf(input.user?.[0] ?? '')
  if (user instanceof Error) return user
  if (input.model && !/^[^/]+\/.+$/.test(input.model)) return new ConfigError({ reason: 'Use --model provider/model' })
  const roots = bot.store.getState().roots
  const threadId = input.threadId ?? (input.sessionId ? threadOfSession(bot, input.sessionId) : null)
  if ((input.threadId || input.sessionId) && (!threadId || !roots[threadId])) {
    return new ConfigError({ reason: 'Schedule thread tasks on the machine that owns the thread (no local session for it)' })
  }
  if (threadId && input.notifyOnly) return new ConfigError({ reason: '--notify-only needs --channel or --project, not a thread' })
  if (threadId && input.permissions?.length) return new ConfigError({ reason: '--permission applies only to new sessions, not a thread' })
  const project = await (async () => {
    if (threadId) {
      const thread = await bot.discord.channels.fetch(threadId).catch((cause) => new DiscordError({ operation: `fetch thread ${threadId}`, cause }))
      if (thread instanceof Error) return thread
      if (!thread?.isThread() || !thread.parentId) return null
      return projectOf(bot, thread.parentId)
    }
    return bot.db.query.channel_directories
      .findFirst({ where: input.channelId ? { channel_id: input.channelId } : { directory: path.resolve(input.project!) } })
      .catch((cause) => new DbError({ operation: 'resolve task project', cause }))
  })()
  if (project instanceof Error) return project
  if (!project) return new ConfigError({ reason: 'Schedule tasks on the machine that owns the channel (no local project for it)' })
  // The encoder keeps only the fields of the target kind.
  const target = threadId ? { threadId } : { channelId: project.channel_id }
  const payload = encodeTaskPayload({
    send: { ...input, ...target, user: user ? [user] : undefined },
    preRun: options.preRun,
    allowConcurrency: options.allowConcurrency,
    username: null,
    injectionGuardPatterns: null,
  })
  if (payload instanceof Error) return payload
  const nextRunAt = when.kind === 'at' ? when.runAt : when.nextRunAt
  const inserted = await bot.db.insert(schema.scheduled_tasks).values({
    status: 'planned',
    schedule_kind: when.kind,
    run_at: when.kind === 'at' ? new Date(when.runAt) : null,
    cron_expr: when.kind === 'cron' ? when.cronExpr : null,
    timezone: when.kind === 'cron' ? 'UTC' : null,
    next_run_at: new Date(nextRunAt),
    payload_json: payload,
    prompt_preview: preview(input.prompt),
    channel_id: project.channel_id,
    thread_id: threadId ?? null,
    session_id: threadId ? roots[threadId]! : null,
    project_directory: project.directory,
  }).returning({ id: schema.scheduled_tasks.id }).catch((cause) => new DbError({ operation: 'insert scheduled task', cause }))
  if (inserted instanceof Error) return inserted
  const taskId = inserted[0]!.id
  logger.log(`scheduled task ${taskId} (${when.kind}) for ${new Date(nextRunAt).toISOString()}`)
  return { taskId, schedule: when.kind === 'cron' ? when.cronExpr : 'once', nextRunAt: new Date(nextRunAt).toISOString() }
}

export async function editTask(bot: Bot, edit: TaskEdit) {
  const row = await bot.db.query.scheduled_tasks.findFirst({ where: { id: edit.id } }).catch((cause) => new DbError({ operation: 'read task', cause }))
  if (row instanceof Error) return row
  if (!row) return new ConfigError({ reason: `Task ${edit.id} not found. List tasks with: kimaki task list` })
  if (row.status !== 'planned') return new ConfigError({ reason: `Task ${edit.id} is ${row.status}; only planned tasks can be edited` })
  const job = decodeTaskPayload(row.payload_json)
  if (job instanceof Error) return job
  const user = edit.user === undefined ? null : userIdOf(edit.user)
  if (user instanceof Error) return user
  if (edit.model && !/^[^/]+\/.+$/.test(edit.model)) return new ConfigError({ reason: 'Use --model provider/model' })
  const when = edit.sendAt === undefined ? null : parseSendAt({ value: edit.sendAt, now: bot.clock.now() })
  if (when instanceof Error) return when
  // Empty strings clear optional values, like V1.
  const prompt = edit.prompt ?? job.send.prompt
  const payload = encodeTaskPayload({
    ...job,
    send: {
      ...job.send,
      prompt,
      ...(edit.agent !== undefined && { agent: edit.agent || undefined }),
      ...(edit.model !== undefined && { model: edit.model || undefined }),
      ...(edit.user !== undefined && { user: user ? [user] : undefined }),
    },
    ...(edit.preRun !== undefined && { preRun: edit.preRun || null }),
    ...(edit.allowConcurrency !== undefined && { allowConcurrency: edit.allowConcurrency }),
    ...(edit.user !== undefined && { username: null }),
  })
  if (payload instanceof Error) return payload
  const schedule = when && {
    schedule_kind: when.kind,
    run_at: when.kind === 'at' ? new Date(when.runAt) : null,
    cron_expr: when.kind === 'cron' ? when.cronExpr : null,
    timezone: when.kind === 'cron' ? 'UTC' : null,
    next_run_at: new Date(when.kind === 'at' ? when.runAt : when.nextRunAt),
  }
  const saved = await bot.db.update(schema.scheduled_tasks)
    .set({ payload_json: payload, prompt_preview: preview(prompt), ...schedule })
    .where(orm.and(orm.eq(schema.scheduled_tasks.id, edit.id), orm.eq(schema.scheduled_tasks.status, 'planned')))
    .returning({ id: schema.scheduled_tasks.id })
    .catch((cause) => new DbError({ operation: 'update task', cause }))
  if (saved instanceof Error) return saved
  if (saved.length === 0) return new ConfigError({ reason: `Task ${edit.id} started running meanwhile; edit it again later` })
  return { taskId: edit.id, updated: Object.entries(edit).filter(([key, value]) => key !== 'id' && value !== undefined).map(([key]) => key) }
}

export async function deleteTask(bot: Bot, id: number) {
  const removed = await bot.db.delete(schema.scheduled_tasks).where(orm.eq(schema.scheduled_tasks.id, id))
    .returning({ id: schema.scheduled_tasks.id })
    .catch((cause) => new DbError({ operation: 'delete task', cause }))
  if (removed instanceof Error) return removed
  if (removed.length === 0) return new ConfigError({ reason: `Task ${id} not found. List tasks with: kimaki task list` })
  return { taskId: id, deleted: true }
}

// The same claim ─▶ execute ─▶ finish path as a due task, now.
export async function runTaskNow(bot: Bot, id: number) {
  const row = await bot.db.query.scheduled_tasks.findFirst({ where: { id } }).catch((cause) => new DbError({ operation: 'read task', cause }))
  if (row instanceof Error) return row
  if (!row) return new ConfigError({ reason: `Task ${id} not found. List tasks with: kimaki task list` })
  const outcome = await runTask(bot, { id, dueAt: null })
  if (outcome instanceof Error) return outcome
  if (outcome.kind === 'busy') return { taskId: id, ran: false, reason: `its last session ${outcome.sessionId} is still running` }
  if (outcome.kind === 'skipped') return { taskId: id, ran: false, reason: outcome.reason }
  return { taskId: id, ran: true, threadId: outcome.threadId, sessionId: outcome.sessionId }
}

// --- /tasks: one ephemeral message with a row and Run now / Delete per task.

async function renderTasks(bot: Bot, { notice, guildId }: { notice: string | null; guildId: string }) {
  const tasks = await listTasks({ db: bot.db, guildId })
  // A Components V2 message cannot switch back to plain content.
  if (tasks instanceof Error) return { flags: MessageFlags.IsComponentsV2 as const, components: [{ type: ComponentType.TextDisplay as const, content: tasks.message }] }
  const shown = tasks.slice(0, MAX_TASK_ROWS)
  const header = [
    notice,
    tasks.length === 0 ? 'No scheduled tasks. Create one with `kimaki send --send-at`.' : `**Scheduled tasks** (${tasks.length})`,
    tasks.length > shown.length ? `Showing ${shown.length} of ${tasks.length}. Use \`kimaki task list\` for all.` : null,
  ].filter((line) => line !== null).join('\n')
  const rows = shown.flatMap((task): APIMessageTopLevelComponent[] => {
    const next = Math.floor(Date.parse(task.nextRunAt) / 1_000)
    const where = task.threadId ? `<#${task.threadId}>` : task.channelId ? `<#${task.channelId}>` : '-'
    const when = task.status === 'failed' ? `failed: ${task.lastError ?? 'unknown error'}` : `next <t:${next}:R>`
    return [
      { type: ComponentType.TextDisplay, content: `**#${task.id}** ${task.schedule} ⋅ ${when} ⋅ ${where}\n${task.prompt}` },
      {
        type: ComponentType.ActionRow,
        components: [
          ...(task.status === 'planned' ? [{ type: ComponentType.Button as const, style: ButtonStyle.Primary as const, label: 'Run now', custom_id: `${TASK_RUN_PREFIX}${task.id}` }] : []),
          { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Delete', custom_id: `${TASK_DELETE_PREFIX}${task.id}` },
        ],
      },
    ]
  })
  return { flags: MessageFlags.IsComponentsV2 as const, components: [{ type: ComponentType.TextDisplay as const, content: header }, ...rows] }
}

async function tasksCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  await interaction.editReply(await renderTasks(bot, { notice: null, guildId: interaction.guildId! }))
}

// Run now / Delete: acts on a task of this guild, then shows the list again with a notice.
function taskButton({ prefix, act }: { prefix: string; act: (bot: Bot, id: number) => Promise<string> }) {
  return async (bot: Bot, interaction: ButtonInteraction) => {
    const id = Number(interaction.customId.slice(prefix.length))
    await interaction.deferUpdate()
    const guildId = interaction.guildId!
    const notice = await (async () => {
      // Buttons only act on tasks of this guild, like the list.
      const visible = await listTasks({ db: bot.db, guildId })
      if (visible instanceof Error) return visible.message
      if (!visible.some((task) => task.id === id)) return `Task #${id} not found in this server`
      return act(bot, id)
    })()
    await interaction.editReply(await renderTasks(bot, { notice, guildId }))
  }
}

export const taskRoutes: InteractionRoutes = {
  commands: {
    tasks: { definition: new SlashCommandBuilder().setName('tasks').setDescription('List scheduled tasks, run one now, or delete it'), run: tasksCommand },
  },
  buttons: {
    [TASK_RUN_PREFIX]: taskButton({
      prefix: TASK_RUN_PREFIX,
      act: async (bot, id) => {
        const result = await runTaskNow(bot, id)
        if (result instanceof Error) return `Could not run task #${id}: ${result.message}`
        if (!result.ran) return `Task #${id} did not run: ${result.reason}`
        return `Started task #${id} in <#${result.threadId}>`
      },
    }),
    [TASK_DELETE_PREFIX]: taskButton({
      prefix: TASK_DELETE_PREFIX,
      act: async (bot, id) => {
        const deleted = await deleteTask(bot, id)
        return deleted instanceof Error ? deleted.message : `Deleted task #${id}`
      },
    }),
  },
}

// --- Production loop: the only part with a lifecycle (a timer).

export function createScheduler({
  bot,
  intervalMs,
}: {
  bot: Bot
  // null: no loop (tests call runDueTasks themselves).
  intervalMs: number | null
}) {
  const loop: { timer: ReturnType<typeof setInterval> | null; tick: Promise<void> | null } = { timer: null, tick: null }

  function tick(): void {
    if (loop.tick) return
    loop.tick = runDueTasks(bot)
      .catch((cause) => logger.error('scheduler tick failed', cause))
      .finally(() => { loop.tick = null })
  }

  return {
    runDueTasks: () => runDueTasks(bot),
    // A loop tick runs tasks or delivers wakes now.
    isBusy: () => loop.tick !== null,
    // A bot that died mid-run left its tasks "running"; this process runs none yet.
    async start(): Promise<DbError | void> {
      const recovered = await bot.db.update(schema.scheduled_tasks).set({ status: 'planned', running_started_at: null })
        .where(running).returning({ id: schema.scheduled_tasks.id })
        .catch((cause) => new DbError({ operation: 'recover running tasks', cause }))
      if (recovered instanceof Error) return recovered
      if (recovered.length > 0) logger.warn(`recovered ${recovered.length} task(s) left running by a previous bot`)
      if (intervalMs === null) return
      loop.timer = setInterval(tick, intervalMs)
      tick()
    },
    async stop(): Promise<void> {
      if (loop.timer) clearInterval(loop.timer)
      loop.timer = null
      await loop.tick
    },
  }
}

export type Scheduler = ReturnType<typeof createScheduler>
