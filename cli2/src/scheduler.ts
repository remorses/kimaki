// Scheduled tasks and sleep wakes (spec 10.5, 26 #5, 30 Phase 8). Time is an
// input: `Clock.now()` is the only source of "now", so tests drive the
// scheduler with a manual clock and no timers.
//
//   kimaki send --send-at ─▶ createTask ─▶ scheduled_tasks (V1 table and payload)
//   kimaki sleep          ─▶ createSleep ─▶ session_sleeps (wake_at = clock + duration)
//
//   startScheduler (every 5s, production only)
//     └─▶ runDueTasks ─▶ dueTasks (pure) ─▶ task: claim ─▶ pre-run ─▶ busy check ─▶ actions.send
//                                         └▶ wake: claim attempt ─▶ actions.wake (idempotent prompt ID)
//
// A sleep is a one-shot wake of a session. Any new input in its thread
// cancels it (actions.dispatch). Task runs are in-process calls of the same
// `send` action as `kimaki send`; the task ID goes in session metadata.

import { exec } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { CronExpressionParser } from 'cron-parser'
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js'
import * as errore from 'errore'
import * as orm from 'drizzle-orm'
import dedent from 'string-dedent'

import type { Actions, SendInput } from './actions.ts'
import type { KimakiDb } from './db.ts'
import { ConfigError, DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError } from './errors.ts'
import { asSubtext } from './format-parts.ts'
import { createLogger } from './logger.ts'
import type { OpencodeConnection } from './opencode-server.ts'
import * as schema from './schema.ts'
import type { BotStore } from './store.ts'

const logger = createLogger('TASK')
const execAsync = promisify(exec)

export type Clock = { now(): number }

export const systemClock: Clock = { now: () => Date.now() }

const WAKE_RETRY_MS = 30_000
const WAKE_MAX_ATTEMPTS = 5
const DUE_BATCH = 20
// A hung pre-run command must not block every later task and wake.
const PRE_RUN_TIMEOUT_MS = 10 * 60_000
// /tasks rows: text + action row + 2 buttons each, under the 40-component limit.
const MAX_TASK_ROWS = 7

export const TASK_RUN_PREFIX = 'task_run:'
export const TASK_DELETE_PREFIX = 'task_delete:'

type TaskRow = typeof schema.scheduled_tasks.$inferSelect
type SleepRow = typeof schema.session_sleeps.$inferSelect

export type Task =
  | {
      kind: 'task'
      id: number
      status: TaskRow['status']
      schedule: TaskRow['schedule_kind']
      dueAt: number
      cronExpr: string | null
      timezone: string | null
    }
  | { kind: 'wake'; sessionId: string; status: SleepRow['status']; dueAt: number; lastAttemptAt: number | null }

// --- Pure time logic.

export function nextCronRun({ cronExpr, timezone, from }: { cronExpr: string; timezone: string; from: number }): ConfigError | number {
  return errore.try(
    () => CronExpressionParser.parse(cronExpr, { currentDate: new Date(from), tz: timezone }).next().getTime(),
    (cause) => new ConfigError({ reason: `Invalid cron expression: ${cronExpr}`, cause }),
  )
}

// Which tasks and wakes are due at `now`, oldest first, with the next run of
// cron tasks. Missed cron occurrences fire once: the next run counts from `now`.
export function dueTasks({ tasks, now }: { tasks: readonly Task[]; now: number }): Array<{ task: Task; nextRunAt: ConfigError | number | null }> {
  return tasks
    .filter((task) => task.status === 'planned' && task.dueAt <= now)
    .filter((task) => task.kind === 'task' || task.lastAttemptAt === null || now - task.lastAttemptAt >= WAKE_RETRY_MS)
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((task) => ({ task, nextRunAt: nextRunOf({ task, now }) }))
}

// The run after one that happens at `now`: null for one-shots and wakes.
export function nextRunOf({ task, now }: { task: Task; now: number }): ConfigError | number | null {
  if (task.kind === 'wake' || task.schedule === 'at') return null
  if (!task.cronExpr) return new ConfigError({ reason: `Task ${task.id} has no cron expression` })
  // V1 rows may carry a timezone; new tasks are UTC.
  return nextCronRun({ cronExpr: task.cronExpr, timezone: task.timezone || 'UTC', from: now })
}

function taskOf(row: typeof schema.scheduled_tasks.$inferSelect): Task {
  return { kind: 'task', id: row.id, status: row.status, schedule: row.schedule_kind, dueAt: row.next_run_at.getTime(), cronExpr: row.cron_expr, timezone: row.timezone }
}

const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/

function parseFutureUtc({ value, now, flag }: { value: string; now: number; flag: string }): ConfigError | number {
  if (!UTC_DATE.test(value)) {
    return new ConfigError({ reason: `${flag} date must be UTC ISO format ending with Z (example: 2026-03-01T09:00:00Z). Received: ${value}` })
  }
  const time = Date.parse(value)
  if (Number.isNaN(time)) return new ConfigError({ reason: `Invalid UTC date for ${flag}: ${value}` })
  if (time <= now) return new ConfigError({ reason: `${flag} must be in the future (UTC): ${value}` })
  return time
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

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i
const DURATION_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

// `kimaki sleep`: the bot resolves the wake time with its own clock.
export function parseWakeAt({ duration, until, now }: { duration?: string; until?: string; now: number }): ConfigError | number {
  const relative = duration?.trim() ?? ''
  const absolute = until?.trim() ?? ''
  if (relative && absolute) return new ConfigError({ reason: 'Pass either --duration or --until, not both' })
  if (absolute) return parseFutureUtc({ value: absolute, now, flag: '--until' })
  if (!relative) return new ConfigError({ reason: 'Pass --duration or --until' })
  const match = DURATION.exec(relative)
  if (!match) return new ConfigError({ reason: `Invalid --duration "${relative}". Use a number plus ms, s, m, h, or d (example: 2h)` })
  const amount = Number(match[1]) * DURATION_MS[match[2]!.toLowerCase()]!
  if (!(amount > 0)) return new ConfigError({ reason: '--duration must be greater than 0' })
  return now + amount
}

function utcLabel(time: number): string {
  return `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

// What the agent reads after `kimaki sleep` (the V1 kimaki_sleep tool result).
export function sleepOutput({ wakeAt, reason }: { wakeAt: number; reason: string | null }): string {
  return [
    `Sleeping until ${utcLabel(wakeAt)}.${reason ? ` Reason: ${reason}.` : ''}`,
    'This result is not a wake. Do not continue the waited work. Do not run more commands.',
    'Reply with one short line that you are waiting until that time, then stop.',
    'The real wake is a later message that starts with "Woke after sleeping until". Only then continue the wait reason.',
    'A new user message in this thread cancels the sleep. If you still need that later wake after answering, run kimaki sleep again with --until set to the same UTC time.',
  ].join(' ')
}

// --- V1 task payload (spec 17: same shape; injectionGuardPatterns is ignored).

type PayloadBase = {
  prompt: string
  agent: string | null
  model: string | null
  username: string | null
  userId: string | null
  permissions: string[] | null
  injectionGuardPatterns: string[] | null
  parentSessionId: string | null
  preRunCommand: string | null
  allowConcurrency: boolean
}

export type TaskPayload =
  | (PayloadBase & { kind: 'thread'; threadId: string })
  | (PayloadBase & { kind: 'channel'; channelId: string; name: string | null; notifyOnly: boolean; worktreeName: string | null; cwd: string | null })

export function parsePayload(json: string): ConfigError | TaskPayload {
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
  const base: PayloadBase = {
    prompt,
    agent: text('agent'),
    model: text('model'),
    username: text('username'),
    userId: text('userId'),
    permissions: list('permissions'),
    injectionGuardPatterns: list('injectionGuardPatterns'),
    parentSessionId: text('parentSessionId'),
    preRunCommand: text('preRunCommand'),
    allowConcurrency: fields.get('allowConcurrency') === true,
  }
  const kind = text('kind')
  const threadId = text('threadId')
  const channelId = text('channelId')
  if (kind === 'thread' && threadId) return { ...base, kind, threadId }
  if (kind === 'channel' && channelId) {
    return { ...base, kind, channelId, name: text('name'), notifyOnly: fields.get('notifyOnly') === true, worktreeName: text('worktreeName'), cwd: text('cwd') }
  }
  return new ConfigError({ reason: `Task payload has unknown kind ${kind ?? '(none)'} or no target` })
}

function preview(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}...`
}

export type ScheduleOptions = { sendAt: string; preRun: string | null; allowConcurrency: boolean }

// The scheduling fields of a `/kimaki/send` body; null when it is a plain send.
export function parseScheduleOptions(value: unknown): ConfigError | ScheduleOptions | null {
  if (!value || typeof value !== 'object') return null
  const fields = new Map(Object.entries(value))
  const sendAt = fields.get('sendAt')
  const preRun = fields.get('preRun')
  const allowConcurrency = fields.get('allowConcurrency')
  if (sendAt === undefined) {
    if (preRun !== undefined || allowConcurrency !== undefined) return new ConfigError({ reason: '--pre-run and --allow-concurrency need --send-at' })
    return null
  }
  if (typeof sendAt !== 'string') return new ConfigError({ reason: '--send-at must be a string' })
  if (preRun !== undefined && (typeof preRun !== 'string' || !preRun.trim())) return new ConfigError({ reason: '--pre-run must be a command' })
  if (allowConcurrency !== undefined && typeof allowConcurrency !== 'boolean') return new ConfigError({ reason: '--allow-concurrency must be boolean' })
  return { sendAt, preRun: typeof preRun === 'string' ? preRun.trim() : null, allowConcurrency: allowConcurrency === true }
}

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

export function parseTaskEdit(value: unknown): ConfigError | TaskEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new ConfigError({ reason: 'Expected a task edit object' })
  const fields = new Map(Object.entries(value))
  const id = fields.get('id')
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return new ConfigError({ reason: 'Task ID must be a positive integer' })
  const edit: TaskEdit = { id }
  for (const key of ['prompt', 'sendAt', 'agent', 'model', 'preRun', 'user'] as const) {
    const field = fields.get(key)
    if (field === undefined) continue
    if (typeof field !== 'string') return new ConfigError({ reason: `${key} must be a string` })
    edit[key] = field.trim()
  }
  const concurrency = fields.get('allowConcurrency')
  if (concurrency !== undefined && typeof concurrency !== 'boolean') return new ConfigError({ reason: 'allowConcurrency must be boolean' })
  if (typeof concurrency === 'boolean') edit.allowConcurrency = concurrency
  if (Object.keys(edit).length === 1) return new ConfigError({ reason: 'Pass at least one of --prompt, --send-at, --agent, --model, --pre-run, --allow-concurrency, --user' })
  if (edit.prompt === '') return new ConfigError({ reason: '--prompt cannot be empty' })
  return edit
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
    const payload = parsePayload(row.payload_json)
    const known = payload instanceof Error ? null : payload
    return {
      id: row.id,
      status: row.status,
      schedule: row.schedule_kind === 'cron' ? `cron ${row.cron_expr ?? '?'}${row.timezone && row.timezone !== 'UTC' ? ` (${row.timezone})` : ''}` : 'once',
      nextRunAt: row.next_run_at.toISOString(),
      prompt: row.prompt_preview,
      channelId: row.channel_id,
      threadId: known?.kind === 'thread' ? known.threadId : null,
      agent: known?.agent ?? null,
      model: known?.model ?? null,
      userId: known?.userId ?? null,
      preRun: known?.preRunCommand ?? null,
      allowConcurrency: known?.allowConcurrency ?? false,
      lastError: row.last_error,
    }
  })
}

type RunOutcome =
  | { kind: 'ran'; threadId: string; sessionId: string | null }
  | { kind: 'busy'; sessionId: string }
  | { kind: 'skipped'; reason: string }

export function createScheduler({
  clock,
  discord,
  db,
  actions,
  store,
  opencode,
  intervalMs,
}: {
  clock: Clock
  discord: Client
  db: KimakiDb
  actions: Actions
  store: BotStore
  opencode: OpencodeConnection
  // null: no loop (tests call runDueTasks themselves).
  intervalMs: number | null
}) {
  const now = () => clock.now()

  async function isBusy(sessionId: string): Promise<OpenCodeUnavailableError | OpenCodeError | boolean> {
    const client = opencode.endpoint?.client
    if (!client) return new OpenCodeUnavailableError({ reason: 'not connected' })
    const active = await client.session.active().catch((cause) => new OpenCodeError({ operation: 'session.active', cause }))
    if (active instanceof Error) return active
    return sessionId in active
  }

  // Exit 0 runs the task with stdout appended; any other exit skips this occurrence.
  async function preRun({ row, payload }: { row: TaskRow; payload: TaskPayload }): Promise<ConfigError | { prompt: string } | { skip: string }> {
    const command = payload.preRunCommand
    if (!command) return { prompt: payload.prompt }
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
    return { prompt: output ? `${payload.prompt}\n\n## Pre-run command output\n\n${output}` : payload.prompt }
  }

  async function execute(row: TaskRow): Promise<Error | RunOutcome> {
    const payload = parsePayload(row.payload_json)
    if (payload instanceof Error) return payload
    if (payload.kind === 'channel' && payload.worktreeName) return new ConfigError({ reason: `Task ${row.id} wants worktree ${payload.worktreeName}; worktree tasks arrive in P10` })
    // Non-overlap: the session of the previous run must be idle.
    if (!payload.allowConcurrency && row.session_id) {
      const busy = await isBusy(row.session_id)
      if (busy instanceof Error) return busy
      if (busy) return { kind: 'busy', sessionId: row.session_id }
    }
    const checked = await preRun({ row, payload })
    if (checked instanceof Error) return checked
    if ('skip' in checked) return { kind: 'skipped', reason: checked.skip }
    // Deleted or edited during the pre-run: this occurrence no longer exists.
    const current = await db.query.scheduled_tasks.findFirst({ where: { id: row.id }, columns: { status: true } })
      .catch((cause) => new DbError({ operation: `recheck task ${row.id}`, cause }))
    if (current instanceof Error) return current
    if (current?.status !== 'running') return { kind: 'skipped', reason: 'deleted while its pre-run ran' }
    const common = {
      prompt: checked.prompt,
      ...(payload.agent && { agent: payload.agent }),
      ...(payload.model && { model: payload.model }),
      ...(payload.userId && { user: payload.userId }),
    }
    // V1 accepted permissions for thread tasks; an existing session keeps its own.
    if (payload.kind === 'thread' && payload.permissions?.length) logger.warn(`task ${row.id}: permissions apply only to new sessions, ignoring them`)
    const input: SendInput = payload.kind === 'thread'
      ? { ...common, threadId: payload.threadId }
      : {
          ...common,
          channelId: payload.channelId,
          ...(payload.name && { name: payload.name }),
          ...(payload.cwd && { cwd: payload.cwd }),
          ...(payload.parentSessionId && { parentSessionId: payload.parentSessionId }),
          ...(payload.permissions?.length && { permissions: payload.permissions }),
          ...(payload.notifyOnly && { notifyOnly: true }),
        }
    const task = { id: row.id, cronExpr: row.schedule_kind === 'cron' ? row.cron_expr : null, timezone: row.timezone }
    const sent = await actions.send(input, { localOnly: true, task })
    if (sent instanceof Error) return sent
    return { kind: 'ran', threadId: sent.threadId, sessionId: sent.sessionId }
  }

  const running = orm.eq(schema.scheduled_tasks.status, 'running')

  async function finish({ row, nextRunAt, outcome }: { row: TaskRow; nextRunAt: ConfigError | number | null; outcome: Error | RunOutcome }): Promise<DbError | void> {
    const at = new Date(now())
    const where = orm.and(orm.eq(schema.scheduled_tasks.id, row.id), running)
    const update = (set: Partial<typeof schema.scheduled_tasks.$inferInsert>) =>
      db.update(schema.scheduled_tasks).set({ running_started_at: null, ...set }).where(where).then(() => undefined)
        .catch((cause) => new DbError({ operation: `finish task ${row.id}`, cause }))
    const next = nextRunAt instanceof Error || nextRunAt === null ? null : new Date(nextRunAt)
    if (outcome instanceof Error) {
      logger.warn(`task ${row.id} failed: ${outcome.message}`)
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
      const removed = await db.delete(schema.scheduled_tasks).where(where)
        .catch((cause) => new DbError({ operation: `delete task ${row.id}`, cause }))
      if (removed instanceof Error) return removed
      return
    }
    if (!next) return update({ status: 'failed', last_run_at: at, last_error: nextRunAt instanceof Error ? nextRunAt.message : 'No next run' })
    return update({ status: 'planned', next_run_at: next, last_run_at: at, last_error: null, ...ran })
  }

  // claim ─▶ execute ─▶ finish. The claim returns the current row, so a task
  // edited or run by another caller after the due list was read runs as it is
  // now, once. `dueAt`: only claim the occurrence the due list saw.
  async function runTask({ id, dueAt }: { id: number; dueAt: Date | null }): Promise<Error | RunOutcome> {
    const time = now()
    const claimed = await db.update(schema.scheduled_tasks)
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
    const outcome = await execute(row)
    const finished = await finish({ row, nextRunAt: nextRunOf({ task: taskOf(row), now: time }), outcome })
    if (finished instanceof Error) return finished
    return outcome
  }

  async function wake(row: SleepRow): Promise<Error | void> {
    const wakeAt = row.wake_at.getTime()
    const reason = row.reason?.trim() || null
    const time = now()
    const result = await actions.wake({
      sessionId: row.session_id,
      deliveryId: row.delivery_id,
      now: time,
      retryBefore: time - WAKE_RETRY_MS,
      maxAttempts: WAKE_MAX_ATTEMPTS,
      echo: asSubtext(`Woke after sleeping until ${utcLabel(wakeAt)}${reason ? `. Reason: ${reason}` : ''}`),
      text: dedent`
        Woke after sleeping until ${utcLabel(wakeAt)}.${reason ? `\nReason: ${reason}` : ''}
        Continue the work you were waiting for.
      `,
    })
    if (result instanceof Error) return result
    if (result === 'woke') logger.log(`woke session ${row.session_id}`)
  }

  async function runDueTasks(): Promise<void> {
    const time = now()
    const [tasks, sleeps] = await Promise.all([
      db.query.scheduled_tasks
        .findMany({ where: { status: 'planned', next_run_at: { lte: new Date(time) } }, orderBy: { next_run_at: 'asc', id: 'asc' }, limit: DUE_BATCH })
        .catch((cause) => new DbError({ operation: 'read due tasks', cause })),
      db.query.session_sleeps
        .findMany({ where: { status: 'planned', wake_at: { lte: new Date(time) } }, orderBy: { wake_at: 'asc' }, limit: DUE_BATCH })
        .catch((cause) => new DbError({ operation: 'read due sleeps', cause })),
    ])
    if (tasks instanceof Error) return logger.error(tasks.message)
    if (sleeps instanceof Error) return logger.error(sleeps.message)
    const sleepRows = new Map(sleeps.map((row) => [row.session_id, row]))
    const due = dueTasks({
      now: time,
      tasks: [
        ...tasks.map(taskOf),
        ...sleeps.map((row): Task => ({ kind: 'wake', sessionId: row.session_id, status: row.status, dueAt: row.wake_at.getTime(), lastAttemptAt: row.last_attempt_at?.getTime() ?? null })),
      ],
    })
    // Wakes first: they are quick, while a task can wait for its pre-run.
    // One at a time: runs share the OpenCode service and Discord rate limits.
    const ordered = [...due.filter((item) => item.task.kind === 'wake'), ...due.filter((item) => item.task.kind === 'task')]
    for (const { task } of ordered) {
      const result = task.kind === 'task'
        ? await runTask({ id: task.id, dueAt: new Date(task.dueAt) })
        : await wake(sleepRows.get(task.sessionId)!)
      if (result instanceof Error) logger.warn(result.message)
    }
  }

  // --- Writers behind the lock server and /tasks.

  async function createTask({ send, options }: { send: SendInput; options: ScheduleOptions }) {
    const when = parseSendAt({ value: options.sendAt, now: now() })
    if (when instanceof Error) return when
    if (send.files?.length) return new ConfigError({ reason: '--file cannot be scheduled. Put the file in the project and name it in the prompt.' })
    const user = userIdOf(send.user ?? '')
    if (user instanceof Error) return user
    if (send.model && !/^[^/]+\/.+$/.test(send.model)) return new ConfigError({ reason: 'Use --model provider/model' })
    const roots = store.getState().roots
    const threadId = send.threadId ?? (send.sessionId ? Object.entries(roots).find(([, id]) => id === send.sessionId)?.[0] : undefined)
    if ((send.threadId || send.sessionId) && (!threadId || !roots[threadId])) {
      return new ConfigError({ reason: 'Schedule thread tasks on the machine that owns the thread (no local session for it)' })
    }
    if (threadId && send.notifyOnly) return new ConfigError({ reason: '--notify-only needs --channel or --project, not a thread' })
    if (threadId && send.permissions?.length) return new ConfigError({ reason: '--permission applies only to new sessions, not a thread' })
    const project = await (async () => {
      if (threadId) {
        const thread = await discord.channels.fetch(threadId).catch((cause) => new DiscordError({ operation: `fetch thread ${threadId}`, cause }))
        if (thread instanceof Error) return thread
        if (!thread?.isThread() || !thread.parentId) return null
        return db.query.channel_directories.findFirst({ where: { channel_id: thread.parentId } })
      }
      return db.query.channel_directories.findFirst({ where: send.channelId ? { channel_id: send.channelId } : { directory: path.resolve(send.project!) } })
    })().catch((cause) => new DbError({ operation: 'resolve task project', cause }))
    if (project instanceof Error) return project
    if (!project) return new ConfigError({ reason: 'Schedule tasks on the machine that owns the channel (no local project for it)' })
    const base: PayloadBase = {
      prompt: send.prompt,
      agent: send.agent ?? null,
      model: send.model ?? null,
      username: null,
      userId: user,
      permissions: send.permissions ?? null,
      injectionGuardPatterns: null,
      parentSessionId: send.parentSessionId ?? null,
      preRunCommand: options.preRun,
      allowConcurrency: options.allowConcurrency,
    }
    const payload: TaskPayload = threadId
      ? { ...base, kind: 'thread', threadId }
      : { ...base, kind: 'channel', channelId: project.channel_id, name: send.name ?? null, notifyOnly: send.notifyOnly === true, worktreeName: null, cwd: send.cwd ?? null }
    const nextRunAt = when.kind === 'at' ? when.runAt : when.nextRunAt
    const inserted = await db.insert(schema.scheduled_tasks).values({
      status: 'planned',
      schedule_kind: when.kind,
      run_at: when.kind === 'at' ? new Date(when.runAt) : null,
      cron_expr: when.kind === 'cron' ? when.cronExpr : null,
      timezone: when.kind === 'cron' ? 'UTC' : null,
      next_run_at: new Date(nextRunAt),
      payload_json: JSON.stringify(payload),
      prompt_preview: preview(send.prompt),
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

  async function editTask(edit: TaskEdit) {
    const row = await db.query.scheduled_tasks.findFirst({ where: { id: edit.id } }).catch((cause) => new DbError({ operation: 'read task', cause }))
    if (row instanceof Error) return row
    if (!row) return new ConfigError({ reason: `Task ${edit.id} not found. List tasks with: kimaki task list` })
    if (row.status !== 'planned') return new ConfigError({ reason: `Task ${edit.id} is ${row.status}; only planned tasks can be edited` })
    const payload = parsePayload(row.payload_json)
    if (payload instanceof Error) return payload
    const user = edit.user === undefined ? payload.userId : userIdOf(edit.user)
    if (user instanceof Error) return user
    if (edit.model && !/^[^/]+\/.+$/.test(edit.model)) return new ConfigError({ reason: 'Use --model provider/model' })
    const when = edit.sendAt === undefined ? null : parseSendAt({ value: edit.sendAt, now: now() })
    if (when instanceof Error) return when
    // Empty strings clear optional values, like V1.
    const updated: TaskPayload = {
      ...payload,
      ...(edit.prompt !== undefined && { prompt: edit.prompt }),
      ...(edit.agent !== undefined && { agent: edit.agent || null }),
      ...(edit.model !== undefined && { model: edit.model || null }),
      ...(edit.preRun !== undefined && { preRunCommand: edit.preRun || null }),
      ...(edit.allowConcurrency !== undefined && { allowConcurrency: edit.allowConcurrency }),
      ...(edit.user !== undefined && { userId: user, username: null }),
    }
    const schedule = when && {
      schedule_kind: when.kind,
      run_at: when.kind === 'at' ? new Date(when.runAt) : null,
      cron_expr: when.kind === 'cron' ? when.cronExpr : null,
      timezone: when.kind === 'cron' ? 'UTC' : null,
      next_run_at: new Date(when.kind === 'at' ? when.runAt : when.nextRunAt),
    }
    const saved = await db.update(schema.scheduled_tasks)
      .set({ payload_json: JSON.stringify(updated), prompt_preview: preview(updated.prompt), ...schedule })
      .where(orm.and(orm.eq(schema.scheduled_tasks.id, edit.id), orm.eq(schema.scheduled_tasks.status, 'planned')))
      .returning({ id: schema.scheduled_tasks.id })
      .catch((cause) => new DbError({ operation: 'update task', cause }))
    if (saved instanceof Error) return saved
    if (saved.length === 0) return new ConfigError({ reason: `Task ${edit.id} started running meanwhile; edit it again later` })
    return { taskId: edit.id, updated: Object.keys(edit).filter((key) => key !== 'id') }
  }

  async function deleteTask(id: number) {
    const removed = await db.delete(schema.scheduled_tasks).where(orm.eq(schema.scheduled_tasks.id, id))
      .returning({ id: schema.scheduled_tasks.id })
      .catch((cause) => new DbError({ operation: 'delete task', cause }))
    if (removed instanceof Error) return removed
    if (removed.length === 0) return new ConfigError({ reason: `Task ${id} not found. List tasks with: kimaki task list` })
    return { taskId: id, deleted: true }
  }

  // The same claim ─▶ execute ─▶ finish path as a due task, now.
  async function runTaskNow(id: number) {
    const row = await db.query.scheduled_tasks.findFirst({ where: { id } }).catch((cause) => new DbError({ operation: 'read task', cause }))
    if (row instanceof Error) return row
    if (!row) return new ConfigError({ reason: `Task ${id} not found. List tasks with: kimaki task list` })
    const outcome = await runTask({ id, dueAt: null })
    if (outcome instanceof Error) return outcome
    if (outcome.kind === 'busy') return { taskId: id, ran: false, reason: `its last session ${outcome.sessionId} is still running` }
    if (outcome.kind === 'skipped') return { taskId: id, ran: false, reason: outcome.reason }
    return { taskId: id, ran: true, threadId: outcome.threadId, sessionId: outcome.sessionId }
  }

  async function createSleep({ sessionId, duration, until, reason }: { sessionId: string; duration?: string; until?: string; reason?: string }) {
    const state = store.getState()
    const threadId = state.sessionThreads[sessionId]
    const root = threadId ? state.roots[threadId] : undefined
    if (!threadId || !root) return new ConfigError({ reason: `Session ${sessionId} has no Kimaki thread on this machine. Run kimaki sleep inside a Kimaki session.` })
    const time = now()
    const wakeAt = parseWakeAt({ duration, until, now: time })
    if (wakeAt instanceof Error) return wakeAt
    const why = reason?.trim() || null
    const saved = await actions.planSleep({ sessionId: root, wakeAt, reason: why, now: time })
    if (saved instanceof Error) return saved
    logger.log(`session ${root} sleeps until ${new Date(wakeAt).toISOString()}`)
    return { sessionId: root, threadId, wakeAt: new Date(wakeAt).toISOString(), output: sleepOutput({ wakeAt, reason: why }) }
  }

  // --- /tasks: one ephemeral message with a row and Run now / Delete per task.

  async function renderTasks({ notice, guildId }: { notice: string | null; guildId: string }) {
    const tasks = await listTasks({ db, guildId })
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

  async function tasksCommand(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    await interaction.editReply(await renderTasks({ notice: null, guildId: interaction.guildId! }))
  }

  async function tasksClick(interaction: ButtonInteraction) {
    const run = interaction.customId.startsWith(TASK_RUN_PREFIX)
    const id = Number(interaction.customId.slice((run ? TASK_RUN_PREFIX : TASK_DELETE_PREFIX).length))
    await interaction.deferUpdate()
    const guildId = interaction.guildId!
    const notice = await (async () => {
      // Buttons only act on tasks of this guild, like the list.
      const visible = await listTasks({ db, guildId })
      if (visible instanceof Error) return visible.message
      if (!visible.some((task) => task.id === id)) return `Task #${id} not found in this server`
      if (!run) {
        const deleted = await deleteTask(id)
        return deleted instanceof Error ? deleted.message : `Deleted task #${id}`
      }
      const result = await runTaskNow(id)
      if (result instanceof Error) return `Could not run task #${id}: ${result.message}`
      if (!result.ran) return `Task #${id} did not run: ${result.reason}`
      return `Started task #${id} in <#${result.threadId}>`
    })()
    await interaction.editReply(await renderTasks({ notice, guildId }))
  }

  // --- Production loop.

  const loop: { timer: ReturnType<typeof setInterval> | null; tick: Promise<void> | null } = { timer: null, tick: null }

  function tick(): void {
    if (loop.tick) return
    loop.tick = runDueTasks()
      .catch((cause) => logger.error(`scheduler tick failed: ${String(cause)}`))
      .finally(() => { loop.tick = null })
  }

  // A bot that died mid-run left its tasks "running"; this process runs none yet.
  async function start(): Promise<DbError | void> {
    const recovered = await db.update(schema.scheduled_tasks).set({ status: 'planned', running_started_at: null })
      .where(running).returning({ id: schema.scheduled_tasks.id })
      .catch((cause) => new DbError({ operation: 'recover running tasks', cause }))
    if (recovered instanceof Error) return recovered
    if (recovered.length > 0) logger.warn(`recovered ${recovered.length} task(s) left running by a previous bot`)
    if (intervalMs === null) return
    loop.timer = setInterval(tick, intervalMs)
    tick()
  }

  return {
    start,
    runDueTasks,
    createTask,
    editTask,
    deleteTask,
    runTaskNow,
    createSleep,
    tasksCommand,
    tasksClick,
    async stop(): Promise<void> {
      if (loop.timer) clearInterval(loop.timer)
      loop.timer = null
      await loop.tick
    },
  }
}

export type Scheduler = ReturnType<typeof createScheduler>
