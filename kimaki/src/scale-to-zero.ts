// Kimaki Cloud scale-to-zero (KIMAKI_SCALE_TO_ZERO=1, set by kimaki-cloud/kimaki-init.sh).
// The bot exits after a quiet window, so the Fly machine stops. gateway-proxy
// starts it again through POST <reachable_url>/kimaki/wake (lock-server.ts):
//
//   no busy thread for 10 min ─▶ POST kimaki.dev/api/cloud/next-wake (soonest task/sleep)
//     ─▶ still idle? ─▶ exit 0 ─▶ Fly stops the VM
//   Discord message, or next_wake_at - 30s ─▶ gateway-proxy ─▶ POST /kimaki/wake ─▶ Fly starts the VM
//
// Tasks and sleeps stay in local SQLite; the cloud only stores the soonest wake time.
// The bot stays up when that time cannot be stored, so a stopped VM never misses a task.

import type { Bot } from './bot.ts'
import { gatewayUrlsFromEnv } from './credentials.ts'
import { CloudWakeSyncError, DbError } from './errors.ts'
import { createLogger } from './logger.ts'
import { isBusy, type ThreadView } from './thread-reducer.ts'

const logger = createLogger('CLOUD')

export const DEFAULT_IDLE_MS = 10 * 60_000
const SWEEP_MS = 30_000

export function isScaleToZeroEnabled(): boolean {
  return process.env['KIMAKI_SCALE_TO_ZERO'] === '1'
}

export function idleMsFromEnv(): number {
  const parsed = Number(process.env['KIMAKI_SCALE_TO_ZERO_IDLE_MS'])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_MS
}

// Work that must finish on this VM: a run, queued input, or a background shell.
// A question or permission alone does not keep the VM up: the answer is a Discord message, which wakes it.
export function isThreadActive(view: ThreadView): boolean {
  return isBusy(view) || view.inbox.length > 0 || Object.keys(view.shells).length > 0
}

// A wake due within the idle window keeps the VM up: stopping and starting again costs more.
export function shouldExit({ busy, idleForMs, wakeInMs, idleMs }: { busy: boolean; idleForMs: number; wakeInMs: number | null; idleMs: number }): boolean {
  if (busy) return false
  if (idleForMs < idleMs) return false
  return wakeInMs === null || wakeInMs > idleMs
}

export type ScheduledWork = {
  // A task runs now (its pre-run included), also one started by `kimaki task run` outside the scheduler loop.
  running: boolean
  // Soonest planned task or sleep.
  nextWakeAt: Date | null
}

export async function scheduledWork(bot: Pick<Bot, 'db'>): Promise<DbError | ScheduledWork> {
  const rows = await Promise.all([
    bot.db.query.scheduled_tasks.findFirst({ where: { status: 'running' }, columns: { id: true } }),
    bot.db.query.scheduled_tasks.findFirst({ where: { status: 'planned' }, orderBy: { next_run_at: 'asc' }, columns: { next_run_at: true } }),
    bot.db.query.session_sleeps.findFirst({ where: { status: 'planned' }, orderBy: { wake_at: 'asc' }, columns: { wake_at: true } }),
  ]).catch((cause) => new DbError({ operation: 'read running and planned tasks and sleeps', cause }))
  if (rows instanceof Error) return rows
  const [running, task, sleep] = rows
  const times = [task?.next_run_at, sleep?.wake_at].filter((time): time is Date => time instanceof Date)
  const nextWakeAt = times.reduce<Date | null>((soonest, time) => (soonest && soonest <= time ? soonest : time), null)
  return { running: running !== undefined, nextWakeAt }
}

// Stores next_wake_at on every gateway_clients row of this client. Gateway mode only:
// the website authenticates the clientId:secret token.
export async function syncNextWake({ token, nextWakeAt, website = gatewayUrlsFromEnv().website, fetchImpl = fetch }: {
  token: string
  nextWakeAt: Date | null
  website?: string
  fetchImpl?: typeof fetch
}): Promise<CloudWakeSyncError | void> {
  if (!token.includes(':')) return new CloudWakeSyncError({ reason: 'scale-to-zero needs gateway credentials (clientId:secret)' })
  const response = await fetchImpl(new URL('/api/cloud/next-wake', website), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ next_wake_at: nextWakeAt?.toISOString() ?? null }),
    signal: AbortSignal.timeout(10_000),
  }).catch((cause) => new CloudWakeSyncError({ reason: 'request failed', cause }))
  if (response instanceof Error) return response
  if (!response.ok) return new CloudWakeSyncError({ reason: `HTTP ${response.status}` })
}

// Decide, store the alarm, decide again: work that starts during the sync cancels the exit.
export async function attemptExit({ idleMs, now, busy, idleSince, work, sync, exit }: {
  idleMs: number
  now: () => number
  busy: () => boolean
  idleSince: () => number
  work: () => Promise<Error | ScheduledWork>
  sync: (nextWakeAt: Date | null) => Promise<Error | void>
  exit: () => void
}): Promise<Error | 'exited' | 'stayed'> {
  const decide = async () => {
    const scheduled = await work()
    if (scheduled instanceof Error) return scheduled
    const wake = scheduled.nextWakeAt
    const time = now()
    const exiting = shouldExit({
      busy: busy() || scheduled.running,
      idleForMs: time - idleSince(),
      wakeInMs: wake ? wake.getTime() - time : null,
      idleMs,
    })
    return { exiting, wake }
  }
  const first = await decide()
  if (first instanceof Error) return first
  if (!first.exiting) return 'stayed'
  const synced = await sync(first.wake)
  if (synced instanceof Error) return synced
  const second = await decide()
  if (second instanceof Error) return second
  if (!second.exiting) return 'stayed'
  // A task added between the two reads: store the newer alarm first.
  if (second.wake?.getTime() !== first.wake?.getTime()) return 'stayed'
  logger.log(`idle for ${idleMs / 1000}s, exiting so Fly stops this machine`)
  exit()
  return 'exited'
}

// Returns a stop function. `schedulerBusy`: a scheduler tick (task or wake delivery) is running.
export function startScaleToZero({ bot, schedulerBusy, exit, idleMs = idleMsFromEnv() }: {
  bot: Pick<Bot, 'db' | 'store' | 'clock' | 'token'>
  schedulerBusy: () => boolean
  exit: () => void
  idleMs?: number
}): () => void {
  const activity = { at: bot.clock.now(), sweeping: false }
  // Any thread event counts as activity: the window restarts after the last one.
  const unsubscribe = bot.store.subscribe(() => { activity.at = bot.clock.now() })
  const busy = () => schedulerBusy() || Object.values(bot.store.getState().threads).some(isThreadActive)
  const sweep = async () => {
    if (activity.sweeping) return
    activity.sweeping = true
    if (busy()) activity.at = bot.clock.now()
    const result = await attemptExit({
      idleMs,
      now: () => bot.clock.now(),
      busy,
      idleSince: () => activity.at,
      work: () => scheduledWork(bot),
      sync: (nextWakeAt) => syncNextWake({ token: bot.token, nextWakeAt }),
      exit,
    })
    activity.sweeping = false
    if (result instanceof Error) logger.warn('staying up, idle exit failed', result)
  }
  const timer = setInterval(() => void sweep(), SWEEP_MS)
  logger.log(`scale-to-zero on: exit after ${idleMs / 1000}s idle`)
  return () => {
    clearInterval(timer)
    unsubscribe()
  }
}
