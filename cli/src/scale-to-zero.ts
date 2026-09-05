// Cloud scale-to-zero idle exit.
// When KIMAKI_SCALE_TO_ZERO=1, the bot process exits after a quiet window so
// Fly can stop the machine. User messages and due tasks wake it via
// POST /kimaki/wake. Local bots stay always-on unless the env is set.

import { createLogger, LogPrefix } from './logger.js'
import { flushAnalytics } from './analytics.js'
import { getSoonestPlannedWakeAt } from './database.js'
import { areAllRuntimesIdleForScaleToZero } from './session-handler/thread-session-runtime.js'

// Exit 0 so Fly's default on-failure policy does not bounce the machine.
// bin.ts --auto-restart also skips restart on 0.

const logger = createLogger(LogPrefix.CLOUD)

export const DEFAULT_SCALE_TO_ZERO_IDLE_MS = 10 * 60 * 1000
export const DEFAULT_SCALE_TO_ZERO_SWEEP_MS = 30_000

export function isScaleToZeroEnabled(): boolean {
  return process.env['KIMAKI_SCALE_TO_ZERO'] === '1'
}

export function parseScaleToZeroIdleMs(): number {
  const raw = process.env['KIMAKI_SCALE_TO_ZERO_IDLE_MS']
  if (!raw) {
    return DEFAULT_SCALE_TO_ZERO_IDLE_MS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SCALE_TO_ZERO_IDLE_MS
  }
  return parsed
}

export function shouldExitScaleToZero({
  enabled,
  hasBusyRuntime,
  hasBusyTaskRunner,
  lastActivityMs,
  soonestWakeAtMs,
  nowMs,
  idleMs,
}: {
  enabled: boolean
  hasBusyRuntime: boolean
  hasBusyTaskRunner: boolean
  lastActivityMs: number
  soonestWakeAtMs: number | null
  nowMs: number
  idleMs: number
}): boolean {
  if (!enabled) {
    return false
  }
  if (hasBusyRuntime) {
    return false
  }
  if (hasBusyTaskRunner) {
    return false
  }
  if (nowMs - lastActivityMs < idleMs) {
    return false
  }
  if (soonestWakeAtMs !== null && soonestWakeAtMs - nowMs <= idleMs) {
    return false
  }
  return true
}

export async function attemptScaleToZeroExit({
  idleMs,
  startedAtMs,
  getIdleState,
  getSoonestWakeAt,
  isTaskRunnerBusy,
  syncWakeAt,
  exitProcess,
  now = Date.now,
}: {
  idleMs: number
  startedAtMs: number
  getIdleState: (nowMs: number) => { allIdle: boolean; lastActivityMs: number | null }
  getSoonestWakeAt: () => Promise<Date | Error | null>
  isTaskRunnerBusy: () => boolean
  syncWakeAt: (nextWakeAt: Date | null) => Promise<Error | void>
  exitProcess: () => Promise<void>
  now?: () => number
}): Promise<'exited' | 'stayed'> {
  const decide = async (atMs: number) => {
    const idleState = getIdleState(atMs)
    const soonestWakeAt = await getSoonestWakeAt()
    if (soonestWakeAt instanceof Error) {
      return soonestWakeAt
    }
    const shouldExit = shouldExitScaleToZero({
      enabled: true,
      hasBusyRuntime: !idleState.allIdle,
      hasBusyTaskRunner: isTaskRunnerBusy(),
      lastActivityMs: idleState.lastActivityMs ?? startedAtMs,
      soonestWakeAtMs: soonestWakeAt?.getTime() ?? null,
      nowMs: atMs,
      idleMs,
    })
    return { shouldExit, soonestWakeAt }
  }

  const first = await decide(now())
  if (first instanceof Error) {
    logger.warn(`Failed to read next wake time: ${first.message}`)
    return 'stayed'
  }
  if (!first.shouldExit) {
    return 'stayed'
  }

  const syncResult = await syncWakeAt(first.soonestWakeAt)
  if (syncResult instanceof Error) {
    logger.warn(`Failed to sync next wake time before idle exit: ${syncResult.message}`)
    return 'stayed'
  }

  const second = await decide(now())
  if (second instanceof Error) {
    logger.warn(`Failed to re-read next wake time: ${second.message}`)
    return 'stayed'
  }
  if (!second.shouldExit) {
    return 'stayed'
  }

  logger.log(`Idle for ${idleMs}ms, exiting so Fly can stop this machine`)
  await exitProcess()
  return 'exited'
}

export function startScaleToZeroIdleExit({
  idleMs = parseScaleToZeroIdleMs(),
  sweepIntervalMs = DEFAULT_SCALE_TO_ZERO_SWEEP_MS,
  isTaskRunnerBusy = () => false,
  exitProcess = exitWithoutRestart,
}: {
  idleMs?: number
  sweepIntervalMs?: number
  isTaskRunnerBusy?: () => boolean
  exitProcess?: () => Promise<void>
} = {}): () => void {
  if (!isScaleToZeroEnabled()) {
    return () => {}
  }

  let stopped = false
  let sweeping = false
  const startedAtMs = Date.now()

  const sweep = async () => {
    if (stopped || sweeping) {
      return
    }
    sweeping = true
    const result = await attemptScaleToZeroExit({
      idleMs,
      startedAtMs,
      getIdleState: (nowMs) => areAllRuntimesIdleForScaleToZero({ idleMs, nowMs }),
      getSoonestWakeAt: getSoonestPlannedWakeAt,
      isTaskRunnerBusy,
      syncWakeAt: async (nextWakeAt) => {
        const { syncCloudNextWakeAt } = await import('./cloud-wake-sync.js')
        return syncCloudNextWakeAt({ nextWakeAt })
      },
      exitProcess,
    }).catch((cause) => {
      return new Error('Scale-to-zero sweep failed', { cause })
    })
    sweeping = false
    if (result instanceof Error) {
      logger.warn(result.message)
    }
  }

  const interval = setInterval(() => {
    void sweep()
  }, sweepIntervalMs)
  void sweep()
  logger.log(`Idle exit armed (idleMs=${idleMs}, intervalMs=${sweepIntervalMs})`)

  return () => {
    stopped = true
    clearInterval(interval)
  }
}

async function exitWithoutRestart(): Promise<void> {
  await flushAnalytics()
  process.exit(0)
}
