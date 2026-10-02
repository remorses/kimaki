// `kimaki sleep` (spec 10.5): a one-shot wake of a session at a clock time.
//
//   kimaki sleep ─▶ createSleep ─▶ session_sleeps (wake_at = clock + duration)
//   scheduler tick ─▶ runDueWakes ─▶ wake: claim attempt ─▶ prompt (idempotent prompt ID)
//
// Any new input in the thread cancels the sleep (prompt.ts dispatch).

import crypto from 'node:crypto'
import * as orm from 'drizzle-orm'
import dedent from 'string-dedent'

import { fetchThread, threadOfSession, type Bot } from './bot.ts'
import { ConfigError, DbError } from './errors.ts'
import { asSubtext } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { prompt } from './prompt.ts'
import * as schema from './schema.ts'

const logger = createLogger('TASK')

const WAKE_RETRY_MS = 30_000
const WAKE_MAX_ATTEMPTS = 5

type SleepRow = typeof schema.session_sleeps.$inferSelect

const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/

// Also parses `--send-at` dates (scheduler.ts).
export function parseFutureUtc({ value, now, flag }: { value: string; now: number; flag: string }): ConfigError | number {
  if (!UTC_DATE.test(value)) {
    return new ConfigError({ reason: `${flag} date must be UTC ISO format ending with Z (example: 2026-03-01T09:00:00Z). Received: ${value}` })
  }
  const time = Date.parse(value)
  if (Number.isNaN(time)) return new ConfigError({ reason: `Invalid UTC date for ${flag}: ${value}` })
  if (time <= now) return new ConfigError({ reason: `${flag} must be in the future (UTC): ${value}` })
  return time
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

// Writing a sleep, cancelling it on new input and delivering its wake run one
// at a time per session, so a wake never goes out after the input that cancelled it.
function withSleepLock<T>(bot: Bot, { sessionId, run }: { sessionId: string; run: () => Promise<T> }): Promise<T> {
  const locks = bot.local.sleepLocks
  const previous = locks.get(sessionId) ?? Promise.resolve()
  const next = previous.then(run, run)
  const settled = next.then(() => undefined, () => undefined)
  locks.set(sessionId, settled)
  void settled.then(() => {
    if (locks.get(sessionId) === settled) locks.delete(sessionId)
  })
  return next
}

function sleepRow(sessionId: string, deliveryId: string) {
  return orm.and(
    orm.eq(schema.session_sleeps.session_id, sessionId),
    orm.eq(schema.session_sleeps.delivery_id, deliveryId),
    orm.eq(schema.session_sleeps.status, 'planned'),
  )
}

// New input supersedes a pending sleep of the session (prompt.ts dispatch, /abort).
export async function cancelSleep(bot: Bot, sessionId: string): Promise<void> {
  const cancelled = await withSleepLock(bot, {
    sessionId,
    run: () =>
      bot.db.update(schema.session_sleeps).set({ status: 'cancelled' })
        .where(orm.and(orm.eq(schema.session_sleeps.session_id, sessionId), orm.eq(schema.session_sleeps.status, 'planned')))
        .returning({ sessionId: schema.session_sleeps.session_id })
        .catch((cause) => new DbError({ operation: 'cancel sleep', cause })),
  })
  if (cancelled instanceof Error) return logger.warn(cancelled.message)
  if (cancelled.length > 0) logger.log(`sleep of session ${sessionId} cancelled by new input`)
}

// `kimaki sleep`. One planned sleep per session; a new one replaces the old (new delivery ID).
export async function createSleep(
  bot: Bot,
  { sessionId, duration, until, reason }: { sessionId: string; duration?: string; until?: string; reason?: string },
) {
  const state = bot.store.getState()
  const threadId = state.sessionThreads[sessionId]
  const root = threadId ? state.roots[threadId] : undefined
  if (!threadId || !root) {
    return new ConfigError({ reason: `Session ${sessionId} has no Kimaki thread on this machine. Run kimaki sleep inside a Kimaki session.` })
  }
  const time = bot.clock.now()
  const wakeAt = parseWakeAt({ duration, until, now: time })
  if (wakeAt instanceof Error) return wakeAt
  const why = reason?.trim() || null
  const values = {
    wake_at: new Date(wakeAt),
    reason: why,
    status: 'planned' as const,
    delivery_id: crypto.randomUUID(),
    attempts: 0,
    last_attempt_at: null,
    created_at: new Date(time),
  }
  const saved = await withSleepLock(bot, {
    sessionId: root,
    run: () =>
      bot.db.insert(schema.session_sleeps).values({ session_id: root, ...values })
        .onConflictDoUpdate({ target: schema.session_sleeps.session_id, set: values })
        .catch((cause) => new DbError({ operation: 'write session_sleeps', cause })),
  })
  if (saved instanceof Error) return saved
  logger.log(`session ${root} sleeps until ${new Date(wakeAt).toISOString()}`)
  return { sessionId: root, threadId, wakeAt: new Date(wakeAt).toISOString(), output: sleepOutput({ wakeAt, reason: why }) }
}

// Delivers a due wake if it is still the planned sleep and its retry delay
// passed. The prompt ID comes from the delivery ID, so a retried wake cannot
// deliver twice: OpenCode returns the existing inbox item for a repeated ID
// (sleep.e2e.test.ts checks this). No interrupt: a wake joins a running turn
// at its next step.
async function wake(bot: Bot, row: SleepRow): Promise<Error | void> {
  const sessionId = row.session_id
  const deliveryId = row.delivery_id
  const wakeAt = row.wake_at.getTime()
  const reason = row.reason?.trim() || null
  const time = bot.clock.now()
  const echo = asSubtext(`Woke after sleeping until ${utcLabel(wakeAt)}${reason ? `. Reason: ${reason}` : ''}`)
  const text = dedent`
    Woke after sleeping until ${utcLabel(wakeAt)}.${reason ? `\nReason: ${reason}` : ''}
    Continue the work you were waiting for.
  `
  const deliver = async () => {
    const claimed = await bot.db.update(schema.session_sleeps)
      .set({ attempts: orm.sql`${schema.session_sleeps.attempts} + 1`, last_attempt_at: new Date(time) })
      .where(orm.and(
        sleepRow(sessionId, deliveryId),
        orm.or(orm.isNull(schema.session_sleeps.last_attempt_at), orm.lte(schema.session_sleeps.last_attempt_at, new Date(time - WAKE_RETRY_MS))),
      ))
      .returning({ attempts: schema.session_sleeps.attempts })
      .catch((cause) => new DbError({ operation: `claim wake of ${sessionId}`, cause }))
    if (claimed instanceof Error) return claimed
    const attempt = claimed[0]
    if (!attempt) return 'stale' as const
    const settle = async (status: 'consumed' | 'failed') => {
      const settled = await bot.db.update(schema.session_sleeps).set({ status }).where(sleepRow(sessionId, deliveryId))
        .catch((cause) => new DbError({ operation: `settle wake of ${sessionId}`, cause }))
      return settled instanceof Error ? settled : status === 'consumed' ? 'woke' as const : 'failed' as const
    }
    // Resolved now, not at sleep time: /resume may have moved the session.
    const threadId = threadOfSession(bot, sessionId)
    if (!threadId) {
      logger.warn(`no thread owns session ${sessionId}, dropping its wake`)
      return settle('failed')
    }
    const sent = await (async () => {
      const thread = await fetchThread(bot, threadId)
      if (thread instanceof Error) return thread
      return prompt(bot, {
        sessionId,
        threadId,
        threadName: thread.name,
        text,
        echo,
        delivery: 'steer',
        author: { id: bot.discord.user!.id, username: 'kimaki' },
        messageId: deliveryId,
        id: `msg_sleep_${deliveryId}`,
      })
    })()
    if (!(sent instanceof Error)) return settle('consumed')
    logger.warn(`wake of ${sessionId} failed (attempt ${attempt.attempts}): ${sent.message}`)
    if (attempt.attempts >= WAKE_MAX_ATTEMPTS) return settle('failed')
    return 'retry' as const
  }
  const result = await withSleepLock(bot, { sessionId, run: deliver })
  if (result instanceof Error) return result
  if (result === 'woke') logger.log(`woke session ${sessionId}`)
}

// Due wakes, oldest first, one at a time. A failed attempt waits
// WAKE_RETRY_MS; the claim in wake() checks it again.
export async function runDueWakes(bot: Bot, { time, limit }: { time: number; limit: number }): Promise<void> {
  const sleeps = await bot.db.query.session_sleeps
    .findMany({
      where: {
        status: 'planned',
        wake_at: { lte: new Date(time) },
        OR: [{ last_attempt_at: { isNull: true } }, { last_attempt_at: { lte: new Date(time - WAKE_RETRY_MS) } }],
      },
      orderBy: { wake_at: 'asc' },
      limit,
    })
    .catch((cause) => new DbError({ operation: 'read due sleeps', cause }))
  if (sleeps instanceof Error) return logger.error(sleeps.message)
  for (const row of sleeps) {
    const woke = await wake(bot, row)
    if (woke instanceof Error) logger.warn(woke.message)
  }
}
